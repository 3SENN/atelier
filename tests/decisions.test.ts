/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import {
  DECISIONS_DEFAULTS,
  DECISIONS_SETTINGS_SCHEMA,
  DECISION_LIMITS,
  DECISION_PRESETS,
  DECISION_REQUEST_SCHEMA,
  PROVIDER_DEFAULTS,
  dialectOf,
  isPreset,
  type DecisionModelRef,
  type DecisionPresetId,
  stricter,
  sureChoice,
  sureLevel,
  yesNo,
  type DecisionAnswer,
  type DecisionsSettings,
} from '../src/shared/decisions'
import { claudeDecide } from '../src/main/decisions/claude'
import { DecisionError, listModels, endpointFor, endpointUrl, retryAfterMs, requestDecision, type FetchLike } from '../src/main/decisions/client'
import { DecisionKeys, type Sealer } from '../src/main/decisions/keys'
import { Decisions, RATE_LIMIT_PAUSE_MS, RULES_ONLY, decider, providerSaid, setDecider, type DecideCall } from '../src/main/decisions/service'
import { clickKind, needsYou, searchOrAsk, setupPicks } from '../src/main/decisions/uses'
import { smokeFetch } from '../src/main/decisions/feature'
import { conditionMet, lastReplyOf } from '../src/main/routines'

// Quick decisions (docs/decisions.md): the System One client, the decider's
// rule-first contract, compare mode, the Claude fallback, keys, Atelier's own
// questions, and routine conditions.

const sealer: Sealer = {
  available: () => true,
  seal: (t) => Buffer.from(t, 'utf8'),
  open: (d) => d.toString('utf8'),
}

type Reply = {
  status?: number
  body?: unknown
  delayMs?: number
  headers?: Record<string, string>
}

/** A fetch that answers each call with the next reply and records what was sent. */
function fakeFetch(replies: Reply[]): FetchLike & {
  calls: Array<{
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }>
} {
  const calls: Array<{
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }> = []
  const fn = (async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {}
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, reply.delayMs)
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
    }
    const status = reply.status ?? 200
    return {
      status,
      ok: status < 300,
      headers: {
        get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null,
      },
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body ?? ''),
    }
  }) as FetchLike & { calls: typeof calls }
  fn.calls = calls
  return fn
}

const endpoint0 = { url: 'https://api.typesafe.ai/v1/systemone', key: 'ts-key', model: 'jev-1.14.0' }
const noulReply = (key: string, p: number, model = 'jev-1.14.0'): Reply => ({
  body: {
    model,
    answers: { [key]: { type: 'noul', noul: p } },
    usage: { input_tokens: 42 },
  },
})
const choiceReply = (key: string, probabilities: Record<string, number>): Reply => {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]
  return {
    body: {
      model: 'jev-1.14.0',
      answers: {
        [key]: {
          type: 'choice',
          choice,
          confidence: probabilities[choice],
          probabilities,
        },
      },
    },
  }
}

/**
 * Settings for one provider and model, the way most tests think of it:
 * 'off', a preset (its suggested model unless one is given), or 'custom' (a
 * server of yours at `url`, kev-latest unless a model is given).
 */
type OneProvider = {
  provider?: 'off' | DecisionPresetId | 'custom'
  model?: string
  url?: string
  mode?: DecisionsSettings['mode']
  uses?: Partial<DecisionsSettings['uses']>
  models?: DecisionModelRef[]
}
function settingsWith(patch: OneProvider): DecisionsSettings {
  const base: DecisionsSettings = {
    ...DECISIONS_DEFAULTS,
    mode: patch.mode ?? 'use',
    uses: { ...DECISIONS_DEFAULTS.uses, ...patch.uses },
  }
  const provider = patch.provider ?? 'off'
  if (patch.models) return { ...base, on: true, models: patch.models }
  if (provider === 'off') return base
  if (provider === 'custom')
    return {
      ...base,
      on: true,
      servers: patch.url ? [{ id: 'server-1', name: 'My server', url: patch.url }] : [],
      models: [{ provider: 'server-1', model: patch.model || 'kev-latest' }],
    }
  return {
    ...base,
    on: true,
    models: [{ provider, model: patch.model || PROVIDER_DEFAULTS[provider].suggested }],
  }
}

let dir: string
/** The decider's clock in makeDecisions, moved by hand for the rate-limit pause. */
let clock = 0
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-decisions-'))
  clock = 1_000_000
})
afterEach(() => {
  setDecider(null)
  rmSync(dir, { recursive: true, force: true })
})

function makeDecisions(settings: DecisionsSettings, fetch: FetchLike, quick: Parameters<typeof claudeDecide>[0] | null = null, device?: { available(): boolean }): { d: Decisions; keys: DecisionKeys } {
  const keys = new DecisionKeys(dir, sealer)
  for (const m of settings.models) if (isPreset(m.provider) && PROVIDER_DEFAULTS[m.provider].keyUrl !== '' && !keys.has(m.provider)) keys.set(m.provider, 'ts-test-key')
  const d = new Decisions({
    dataDir: dir,
    settings: () => settings,
    keys,
    fetch,
    ...(device ? { device } : {}),
    now: () => clock,
    quick: () =>
      quick
        ? {
            ...quick,
            ready: async () => ({ ok: true, engine: 'api-key' as const }),
          }
        : null,
  })
  return { d, keys }
}

describe('shared answer readers', () => {
  it('reads a yes or no only when the model is clearly on one side', () => {
    const noul = (p: number): DecisionAnswer => ({ type: 'noul', noul: p })
    expect(yesNo(noul(0.9))).toBe(true)
    expect(yesNo(noul(0.1))).toBe(false)
    expect(yesNo(noul(0.5))).toBeNull()
    expect(yesNo(undefined)).toBeNull()
    expect(
      yesNo({
        type: 'choice',
        choice: 'a',
        confidence: 1,
        probabilities: { a: 1 },
      }),
    ).toBeNull()
  })

  it('takes a choice or a level only when it holds enough probability', () => {
    expect(
      sureChoice({
        type: 'choice',
        choice: 'a',
        confidence: 0.9,
        probabilities: { a: 0.9, b: 0.1 },
      }),
    ).toBe('a')
    expect(
      sureChoice({
        type: 'choice',
        choice: 'a',
        confidence: 0.2,
        probabilities: { a: 0.6, b: 0.4 },
      }),
    ).toBeNull()
    expect(
      sureLevel({
        type: 'score',
        score: 1.2,
        confidence: 0.7,
        probabilities: { 0: 0, 1: 0.8, 2: 0.2 },
      }),
    ).toBe(1)
    expect(
      sureLevel({
        type: 'score',
        score: 1,
        confidence: 0.1,
        probabilities: { 0: 0.4, 1: 0.2, 2: 0.4 },
      }),
    ).toBeNull()
  })

  it('raises every cutoff for Claude’s own estimates', () => {
    expect(stricter({ source: 'model' }, 0.8)).toBe(0.8)
    expect(stricter({ source: 'claude' }, 0.8)).toBeCloseTo(0.9)
    expect(stricter({ source: 'claude' }, 0.99)).toBe(0.97)
  })

  it('validates settings and requests', () => {
    expect(DECISIONS_SETTINGS_SCHEMA.safeParse(DECISIONS_DEFAULTS).success).toBe(true)
    expect(
      DECISIONS_SETTINGS_SCHEMA.safeParse({
        ...DECISIONS_DEFAULTS,
        url: 'file:///etc/passwd',
      }).success,
    ).toBe(false)
    expect(
      DECISION_REQUEST_SCHEMA.safeParse({
        state: 'x',
        questions: { ok: { type: 'noul', instructions: 'Is it?' } },
      }).success,
    ).toBe(true)
    expect(DECISION_REQUEST_SCHEMA.safeParse({ state: 'x', questions: {} }).success).toBe(false)
    expect(
      DECISION_REQUEST_SCHEMA.safeParse({
        state: 'x',
        questions: {
          c: {
            type: 'choice',
            instructions: 'Which?',
            criteria: { only: null },
          },
        },
      }).success,
    ).toBe(false)
    expect(
      DECISION_REQUEST_SCHEMA.safeParse({
        state: 'x',
        questions: {
          s: { type: 'score', instructions: 'How?', criteria: ['low', 'high'] },
        },
      }).success,
    ).toBe(true)
  })
})

describe('System One client', () => {
  const endpoint = {
    url: 'https://api.typesafe.ai/v1/systemone',
    key: 'ts-key',
    model: 'jev-1.14.0',
  }
  const request = {
    state: 'Hello',
    questions: { ok: { type: 'noul' as const, instructions: 'Is it fine?' } },
  }

  it('sends the pinned model, the state and the questions with the key, and reads typed answers', async () => {
    const fetch = fakeFetch([noulReply('ok', 0.8)])
    const result = await requestDecision(fetch, endpoint, request, {
      timeoutMs: 1_000,
    })
    expect(fetch.calls[0]!.url).toBe(endpoint.url)
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer ts-key')
    expect(fetch.calls[0]!.body).toEqual({
      model: 'jev-1.14.0',
      state: 'Hello',
      questions: request.questions,
    })
    expect(result).toMatchObject({
      source: 'model',
      model: 'jev-1.14.0',
      inputTokens: 42,
      answers: { ok: { type: 'noul', noul: 0.8 } },
    })
  })

  it('sends no authorization header without a key (a local server)', async () => {
    const fetch = fakeFetch([noulReply('ok', 0.8)])
    await requestDecision(fetch, { ...endpoint, key: null }, request, {
      timeoutMs: 1_000,
    })
    expect(fetch.calls[0]!.headers.authorization).toBeUndefined()
  })

  it('refuses a missing or mistyped answer', async () => {
    await expect(requestDecision(fakeFetch([{ body: { answers: {} } }]), endpoint, request, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'bad-reply' })
    await expect(requestDecision(fakeFetch([choiceReply('ok', { a: 1 })]), endpoint, request, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'bad-reply' })
  })

  it('maps statuses to error codes and retries a rate limit once', async () => {
    await expect(
      requestDecision(fakeFetch([{ status: 401 }]), endpoint, request, {
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      requestDecision(fakeFetch([{ status: 422 }]), endpoint, request, {
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'bad-request' })
    const retried = fakeFetch([{ status: 429 }, noulReply('ok', 0.9)])
    await expect(requestDecision(retried, endpoint, request, { timeoutMs: 5_000 })).resolves.toMatchObject({ answers: { ok: { noul: 0.9 } } })
    expect(retried.calls).toHaveLength(2)
  })

  it('gives up at its time limit', async () => {
    const err = await requestDecision(fakeFetch([{ ...noulReply('ok', 0.9), delayMs: 500 }]), endpoint, request, { timeoutMs: 20 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DecisionError)
    expect((err as DecisionError).code).toBe('timeout')
  })

  it('accepts a server root or its full endpoint, for the request its model takes', () => {
    expect(endpointUrl('http://127.0.0.1:8009/')).toBe('http://127.0.0.1:8009/v1/systemone')
    expect(endpointUrl('https://example.com/v1/systemone')).toBe('https://example.com/v1/systemone')
    expect(endpointUrl('https://example.com/v1/systemone', 'decisions')).toBe('https://example.com/v1/decisions')
    expect(endpointUrl('http://127.0.0.1:8009/v1/')).toBe('http://127.0.0.1:8009/v1/systemone')
    expect(endpointFor('https://api.experientiallabs.ai/v1/systemone', 'k', 'gpt-6-luna-decisions')).toEqual({
      url: 'https://api.experientiallabs.ai/v1/decisions',
      key: 'k',
      model: 'gpt-6-luna-decisions',
      dialect: 'decisions',
    })
    expect(endpointFor('https://api.experientiallabs.ai/v1/systemone', 'k', 'jev-latest')).toMatchObject({
      url: 'https://api.experientiallabs.ai/v1/systemone',
      dialect: 'systemone',
    })
    expect(endpointFor('https://api.openai.com/v1/decisions', 'k', 'gpt-6-luna')).toMatchObject({
      url: 'https://api.openai.com/v1/decisions',
      dialect: 'decisions',
    })
    expect(endpointFor('https://gateway.example/v1/decisions', null, 'any-model')).toMatchObject({ dialect: 'decisions' })
    expect(dialectOf('gpt-5.6-luna', '')).toBe('decisions')
    expect(dialectOf('kev-latest', 'http://127.0.0.1:8009')).toBe('systemone')
  })

  it('speaks OpenAI’s Decisions request and reads it back as System One’s answers', async () => {
    const luna = {
      url: 'https://api.openai.com/v1/decisions',
      key: 'sk',
      model: 'gpt-6-luna',
      dialect: 'decisions' as const,
    }
    const questions = {
      waits: {
        type: 'noul' as const,
        instructions: 'Is it blocked?',
        criteria: { true: 'Blocked.', false: 'Done.' },
      },
      kind: {
        type: 'choice' as const,
        instructions: 'Which?',
        criteria: { buy: 'Buys something.', none: null },
      },
      level: {
        type: 'score' as const,
        instructions: 'How hard?',
        criteria: ['Easy', 'Hard'],
      },
    }
    const fetch = fakeFetch([
      {
        body: {
          model: 'gpt-6-luna',
          answers: [
            { type: 'predicate', name: 'waits', probability: 0.82 },
            {
              type: 'choice',
              name: 'kind',
              choice: 'buy',
              confidence: 0.9,
              probabilities: [
                { value: 'buy', probability: 0.93 },
                { value: 'none', probability: 0.07 },
              ],
            },
            {
              type: 'score',
              name: 'level',
              score: 0.9,
              confidence: 0.8,
              probabilities: [
                { value: 0, label: 'Easy', probability: 0.1 },
                { value: 1, label: 'Hard', probability: 0.9 },
              ],
            },
          ],
          usage: { input_tokens: 380, output_tokens: 0 },
        },
      },
    ])
    const result = await requestDecision(fetch, luna, { state: { item: 'Order now' }, questions }, { timeoutMs: 1_000 })
    expect(fetch.calls[0]!.body).toEqual({
      model: 'gpt-6-luna',
      input: '{"item":"Order now"}',
      questions: [
        {
          type: 'predicate',
          name: 'waits',
          instructions: 'Is it blocked?\nYes means: Blocked.\nNo means: Done.',
        },
        {
          type: 'choice',
          name: 'kind',
          instructions: 'Which?',
          choices: [{ value: 'buy', description: 'Buys something.' }, { value: 'none' }],
        },
        {
          type: 'score',
          name: 'level',
          instructions: 'How hard?',
          levels: [{ label: 'Easy' }, { label: 'Hard' }],
        },
      ],
    })
    expect(result).toMatchObject({
      model: 'gpt-6-luna',
      inputTokens: 380,
      answers: {
        waits: { type: 'noul', noul: 0.82 },
        kind: {
          type: 'choice',
          choice: 'buy',
          confidence: 0.9,
          probabilities: { buy: 0.93, none: 0.07 },
        },
        level: { type: 'score', score: 0.9, probabilities: { 0: 0.1, 1: 0.9 } },
      },
    })
    // A refusal is an answer nobody is sure of, so the rule decides; an unnamed list is read in order.
    const refused = await requestDecision(
      fakeFetch([
        {
          body: {
            answers: [
              { type: 'refusal', name: null },
              { type: 'refusal' },
              {
                type: 'score',
                score: 0,
                confidence: 0.9,
                probabilities: [
                  { value: 0, probability: 0.95 },
                  { value: 1, probability: 0.05 },
                ],
              },
            ],
          },
        },
      ]),
      luna,
      { state: 'x', questions },
      { timeoutMs: 1_000 },
    )
    expect(yesNo(refused.answers.waits)).toBeNull()
    expect(sureChoice(refused.answers.kind)).toBeNull()
    expect(sureLevel(refused.answers.level)).toBe(0)
    // Levels are read by the labels Atelier sent, whatever numbering the server uses; an unknown label leaves the rule.
    const oneBased = await requestDecision(
      fakeFetch([
        {
          body: {
            answers: [
              { type: 'predicate', name: 'waits', probability: 0.5 },
              { type: 'refusal', name: 'kind' },
              {
                type: 'score',
                name: 'level',
                score: 1.9,
                confidence: 0.8,
                probabilities: [
                  { value: 1, label: 'Easy', probability: 0.1 },
                  { value: 2, label: 'Hard', probability: 0.9 },
                ],
              },
            ],
          },
        },
      ]),
      luna,
      { state: 'x', questions },
      { timeoutMs: 1_000 },
    )
    expect(oneBased.answers.level).toMatchObject({
      probabilities: { 0: 0.1, 1: 0.9 },
    })
    expect(sureLevel(oneBased.answers.level)).toBe(1)
    const unknown = await requestDecision(
      fakeFetch([
        {
          body: {
            answers: [
              { type: 'predicate', name: 'waits', probability: 0.5 },
              { type: 'refusal', name: 'kind' },
              {
                type: 'score',
                name: 'level',
                score: 1,
                confidence: 0.9,
                probabilities: [{ value: 1, label: 'Medium', probability: 0.95 }],
              },
            ],
          },
        },
      ]),
      luna,
      { state: 'x', questions },
      { timeoutMs: 1_000 },
    )
    expect(sureLevel(unknown.answers.level)).toBeNull()
    // A named answer never stands in for a question it doesn't name.
    const shifted = await requestDecision(
      fakeFetch([
        {
          body: {
            answers: [
              {
                type: 'choice',
                name: 'kind',
                choice: 'buy',
                confidence: 0.9,
                probabilities: [
                  { value: 'buy', probability: 0.95 },
                  { value: 'none', probability: 0.05 },
                ],
              },
            ],
          },
        },
      ]),
      luna,
      { state: 'x', questions },
      { timeoutMs: 1_000 },
    )
    expect(yesNo(shifted.answers.waits)).toBeNull()
    expect(sureChoice(shifted.answers.kind)).toBe('buy')
    // Its answers are held to the question's options like System One's.
    await expect(
      requestDecision(
        fakeFetch([
          {
            body: {
              answers: [
                { type: 'predicate', probability: 0.5 },
                {
                  type: 'choice',
                  choice: 'sell',
                  confidence: 0.9,
                  probabilities: [{ value: 'sell', probability: 0.9 }],
                },
                { type: 'refusal' },
              ],
            },
          },
        ]),
        luna,
        { state: 'x', questions },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: 'bad-reply' })
    await expect(requestDecision(fakeFetch([{ body: { answers: 'nope' } }]), luna, { state: 'x', questions }, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'bad-reply' })
  })

  it('refuses a choice it wasn’t offered and a level past the scale', async () => {
    const choice = {
      state: 'x',
      questions: {
        pick: {
          type: 'choice' as const,
          instructions: 'Which?',
          criteria: { a: null, b: null },
        },
      },
    }
    await expect(
      requestDecision(
        fakeFetch([
          {
            body: {
              answers: {
                pick: {
                  type: 'choice',
                  choice: 'navigate',
                  confidence: 0.9,
                  probabilities: { navigate: 0.9 },
                },
              },
            },
          },
        ]),
        endpoint,
        choice,
        { timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: 'bad-reply' })
    const scale = {
      state: 'x',
      questions: {
        level: {
          type: 'score' as const,
          instructions: 'How much?',
          criteria: ['low', 'high'],
        },
      },
    }
    await expect(
      requestDecision(
        fakeFetch([
          {
            body: {
              answers: {
                level: {
                  type: 'score',
                  score: 4,
                  confidence: 0.9,
                  probabilities: { 4: 0.9 },
                },
              },
            },
          },
        ]),
        endpoint,
        scale,
        { timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: 'bad-reply' })
    await expect(
      requestDecision(
        fakeFetch([
          {
            body: {
              answers: {
                level: {
                  type: 'score',
                  score: 0.8,
                  confidence: 0.9,
                  probabilities: { 0: 0.2, 1: 0.8 },
                },
              },
            },
          },
        ]),
        endpoint,
        scale,
        { timeoutMs: 1_000 },
      ),
    ).resolves.toMatchObject({ answers: { level: { score: 0.8 } } })
  })

  it('passes on a rate limit’s Retry-After', async () => {
    const err = (await requestDecision(fakeFetch([{ status: 429, headers: { 'retry-after': '30' } }]), endpoint, request, { timeoutMs: 100 }).catch((e: unknown) => e)) as DecisionError
    expect(err.code).toBe('rate-limited')
    expect(err.retryAfterMs).toBe(30_000)
    expect(retryAfterMs('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60_000)
    expect(retryAfterMs('soon')).toBeNull()
  })

  it('lists a provider’s decision models, with their prices and data policy where it says', async () => {
    const where = {
      url: 'https://api.experientiallabs.ai/v1/models',
      key: 'ts-key',
    }
    const fetch = fakeFetch([
      {
        body: {
          object: 'list',
          data: [
            { id: 'gpt-6-luna' },
            {
              id: 'clef-flash',
              pricing: { input_nano_usd_per_million_tokens: 90_000_000 },
              data_policy: { zdr: true },
            },
            {
              id: 'jev-latest',
              pricing: { input_nano_usd_per_million_tokens: 42_000_000 },
              data_policy: { zdr: false },
            },
            { id: 'gpt-6-luna-decisions' },
            { id: 'typesafe/jev-1.14' },
            { id: 'kevlar' },
            {
              id: 'liquid/d1',
              architecture: { output_modalities: ['decisions'] },
            },
          ],
        },
      },
    ])
    await expect(listModels(fetch, where, { timeoutMs: 1_000 })).resolves.toEqual([
      { id: 'clef-flash', price: 0.09, zdr: true },
      { id: 'gpt-6-luna-decisions', price: null, zdr: null },
      { id: 'jev-latest', price: 0.042, zdr: false },
      { id: 'liquid/d1', price: null, zdr: null },
      { id: 'typesafe/jev-1.14', price: null, zdr: null },
    ])
    expect(fetch.calls[0]).toMatchObject({
      url: 'https://api.experientiallabs.ai/v1/models',
      headers: { authorization: 'Bearer ts-key' },
    })
    // OpenRouter's list holds decision models only, priced per token; ":free" ones cost nothing.
    const router = fakeFetch([
      {
        body: {
          data: [
            {
              id: 'cloudflare/clef-flash',
              pricing: { prompt: '0.000000038', completion: '0' },
            },
            {
              id: 'parallel/decisions-fast:free',
              pricing: { prompt: '0', completion: '0' },
            },
            { id: 'typesafe/jev-router', pricing: { prompt: '-1' } },
          ],
        },
      },
    ])
    await expect(
      listModels(
        router,
        {
          url: 'https://openrouter.ai/api/v1/models?output_modalities=decisions',
          key: null,
          decisionsOnly: true,
        },
        { timeoutMs: 1_000 },
      ),
    ).resolves.toEqual([
      { id: 'cloudflare/clef-flash', price: 0.038, zdr: null },
      { id: 'parallel/decisions-fast:free', price: 0, zdr: null },
      { id: 'typesafe/jev-router', price: null, zdr: null },
    ])
    // No price, an empty one or a negative one is no price, never "Free".
    const unpriced = fakeFetch([{ body: { data: [{ id: 'a/x', pricing: { prompt: null } }, { id: 'b/y', pricing: { prompt: '' } }, { id: 'c/z', pricing: { input_nano_usd_per_million_tokens: -1 } }] } }])
    expect((await listModels(unpriced, { url: 'https://x.example/models', key: null, decisionsOnly: true }, { timeoutMs: 1_000 }))?.map((m) => m.price)).toEqual([null, null, null])
    await expect(listModels(fakeFetch([{ status: 404 }]), where, { timeoutMs: 1_000 })).resolves.toBeNull()
    await expect(listModels(fakeFetch([{ body: 'nope' }]), where, { timeoutMs: 1_000 })).resolves.toBeNull()
  })

  it('reads a refusal as an answer nobody is sure of, so the rule decides', async () => {
    const choice = {
      state: 'x',
      questions: {
        pick: {
          type: 'choice' as const,
          instructions: 'Which?',
          criteria: { a: null, b: null },
        },
        ok: { type: 'noul' as const, instructions: 'Is it?' },
      },
    }
    const result = await requestDecision(
      fakeFetch([
        {
          body: {
            answers: { pick: { type: 'refusal' }, ok: { type: 'refusal' } },
          },
        },
      ]),
      endpoint,
      choice,
      { timeoutMs: 1_000 },
    )
    expect(sureChoice(result.answers.pick)).toBeNull()
    expect(yesNo(result.answers.ok)).toBeNull()
  })
})

describe('the decider', () => {
  const call = (rule: boolean, extra: Partial<DecideCall<boolean>> = {}): DecideCall<boolean> => ({
    use: 'needsYou',
    rule,
    request: () => ({
      state: 'Want me to do anything else?',
      questions: { waits: { type: 'noul', instructions: 'Does it wait?' } },
    }),
    read: (r) => yesNo(r.answers.waits),
    excerpt: 'Want me to do anything else? sk-ant-api03-secretsecretsecret',
    ...extra,
  })

  it('is the rule alone until the feature starts, and with the provider off', async () => {
    expect(decider()).toBe(RULES_ONLY)
    await expect(decider().decide(call(true))).resolves.toBe(true)
    const fetch = fakeFetch([noulReply('waits', 0.05)])
    const { d } = makeDecisions(settingsWith({ provider: 'off' }), fetch)
    await expect(d.decide(call(true))).resolves.toBe(true)
    expect(fetch.calls).toHaveLength(0)
    expect(d.ready()).toBe(false)
  })

  it('needs a key for hosted providers and an address for your own server', () => {
    const fetch = fakeFetch([])
    const keys = new DecisionKeys(dir, sealer)
    const hosted = new Decisions({
      dataDir: dir,
      settings: () => settingsWith({ provider: 'typesafe' }),
      keys,
      fetch,
      quick: () => null,
    })
    expect(hosted.ready()).toBe(false)
    keys.set('typesafe', 'k')
    expect(hosted.ready()).toBe(true)
    const own = new Decisions({
      dataDir: dir,
      settings: () => settingsWith({ provider: 'custom', url: '' }),
      keys,
      fetch,
      quick: () => null,
    })
    expect(own.ready()).toBe(false)
    const ownSet = new Decisions({
      dataDir: dir,
      settings: () => settingsWith({ provider: 'custom', url: 'http://127.0.0.1:8009' }),
      keys,
      fetch,
      quick: () => null,
    })
    expect(ownSet.ready()).toBe(true)
  })

  it('takes every listed provider from the same table, with its own key, address and request', async () => {
    expect(DECISION_PRESETS).toEqual(['device', 'typesafe', 'openrouter', 'experiential', 'openai'])
    for (const provider of DECISION_PRESETS.filter((p) => PROVIDER_DEFAULTS[p].keyUrl !== '')) {
      const model = PROVIDER_DEFAULTS[provider].suggested
      const reply: Reply =
        provider === 'openai'
          ? {
              body: {
                model,
                answers: [{ type: 'predicate', name: 'waits', probability: 0.05 }],
              },
            }
          : noulReply('waits', 0.05, model)
      const fetch = fakeFetch([reply])
      const { d } = makeDecisions(settingsWith({ provider }), fetch)
      expect(d.status().keys[provider]).toBe(true)
      await expect(d.decide(call(true))).resolves.toBe(false)
      expect(fetch.calls[0]).toMatchObject({
        url: PROVIDER_DEFAULTS[provider].url,
        headers: { authorization: 'Bearer ts-test-key' },
        body: { model },
      })
    }
    const gateway = fakeFetch([
      {
        body: {
          model: 'gpt-6-luna-decisions',
          answers: [{ type: 'predicate', name: 'waits', probability: 0.05 }],
        },
      },
    ])
    await expect(
      makeDecisions(
        settingsWith({
          provider: 'experiential',
          model: 'gpt-6-luna-decisions',
        }),
        gateway,
      ).d.decide(call(true)),
    ).resolves.toBe(false)
    expect(gateway.calls[0]).toMatchObject({
      url: 'https://api.experientiallabs.ai/v1/decisions',
      body: { model: 'gpt-6-luna-decisions', input: expect.any(String) },
    })
    const own = fakeFetch([noulReply('waits', 0.05, 'clef')])
    await makeDecisions(
      settingsWith({
        provider: 'custom',
        url: 'https://gateway.example',
        model: 'clef',
      }),
      own,
    ).d.decide(call(true))
    expect(own.calls[0]).toMatchObject({
      url: 'https://gateway.example/v1/systemone',
      body: { model: 'clef' },
    })
    expect(own.calls[0]!.headers.authorization).toBeUndefined()
  })

  it('lets the rules decide for a while after a rate limit, then tries again', async () => {
    const fetch = fakeFetch([{ status: 429 }, { status: 429 }, noulReply('waits', 0.05)])
    const { d } = makeDecisions(settingsWith({ provider: 'experiential' }), fetch)
    await expect(d.decide(call(true, { timeoutMs: 5_000 }))).resolves.toBe(true)
    expect(fetch.calls).toHaveLength(2)
    expect(d.status().models[0]).toMatchObject({
      lastError: 'rate-limited',
      pausedUntil: clock + RATE_LIMIT_PAUSE_MS,
    })
    expect(d.paused()).toBe(true)
    await expect(d.decide(call(true))).resolves.toBe(true)
    expect(fetch.calls).toHaveLength(2)
    clock += RATE_LIMIT_PAUSE_MS
    await expect(d.decide(call(true))).resolves.toBe(false)
    expect(fetch.calls).toHaveLength(3)
    expect(d.status().models[0]).toMatchObject({
      lastError: null,
      pausedUntil: null,
    })
  })

  it('asks again when an answer someone waits on is slow, and takes the first answer', async () => {
    const fetch = fakeFetch([{ ...noulReply('waits', 0.9), delayMs: 1_000 }, noulReply('waits', 0.05)])
    const { d } = makeDecisions(settingsWith({ provider: 'experiential' }), fetch)
    const started = Date.now()
    await expect(d.decide(call(true))).resolves.toBe(false)
    expect(fetch.calls).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(900)
    // A batch use (tabs, labeling, memory, routines, packs) and a quick answer send one request.
    const once = fakeFetch([{ ...noulReply('waits', 0.05), delayMs: 400 }])
    await expect(makeDecisions(settingsWith({ provider: 'experiential' }), once).d.decide(call(true, { use: 'tabs' }))).resolves.toBe(false)
    expect(once.calls).toHaveLength(1)
    const quick = fakeFetch([noulReply('waits', 0.05)])
    await makeDecisions(settingsWith({ provider: 'experiential' }), quick).d.decide(call(true))
    expect(quick.calls).toHaveLength(1)
  })

  it('sends no second request after a rate limit this session, nor to a server on this computer; a failure before it is final', async () => {
    const fetch = fakeFetch([{ status: 429 }, { status: 429 }, { ...noulReply('waits', 0.05), delayMs: 600 }])
    const { d } = makeDecisions(settingsWith({ provider: 'experiential' }), fetch)
    await expect(d.decide(call(true, { timeoutMs: 5_000 }))).resolves.toBe(true)
    clock += RATE_LIMIT_PAUSE_MS
    await expect(d.decide(call(true))).resolves.toBe(false)
    expect(fetch.calls).toHaveLength(3)
    const failing = fakeFetch([{ status: 401 }, noulReply('waits', 0.05)])
    await expect(makeDecisions(settingsWith({ provider: 'experiential' }), failing).d.decide(call(true))).resolves.toBe(true)
    expect(failing.calls).toHaveLength(1)
    // A rate limit on the second request alone neither pauses decisions nor wins over the first's answer.
    const second = fakeFetch([{ ...noulReply('waits', 0.05), delayMs: 600 }, { status: 429 }])
    const { d: d2 } = makeDecisions(settingsWith({ provider: 'experiential' }), second)
    await expect(d2.decide(call(true))).resolves.toBe(false)
    expect(d2.status().models[0]!.pausedUntil).toBeNull()
    // The request that met the limit stops there: no retry beside the first.
    expect(second.calls).toHaveLength(2)
    const local = fakeFetch([{ ...noulReply('waits', 0.05), delayMs: 600 }])
    await expect(makeDecisions(settingsWith({ provider: 'custom', url: 'http://127.0.0.1:8009' }), local).d.decide(call(true))).resolves.toBe(false)
    expect(local.calls).toHaveLength(1)
  })

  it('keeps what the provider said about its limit for Settings, without secrets', async () => {
    const body = {
      error: {
        message: 'class_rate_limit: Free core funding is unavailable for this request. Enable Keep going on credits to continue, or wait for free capacity.',
        type: 'rate_limit_error',
      },
    }
    const fetch = fakeFetch([{ status: 429, body }])
    const { d } = makeDecisions(settingsWith({ provider: 'experiential' }), fetch)
    await d.decide(call(true, { timeoutMs: 100 }))
    expect(d.status().models[0]!.pausedReason).toBe('Free core funding is unavailable for this request. Enable Keep going on credits to continue, or wait for free capacity.')
    clock += RATE_LIMIT_PAUSE_MS
    expect(d.status().models[0]!.pausedReason).toBeNull()
    expect(providerSaid('The decision model answered 429: {"error":{"message":"Slow down, key sk-ant-api03-secretsecretsecretsecret is limited","type":"x"')).not.toMatch(/secretsecret/)
    expect(providerSaid('The decision model answered 429')).toBeNull()
    expect(providerSaid('The decision model answered 429: Too many requests')).toBe('Too many requests')
  })

  it('offers the decision models a provider lists, and those its preset names', async () => {
    const fetch = fakeFetch([
      {
        body: {
          data: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6-luna' }, { id: 'babbage' }],
        },
      },
    ])
    await expect(makeDecisions(settingsWith({ provider: 'openai' }), fetch).d.catalog()).resolves.toEqual([
      {
        provider: 'openai',
        models: [{ id: 'gpt-6-luna', price: null, zdr: null }],
        failed: false,
      },
    ])
    expect(fetch.calls[0]!.url).toBe('https://api.openai.com/v1/models')
  })

  it('reuses a verdict for the same key, but never in compare mode and not across models', async () => {
    const fetch = fakeFetch([noulReply('waits', 0.05)])
    let settings = settingsWith({ provider: 'experiential' })
    const keys = new DecisionKeys(dir, sealer)
    keys.set('experiential', 'k')
    const d = new Decisions({
      dataDir: dir,
      settings: () => settings,
      keys,
      fetch,
      now: () => clock,
      quick: () => null,
    })
    const kept = (extra: Partial<DecideCall<boolean>> = {}): DecideCall<boolean> => call(true, { reuse: { key: 'same text', ttlMs: 60_000 }, ...extra })
    await expect(d.decide(kept())).resolves.toBe(false)
    await expect(d.decide(kept())).resolves.toBe(false)
    expect(fetch.calls).toHaveLength(1)
    settings = { ...settings, mode: 'compare' }
    await expect(d.decide(kept())).resolves.toBe(true)
    expect(fetch.calls).toHaveLength(1)
    settings = {
      ...settings,
      mode: 'use',
      models: [{ provider: 'experiential', model: 'clef' }],
    }
    await expect(d.decide(kept())).resolves.toBe(false)
    expect(fetch.calls).toHaveLength(2)
    clock += 60_000
    await d.decide(kept({ reuse: { key: 'same text', ttlMs: 60_000 } }))
    expect(fetch.calls).toHaveLength(3)
  })

  it('keeps a rate-limit pause when a request already on its way succeeds, and lifts it after a passing Test', async () => {
    const fetch = fakeFetch([{ ...noulReply('ok', 0.9), delayMs: 150 }, { status: 429 }, noulReply('ok', 0.9)])
    const { d } = makeDecisions(settingsWith({ provider: 'experiential' }), fetch)
    const q = { state: 'x', questions: { ok: { type: 'noul' as const, instructions: 'ok?' } } }
    const onItsWay = d.model('labeling', q, { timeoutMs: 1_000 })
    await d.decide(call(true, { use: 'tabs', timeoutMs: 100 }))
    expect(d.paused()).toBe(true)
    await expect(onItsWay).resolves.toMatchObject({ answers: { ok: { noul: 0.9 } } })
    expect(d.paused()).toBe(true)
    await expect(d.model('labeling', q)).rejects.toMatchObject({ code: 'rate-limited' })
    await expect(d.test()).resolves.toMatchObject({ ok: true })
    expect(d.paused()).toBe(false)
  })

  it('sets a model aside for a few seconds even when its Retry-After says 0', async () => {
    const fetch = fakeFetch([{ status: 429, headers: { 'retry-after': '0' } }])
    const { d } = makeDecisions(settingsWith({ provider: 'experiential' }), fetch)
    await d.decide(call(true, { timeoutMs: 100 }))
    expect(d.status().models[0]!.pausedUntil).toBe(clock + 5_000)
  })

  it('sends nothing for a decision stopped before it was sent', async () => {
    const fetch = fakeFetch([noulReply('ok', 0.9)])
    const stop = new AbortController()
    stop.abort()
    await expect(requestDecision(fetch, endpoint0, { state: 'x', questions: { ok: { type: 'noul', instructions: 'ok?' } } }, { timeoutMs: 1_000, signal: stop.signal })).rejects.toMatchObject({ code: 'timeout' })
    expect(fetch.calls).toHaveLength(0)
  })

  it('answers on this computer with the on-device model: no key, its own address, one request, and the rule without its files', async () => {
    const installed = { available: () => true }
    const local = fakeFetch([{ ...noulReply('waits', 0.05, 'atelier-nano'), delayMs: 400 }])
    const { d } = makeDecisions(settingsWith({ provider: 'device' }), local, null, installed)
    expect(d.status().keys.device).toBe(false)
    expect(d.status().connected.device).toBe(true)
    await expect(d.decide(call(true))).resolves.toBe(false)
    // Never hedged (a second request would only queue behind the first), never with a key.
    expect(local.calls).toHaveLength(1)
    expect(local.calls[0]!.url).toBe('atelier-device://nano/v1/systemone')
    expect(local.calls[0]!.headers.authorization).toBeUndefined()
    // Its files gone: not connected, nothing sent, the rule decides.
    const none = fakeFetch([noulReply('waits', 0.05)])
    const missing = makeDecisions(settingsWith({ provider: 'device' }), none, null, { available: () => false }).d
    expect(missing.status().connected.device).toBe(false)
    await expect(missing.decide(call(true))).resolves.toBe(true)
    expect(none.calls).toHaveLength(0)
  })

  it('never sends a second request to a server on this computer, however it is named', async () => {
    for (const url of ['http://0.0.0.0:8009', 'http://localhost.:8009', 'http://kev.localhost:8009', 'http://[::1]:8009']) {
      const local = fakeFetch([{ ...noulReply('waits', 0.05), delayMs: 400 }])
      await makeDecisions(settingsWith({ provider: 'custom', url }), local).d.decide(call(true))
      expect(local.calls, url).toHaveLength(1)
    }
  })

  it('forgets every key on a reset, and the keys of servers that are gone', () => {
    const keys = new DecisionKeys(dir, sealer)
    keys.set('openrouter', 'sk-or')
    keys.set('server-abc', 'a')
    keys.set('server-def', 'b')
    keys.retainServers(new Set(['server-def']))
    expect([keys.get('openrouter'), keys.get('server-abc'), keys.get('server-def')]).toEqual(['sk-or', null, 'b'])
    keys.clear()
    expect([keys.get('openrouter'), new DecisionKeys(dir, sealer).get('server-def')]).toEqual([null, null])
  })

  it('offers what every connected provider lists, each from its own list, and nothing without one', async () => {
    const fetch = fakeFetch([{ body: { data: [{ id: 'clef-flash' }, { id: 'aion-3.0' }] } }])
    await expect(makeDecisions(settingsWith({ provider: 'experiential' }), fetch).d.catalog()).resolves.toEqual([
      {
        provider: 'experiential',
        models: [{ id: 'clef-flash', price: null, zdr: null }],
        failed: false,
      },
    ])
    expect(fetch.calls[0]!.url).toBe('https://api.experientiallabs.ai/v1/models')
    const off = makeDecisions(settingsWith({ provider: 'off' }), fetch)
    off.keys.set('experiential', null)
    await expect(off.d.catalog()).resolves.toEqual([])
    // Two providers and a server of yours at once: OpenRouter's decisions-only list, and the server's next to its endpoint.
    const many = fakeFetch([
      {
        body: {
          data: [{ id: 'typesafe/jev-1.14' }, { id: 'cloudflare/clef' }],
        },
      },
    ])
    const settings = {
      ...settingsWith({
        models: [
          { provider: 'openrouter', model: 'typesafe/jev-1.14' },
          { provider: 'server-1', model: 'kev-latest' },
        ],
      }),
      servers: [{ id: 'server-1' as const, name: 'Kev', url: 'http://127.0.0.1:8009' }],
    }
    const lists = await makeDecisions(settings, many).d.catalog()
    expect(lists.map((l) => [l.provider, l.models.map((m) => m.id)])).toEqual([
      ['openrouter', ['cloudflare/clef', 'typesafe/jev-1.14']],
      ['server-1', ['cloudflare/clef', 'typesafe/jev-1.14']],
    ])
    expect(many.calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/models?output_modalities=decisions', 'http://127.0.0.1:8009/v1/models'])
  })

  it('tries your models in order: one that fails, is busy or is paused hands over to the next', async () => {
    const settings = settingsWith({
      models: [
        { provider: 'experiential', model: 'clef-flash' },
        { provider: 'openrouter', model: 'typesafe/jev-1.14' },
      ],
    })
    const fetch = fakeFetch([{ status: 503 }, noulReply('waits', 0.05, 'typesafe/jev-1.14')])
    const { d } = makeDecisions(settings, fetch)
    await expect(d.decide(call(true))).resolves.toBe(false)
    expect(fetch.calls.map((c) => [c.url, c.body.model])).toEqual([
      ['https://api.experientiallabs.ai/v1/systemone', 'clef-flash'],
      ['https://openrouter.ai/api/alpha/decisions', 'typesafe/jev-1.14'],
    ])
    expect(d.status().models.map((m) => [m.model, m.lastError, m.lastModel])).toEqual([
      ['clef-flash', 'overloaded', null],
      ['typesafe/jev-1.14', null, 'typesafe/jev-1.14'],
    ])
    // A rate limit sets that model aside for a while: the next answers straight away, and with every one paused the rule decides.
    const limited = fakeFetch([{ status: 429 }, { status: 429 }, noulReply('waits', 0.05), noulReply('waits', 0.05)])
    const two = makeDecisions(settings, limited).d
    await expect(two.decide(call(true, { timeoutMs: 5_000 }))).resolves.toBe(false)
    await expect(two.decide(call(true))).resolves.toBe(false)
    expect(limited.calls.map((c) => c.body.model)).toEqual(['clef-flash', 'clef-flash', 'typesafe/jev-1.14', 'typesafe/jev-1.14'])
    expect(two.paused()).toBe(false)
    // A timeout leaves no time for another: the rule decides.
    const slow = fakeFetch([{ ...noulReply('waits', 0.05), delayMs: 300 }, noulReply('waits', 0.05)])
    await expect(makeDecisions(settings, slow).d.decide(call(true, { use: 'tabs', timeoutMs: 100 }))).resolves.toBe(true)
    expect(slow.calls).toHaveLength(1)
  })

  it('asks nothing with the switch off, keeping your models; tests one model on request', async () => {
    const settings = settingsWith({
      models: [
        { provider: 'experiential', model: 'clef-flash' },
        { provider: 'openrouter', model: 'liquid/d1' },
      ],
    })
    const fetch = fakeFetch([noulReply('ok', 0.9, 'liquid/d1')])
    const { d } = makeDecisions({ ...settings, on: false }, fetch)
    expect(d.active('needsYou')).toBe(false)
    await expect(d.decide(call(true))).resolves.toBe(true)
    expect(d.status()).toMatchObject({
      on: false,
      ready: false,
      connected: { experiential: true, openrouter: true, typesafe: false },
    })
    expect(d.status().models.map((m) => m.model)).toEqual(['clef-flash', 'liquid/d1'])
    await expect(d.test({ provider: 'openrouter', model: 'liquid/d1' })).resolves.toMatchObject({
      ok: true,
      provider: 'openrouter',
      model: 'liquid/d1',
      answered: 'liquid/d1',
    })
    expect(fetch.calls[0]).toMatchObject({
      url: 'https://openrouter.ai/api/alpha/decisions',
      body: { model: 'liquid/d1' },
    })
    await expect(d.test({ provider: 'typesafe', model: 'jev-1.14.0' })).resolves.toMatchObject({ ok: false, error: 'no-key' })
    expect(d.ready()).toBe(false)
  })

  it('keeps a key for each provider and server of yours, and refuses an unknown one', () => {
    const keys = new DecisionKeys(dir, sealer)
    keys.set('openrouter', 'sk-or-1')
    keys.set('server-2', 'local-key')
    expect([keys.get('openrouter'), keys.get('server-2')]).toEqual(['sk-or-1', 'local-key'])
    expect(() => keys.set('evil', 'x')).toThrow()
    expect(new DecisionKeys(dir, sealer).get('server-2')).toBe('local-key')
  })

  it('uses a sure answer, keeps the rule when unsure, and notes the difference with secrets removed', async () => {
    const fetch = fakeFetch([noulReply('waits', 0.05), noulReply('waits', 0.5)])
    const { d } = makeDecisions(settingsWith({ provider: 'typesafe' }), fetch)
    await expect(d.decide(call(true))).resolves.toBe(false)
    await expect(d.decide(call(true))).resolves.toBe(true)
    expect(d.status()).toMatchObject({
      answered: 2,
      differed: 1,
      models: [{ lastModel: 'jev-1.14.0', lastError: null }],
    })
    const [row] = d.comparisons()
    expect(row).toMatchObject({
      use: 'needsYou',
      rule: 'true',
      model: 'false',
      applied: true,
      version: 'jev-1.14.0',
      confidence: 0.95,
    })
    expect(row!.excerpt).not.toContain('secretsecret')
  })

  it('keeps the rule when the use is switched off, in private windows, and when the model fails', async () => {
    const fetch = fakeFetch([{ status: 500 }])
    const off = makeDecisions(
      settingsWith({
        provider: 'typesafe',
        uses: { ...DECISIONS_DEFAULTS.uses, needsYou: false },
      }),
      fetch,
    ).d
    await expect(off.decide(call(true))).resolves.toBe(true)
    const on = makeDecisions(settingsWith({ provider: 'typesafe' }), fetch).d
    await expect(on.decide(call(true, { private: true }))).resolves.toBe(true)
    expect(fetch.calls).toHaveLength(0)
    await expect(on.decide(call(true))).resolves.toBe(true)
    expect(on.status().models[0]!.lastError).toBe('failed')
  })

  it('in compare mode always answers with the rule and only notes what the model would have done', async () => {
    const fetch = fakeFetch([noulReply('waits', 0.02)])
    const { d } = makeDecisions(settingsWith({ provider: 'typesafe', mode: 'compare' }), fetch)
    await expect(d.decide(call(true))).resolves.toBe(true)
    await vi.waitFor(() => expect(d.comparisons()).toHaveLength(1))
    expect(d.comparisons()[0]).toMatchObject({
      applied: false,
      model: 'false',
    })
  })

  it('runs alongside a slow rule and may keep parts of it', async () => {
    const fetch = fakeFetch([noulReply('a', 0.9)])
    const { d } = makeDecisions(settingsWith({ provider: 'typesafe' }), fetch)
    const result = await d.decide<{ a: boolean; b: string }>({
      use: 'setup',
      rule: new Promise((resolve) => setTimeout(() => resolve({ a: false, b: 'from claude' }), 10)),
      request: () => ({
        state: 's',
        questions: { a: { type: 'noul', instructions: 'A?' } },
      }),
      read: (r, rule) => ({ ...rule, a: yesNo(r.answers.a) ?? rule.a }),
    })
    expect(result).toEqual({ a: true, b: 'from claude' })
  })

  it('keeps comparisons across restarts and clears them', async () => {
    const fetch = fakeFetch([noulReply('waits', 0.05)])
    const { d, keys } = makeDecisions(settingsWith({ provider: 'typesafe' }), fetch)
    await d.decide(call(true))
    const again = new Decisions({
      dataDir: dir,
      settings: () => settingsWith({ provider: 'typesafe' }),
      keys,
      fetch,
      quick: () => null,
    })
    expect(again.comparisons()).toHaveLength(1)
    again.clearComparisons()
    expect(again.comparisons()).toHaveLength(0)
    expect(again.comparisonsBytes()).toBe(0)
  })

  it('tests the connection without counting it as a decision', async () => {
    const { d } = makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([noulReply('ok', 0.9, 'jev-1.14.0')]))
    await expect(d.test()).resolves.toMatchObject({
      ok: true,
      model: 'jev-1.14.0',
    })
    const bad = makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([{ status: 401 }])).d
    await expect(bad.test()).resolves.toMatchObject({
      ok: false,
      error: 'unauthorized',
    })
    const unset = makeDecisions(settingsWith({ provider: 'custom' }), fakeFetch([])).d
    await expect(unset.test()).resolves.toMatchObject({
      ok: false,
      error: 'no-key',
    })
  })
})

describe('routines and packs (ask)', () => {
  const request = {
    state: 'The price is now €180.',
    questions: {
      met: { type: 'noul' as const, instructions: 'Is the price under €200?' },
    },
  }

  it('asks the decision model when one is on', async () => {
    const { d } = makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([noulReply('met', 0.97)]))
    await expect(d.ask('routine', request)).resolves.toMatchObject({
      source: 'model',
      answers: { met: { noul: 0.97 } },
    })
  })

  it('falls back to the Claude engine when no decision model is on or it fails', async () => {
    const json = vi.fn(async () => ({ met: { yes: 0.8 } }))
    const off = makeDecisions(settingsWith({ provider: 'off' }), fakeFetch([]), { json } as never).d
    await expect(off.ask('routine', request)).resolves.toMatchObject({
      source: 'claude',
      answers: { met: { type: 'noul', noul: 0.8 } },
    })
    const failing = makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([{ status: 500 }]), { json } as never).d
    await expect(failing.ask('pack', request)).resolves.toMatchObject({
      source: 'claude',
    })
    const limited = fakeFetch([{ status: 429 }])
    const paused = makeDecisions(settingsWith({ provider: 'typesafe' }), limited, { json } as never).d
    await expect(paused.ask('routine', request, { timeoutMs: 100 })).resolves.toMatchObject({ source: 'claude' })
    await expect(paused.ask('routine', request)).resolves.toMatchObject({
      source: 'claude',
    })
    expect(limited.calls).toHaveLength(1)
    expect(json).toHaveBeenCalledTimes(4)
  })

  it('charges the Claude engine’s budget only when Claude answers, and stops when it can’t pay', async () => {
    const json = vi.fn(async () => ({ met: { yes: 0.8 } }))
    const beforeClaude = vi.fn()
    await makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([noulReply('met', 0.97)]), { json } as never).d.ask('pack', request, { beforeClaude })
    expect(beforeClaude).not.toHaveBeenCalled()
    await makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([{ status: 500 }]), { json } as never).d.ask('pack', request, { beforeClaude })
    expect(beforeClaude).toHaveBeenCalledTimes(1)
    const broke = () => {
      throw new Error('A pack can use the model 60 times an hour.')
    }
    await expect(makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([{ status: 500 }]), { json } as never).d.ask('pack', request, { beforeClaude: broke })).rejects.toThrow(/60 times/)
    expect(json).toHaveBeenCalledTimes(1)
  })

  it('holds a pack’s state to the size limit on Claude too', async () => {
    const json = vi.fn(async () => ({ met: { yes: 0.8 } }))
    await claudeDecide(
      { json } as never,
      {
        state: { rows: Array.from({ length: 20_000 }, (_, i) => `row ${i}`) },
        questions: request.questions,
      },
      { kind: 'pack' },
    )
    const prompt = (json.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt
    expect(prompt.length).toBeLessThan(DECISION_LIMITS.stateChars + 1_000)
  })

  it('fails plainly with no engine at all', async () => {
    const { d } = makeDecisions(settingsWith({ provider: 'off' }), fakeFetch([]))
    await expect(d.ask('routine', request)).rejects.toThrow(/No engine/)
  })

  it('shapes Claude’s answers like a decision model’s', async () => {
    const json = vi.fn(async () => ({
      c: { choice: 'b', confidence: 0.7 },
      s: { level: 2, confidence: 0.6 },
    }))
    const result = await claudeDecide(
      { json } as never,
      {
        state: 'x',
        questions: {
          c: {
            type: 'choice',
            instructions: 'Which?',
            criteria: { a: null, b: null, c: null },
          },
          s: { type: 'score', instructions: 'How?', criteria: ['l', 'm', 'h'] },
        },
      },
      { kind: 'pack' },
    )
    expect(result.source).toBe('claude')
    expect(result.answers.c).toMatchObject({
      type: 'choice',
      choice: 'b',
      probabilities: { a: 0.15, b: 0.7, c: 0.15 },
    })
    expect(result.answers.s).toMatchObject({
      type: 'score',
      score: 2,
      probabilities: { 0: 0.2, 1: 0.2, 2: 0.6 },
    })
  })
})

describe('keys', () => {
  it('keeps one key per provider in one sealed file and forgets them', () => {
    const keys = new DecisionKeys(dir, sealer)
    keys.set('typesafe', ' ts ')
    keys.set('server-1', 'local')
    const reread = new DecisionKeys(dir, sealer)
    expect(reread.get('typesafe')).toBe('ts')
    expect(reread.has('server-1')).toBe(true)
    expect(reread.has('openrouter')).toBe(false)
    reread.set('experiential', 'xpl')
    expect(new DecisionKeys(dir, sealer).get('experiential')).toBe('xpl')
    reread.set('typesafe', null)
    reread.set('server-1', '')
    reread.set('experiential', null)
    expect(new DecisionKeys(dir, sealer).has('typesafe')).toBe(false)
  })

  it('refuses to save without secure storage', () => {
    const keys = new DecisionKeys(dir, { ...sealer, available: () => false })
    expect(() => keys.set('typesafe', 'k')).toThrow(/Secure storage/)
  })
})

describe('Atelier’s own decisions', () => {
  it('needsYou: a polite closing offer does not wait on you once the model is sure', async () => {
    const { d } = makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([noulReply('waits', 0.1)]))
    setDecider(d)
    await expect(needsYou('Done! Want me to do anything else?', true, false)).resolves.toBe(false)
    await expect(needsYou('', true, false)).resolves.toBe(true)
  })

  it('clickKind only ever adds a stop', async () => {
    const fetch = fakeFetch([choiceReply('kind', { none: 0.05, purchase: 0.9, payment: 0.05 }), choiceReply('kind', { none: 0.95, purchase: 0.05 }), choiceReply('kind', { none: 0.4, purchase: 0.6 })])
    setDecider(makeDecisions(settingsWith({ provider: 'typesafe' }), fetch).d)
    const target = {
      name: 'Jetzt kaufen',
      role: 'button',
      page: 'Warenkorb',
      url: 'https://shop.example',
    }
    await expect(clickKind(target, false)).resolves.toBe('purchase')
    await expect(clickKind({ ...target, name: 'Weiter' }, false)).resolves.toBeNull()
    await expect(clickKind({ ...target, name: 'Filter' }, false)).resolves.toBeNull()
    await expect(clickKind({ ...target, name: '' }, false)).resolves.toBeNull()
    // The same control on the same page is judged once: clicking it again doesn't wait on the model again.
    await expect(clickKind(target, false)).resolves.toBe('purchase')
    expect(fetch.calls).toHaveLength(3)
  })

  it('searchOrAsk keeps the composer’s mode unless the model is sure', async () => {
    setDecider(makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([choiceReply('intent', { search: 0.92, ask: 0.08 }), choiceReply('intent', { search: 0.55, ask: 0.45 })])).d)
    await expect(searchOrAsk('pizza near me', 'ask')).resolves.toBe('search')
    await expect(searchOrAsk('pizza recipes', 'ask')).resolves.toBe('ask')
    await expect(searchOrAsk('ab', 'ask')).resolves.toBe('ask')
  })

  it('setupPicks replaces only the picks the model is sure of', async () => {
    const body = {
      model: 'jev-1.14.0',
      answers: {
        techLevel: {
          type: 'choice',
          choice: 'technical',
          confidence: 0.9,
          probabilities: {
            simple: 0.02,
            mixed: 0.03,
            technical: 0.9,
            unclear: 0.05,
          },
        },
        replyStyle: {
          type: 'choice',
          choice: 'short',
          confidence: 0.3,
          probabilities: {
            short: 0.4,
            balanced: 0.3,
            thorough: 0.1,
            unsaid: 0.2,
          },
        },
        ...Object.fromEntries(
          ['research', 'shopping', 'writing', 'meetings', 'routines', 'travel', 'coding', 'data', 'design', 'projects', 'sales', 'finance', 'learning'].map((i) => [
            `interest_${i}`,
            {
              type: 'noul',
              noul: i === 'coding' ? 0.95 : i === 'travel' ? 0.05 : 0.5,
            },
          ]),
        ),
      },
    }
    setDecider(makeDecisions(settingsWith({ provider: 'typesafe' }), fakeFetch([{ body }])).d)
    const picks = await setupPicks(
      'I write code all day.',
      Promise.resolve({
        techLevel: 'mixed',
        replyStyle: 'balanced',
        interests: ['travel', 'research'],
      }),
    )
    expect(picks.techLevel).toBe('technical')
    expect(picks.replyStyle).toBe('balanced')
    expect(picks.interests.sort()).toEqual(['coding', 'research'])
  })
})

describe('routine conditions', () => {
  const ask = (noul: number, source: 'model' | 'claude' = 'model') =>
    vi.fn(async () => ({
      answers: { met: { type: 'noul' as const, noul } },
      model: 'm',
      source,
      ms: 1,
      inputTokens: 0,
    }))

  it('stays quiet only on a clear no', async () => {
    await expect(conditionMet('the price is under €200', 'It is €250 today.', ask(0.05))).resolves.toBe(false)
    await expect(conditionMet('the price is under €200', 'It is €180 today.', ask(0.95))).resolves.toBe(true)
    await expect(conditionMet('the price is under €200', 'Unclear.', ask(0.5))).resolves.toBe(true)
    await expect(conditionMet('the price is under €200', 'It is €250 today.', ask(0.25, 'claude'))).resolves.toBe(true)
  })

  it('notifies when there is no condition, no reply or the check fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(conditionMet('', 'x', failing)).resolves.toBe(true)
    await expect(conditionMet('cond', null, failing)).resolves.toBe(true)
    await expect(conditionMet('cond', 'x', failing)).resolves.toBe(true)
  })

  it('reads the closing reply from the chat log', () => {
    expect(
      lastReplyOf([
        { type: 'text-delta', turnId: 't1', text: 'First.' },
        { type: 'user-message', id: 'u', text: 'More' },
        { type: 'text-delta', turnId: 't2', text: 'The price ' },
        { type: 'text-delta', turnId: 't2', text: 'is €180.' },
        { type: 'status', status: 'idle' },
      ] as never),
    ).toBe('The price is €180.')
    expect(lastReplyOf([])).toBeNull()
    // A run that wrote nothing after its own message has no reply, whatever an earlier turn said.
    expect(
      lastReplyOf([
        { type: 'text-delta', turnId: 't1', text: 'Nothing under €200 today.' },
        { type: 'user-message', id: 'u2', text: 'Check prices' },
        { type: 'status', status: 'idle' },
      ] as never),
    ).toBeNull()
  })
})

describe('smoke’s stand-in model', () => {
  it('answers every question type with its first option', async () => {
    const result = await requestDecision(
      smokeFetch,
      { url: 'http://smoke', key: null, model: '' },
      {
        state: 's',
        questions: {
          n: { type: 'noul', instructions: 'N?' },
          c: {
            type: 'choice',
            instructions: 'C?',
            criteria: { x: null, y: null },
          },
          s: { type: 'score', instructions: 'S?', criteria: ['a', 'b', 'c'] },
        },
      },
      { timeoutMs: 1_000 },
    )
    expect(result.answers).toMatchObject({
      n: { noul: 0.9 },
      c: { choice: 'x' },
      s: { type: 'score' },
    })
  })
})
