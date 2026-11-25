/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMPARISONS_MAX,
  DECISION_PRESETS,
  DEVICE_SCHEME,
  EXCERPT_MAX,
  PROVIDER_DEFAULTS,
  isPreset,
  sameModel,
  type DecisionCatalog,
  type DecisionErrorCode,
  type DecisionModelRef,
  type DecisionPreset,
  type DecisionCaller,
  type DecisionComparison,
  type DecisionRequest,
  type DecisionResult,
  type DecisionsSettings,
  type DecisionsStatus,
  type DecisionTestResult,
  type DecisionUse,
  type MiniStatus,
} from '@shared/decisions'
import { EngineUnavailableError, type QuickModel } from '../agent/quick'
import { recordUsage } from '../agent/usageSink'
import { log, redact } from '../log'
import { writeAtomic } from '../workspace/fsutil'
import { claudeDecide } from './claude'
import { DecisionError, endpointFor, listModels, modelsUrlOf, requestDecision, type Endpoint, type FetchLike } from './client'
import type { DecisionKeys } from './keys'

// The decider (DC-01, DC-04 to DC-06). Every one of Atelier's own decisions
// calls decide() with the answer its rule already gave; the rule's answer
// comes straight back unless a decision model is on for that use, the window
// is not private, the model answers in time and is sure enough (the caller's
// read() says so). In compare mode the rule always wins and the model only
// runs alongside, so you can see where it would have decided otherwise
// before you let it.

/** How long each decision may wait for the model before its rule answers. */
export const DECISION_TIMEOUTS: Readonly<Record<DecisionCaller, number>> = {
  needsYou: 1_500,
  dictation: 900,
  agentClicks: 1_200,
  searchOrAsk: 900,
  voiceTarget: 700,
  setup: 5_000,
  labeling: 10_000,
  effort: 800,
  skills: 1_500,
  memory: 5_000,
  tabs: 2_000,
  routine: 15_000,
  pack: 10_000,
}

/** After a provider's rate limit, the rules decide for this long, or for its Retry-After (at most RATE_LIMIT_PAUSE_MAX_MS). */
export const RATE_LIMIT_PAUSE_MS = 60_000
/** A Retry-After of 0 (or a date gone by) still sets the model aside this long, so it isn't asked again at once. */
const RATE_LIMIT_PAUSE_MIN_MS = 5_000
const RATE_LIMIT_PAUSE_MAX_MS = 10 * 60_000

/**
 * The slow tail (DC-20): a gateway answers one request in five in more than
 * a second, at random (measured: the faster of two requests sent together
 * missed the click guard's 1.2 s none of 40 times; one request missed 8).
 * So a decision someone waits on (HEDGED; not the batch uses, which send
 * many requests at once) that has no answer after HEDGE_AFTER_MS asks again,
 * and takes whichever answer comes first. A fast provider never gets the second request; your own
 * server on this computer and a provider that hit its rate limit this session
 * never do.
 */
const HEDGED: ReadonlySet<DecisionCaller> = new Set<DecisionCaller>(['needsYou', 'dictation', 'agentClicks', 'searchOrAsk', 'voiceTarget', 'effort', 'skills'])
const HEDGE_AFTER_MS = 250
/** The second request needs at least this long before the time limit. */
const HEDGE_LEFT_MS = 300

export interface DecideCall<T> {
  use: DecisionUse
  /** What Atelier's rule decided; returned whenever the model does not take over. A slow rule (a Claude call) runs alongside the model. */
  rule: T | Promise<T>
  /** Built only when the model is consulted. */
  request: () => DecisionRequest
  /** The model's verdict in the rule's shape (it may keep parts of the rule), or null when it is not sure enough. */
  read(result: DecisionResult, rule: T): T | null
  /** A short label for the comparisons list (default: the value as text). */
  label?(value: T): string
  /** True in a private window or chat: nothing is sent and nothing is noted. */
  private?: boolean
  /** What was decided about, for the comparisons list (redacted and cut short). */
  excerpt?: string
  timeoutMs?: number
  /**
   * Reuse the model's verdict for the same key (with the same provider, address
   * and model) for a while: a text typed again, a control clicked again. Only
   * for uses whose read() ignores the rule.
   */
  reuse?: { key: string; ttlMs: number }
}

export interface Decider {
  decide<T>(call: DecideCall<T>): Promise<T>
  /** Whether decide() would consult the model for this use right now. */
  active(use: DecisionUse): boolean
  /** A decision model is chosen and has what it needs (a key, or a custom server's address). */
  ready(): boolean
  /** The provider's rate limit was reached a moment ago, so the rules decide (and routines and packs use Claude) until it lifts. */
  paused(): boolean
  /** A direct question for routines and packs: the decision model when one is on, otherwise the Claude engine. */
  ask(caller: 'routine' | 'pack', request: DecisionRequest, options?: AskOptions): Promise<DecisionResult>
  /** The decision model alone, for the companion's label_items: throws a DecisionError when it is off, paused by a rate limit or fails. */
  model(caller: DecisionCaller, request: DecisionRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DecisionResult>
}

export interface AskOptions {
  companionId?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Called just before the Claude engine answers instead (a pack's model budget); throwing stops it. */
  beforeClaude?(): void
}

/** Until the feature starts (and in unit tests) every decision is the rule's. */
export const RULES_ONLY: Decider = {
  decide: async (call) => call.rule,
  active: () => false,
  ready: () => false,
  paused: () => false,
  ask: async () => {
    throw new EngineUnavailableError('Quick decisions are not running.')
  },
  model: async () => {
    throw new DecisionError('no-key', 'Quick decisions are not running.')
  },
}

let current: Decider = RULES_ONLY

export function setDecider(next: Decider | null): void {
  current = next ?? RULES_ONLY
}

/** The app's decider: Atelier's rules, plus the decision model where you turned it on. */
export function decider(): Decider {
  return current
}

export interface DecisionsDeps {
  dataDir: string
  settings(): DecisionsSettings
  keys: DecisionKeys
  fetch: FetchLike
  quick(): Pick<QuickModel, 'json' | 'ready'> | null
  /** The on-device model (device.ts): whether its files are here. Absent, it reads as not installed. */
  device?: { available(): boolean }
  /** The on-device model's optional larger half (deviceMini.ts): its download state, shown in Settings. */
  mini?: { status(): MiniStatus }
  now?: () => number
}

export const COMPARISONS_FILE = 'decision-comparisons.json'
/** Verdicts kept for reuse (DecideCall.reuse), oldest dropped first. */
const VERDICTS_MAX = 500

const label = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

/** The model's probability for its own answer to the first question: how sure it was. */
/** One of your models, as a key: the provider and the model id. */
function refKey(ref: DecisionModelRef): string {
  return `${ref.provider}\n${ref.model}`
}

/** One of your models that can be asked, and where. */
interface Link {
  ref: DecisionModelRef
  endpoint: Endpoint
}

interface ModelHealth {
  lastModel: string | null
  lastMs: number | null
  lastError: DecisionErrorCode | null
  pausedUntil: number
  pausedReason: string | null
}

/** A model that fails this fast leaves time for the next; less than this left, the rule decides. */
const NEXT_MODEL_MIN_MS = 300

/** A server on this computer, or the on-device model: a second request would only queue behind the first. */
function isLoopback(url: string): boolean {
  try {
    if (new URL(url).protocol === DEVICE_SCHEME) return true
    return /^(localhost\.?|.+\.localhost\.?|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\]|\[::ffff:(?:127(?:\.\d+){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})\])$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** The provider's own words on a rate limit (its plan or credits, say), from the error's detail, redacted and cut short. */
export function providerSaid(message: string): string | null {
  const detail = message.replace(/^The decision model answered \d+:?\s*/, '')
  if (!detail.trim() || detail === message) return null
  // The detail is usually a JSON error, perhaps cut off: its message, unescaped, when there is one.
  const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail)?.[1]
  let said = detail
  if (quoted !== undefined) {
    try {
      said = JSON.parse(`"${quoted}"`) as string
    } catch {
      said = quoted
    }
  }
  said = redact(said)
    .replace(/^[a-z_]+:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return said ? said.slice(0, 200) : null
}

function confidenceOf(result: DecisionResult): number {
  const first = Object.values(result.answers)[0]
  if (!first) return 0
  if (first.type === 'noul') return Math.max(first.noul, 1 - first.noul)
  return first.type === 'choice' ? (first.probabilities[first.choice] ?? first.confidence) : first.confidence
}

export class Decisions implements Decider {
  readonly #d: DecisionsDeps
  readonly #path: string
  readonly #now: () => number
  #comparisons: DecisionComparison[] | null = null
  /** How each of your models has done this session (lastModel, lastMs, lastError, its pause), by refKey. */
  readonly #health = new Map<string, ModelHealth>()
  /** Models that answered with a rate limit this session: they never get a second request. */
  readonly #limited = new Set<string>()
  #verdicts = new Map<string, { at: number; verdict: unknown }>()
  #answered = 0
  #differed = 0

  constructor(deps: DecisionsDeps) {
    this.#d = deps
    this.#path = join(deps.dataDir, COMPARISONS_FILE)
    this.#now = deps.now ?? Date.now
  }

  // ── Atelier's own decisions ──

  active(use: DecisionUse): boolean {
    const s = this.#d.settings()
    return s.on && s.uses[use] && this.#chain(s).length > 0
  }

  ready(): boolean {
    return this.#chain(this.#d.settings()).length > 0
  }

  /** Every one of your models is paused by a rate limit, so the rules decide (and routines and packs use Claude) until one lifts. */
  paused(): boolean {
    const links = this.#chain(this.#d.settings())
    return links.length > 0 && links.every((l) => this.#isPaused(l.ref))
  }

  async decide<T>(call: DecideCall<T>): Promise<T> {
    if (call.private || !this.active(call.use) || this.paused()) return call.rule
    const s = this.#d.settings()
    const compare = s.mode === 'compare'
    const reuseKey = call.reuse ? [call.use, ...this.#chain(s).map((l) => `${refKey(l.ref)}\n${l.endpoint.url}`), call.reuse.key].join('\u0000') : null
    const kept = reuseKey ? this.#verdicts.get(reuseKey) : undefined
    if (kept && this.#now() - kept.at < call.reuse!.ttlMs) return compare ? call.rule : ((kept.verdict as T | null) ?? call.rule)
    let request: DecisionRequest
    try {
      request = call.request()
    } catch (err) {
      log.warn('decisions', 'A decision request could not be built', {
        use: call.use,
        error: err instanceof Error ? err.message : String(err),
      })
      return call.rule
    }
    const run = this.#model(call.use, request, call.timeoutMs ?? DECISION_TIMEOUTS[call.use])
    run.catch(() => undefined)
    const keep = (verdict: T | null): T | null => {
      if (reuseKey) {
        this.#verdicts.delete(reuseKey)
        this.#verdicts.set(reuseKey, { at: this.#now(), verdict })
        if (this.#verdicts.size > VERDICTS_MAX) this.#verdicts.delete(this.#verdicts.keys().next().value!)
      }
      return verdict
    }
    if (compare) {
      void Promise.all([call.rule, run]).then(
        ([rule, result]) => keep(this.#note(call, rule, result, false)),
        () => undefined,
      )
      return call.rule
    }
    const rule = await call.rule
    try {
      return keep(this.#note(call, rule, await run, true)) ?? rule
    } catch {
      return rule
    }
  }

  /** Counts the answer, notes a disagreement, and returns the model's verdict (null when unsure). */
  #note<T>(call: DecideCall<T>, ruleValue: T, result: DecisionResult, applying: boolean): T | null {
    let verdict: T | null
    try {
      verdict = call.read(result, ruleValue)
    } catch {
      verdict = null
    }
    this.#answered++
    if (verdict === null) return null
    const show = call.label ?? label
    const rule = show(ruleValue)
    const model = show(verdict)
    if (rule !== model) {
      this.#differed++
      this.#remember({
        at: this.#now(),
        use: call.use,
        rule,
        model,
        confidence: Math.round(confidenceOf(result) * 100) / 100,
        applied: applying,
        version: result.model,
        excerpt: call.excerpt ? redact(call.excerpt).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX) : '',
      })
    }
    return verdict
  }

  // ── Routines and packs ──

  async ask(caller: 'routine' | 'pack', request: DecisionRequest, options: AskOptions = {}): Promise<DecisionResult> {
    const s = this.#d.settings()
    if (s.on && this.#chain(s).length > 0 && !this.paused()) {
      try {
        return await this.#model(caller, request, options.timeoutMs ?? DECISION_TIMEOUTS[caller], options.signal)
      } catch (err) {
        if (options.signal?.aborted) throw err
        // The decision model is unreachable or rate-limited: your Claude engine answers instead.
      }
    }
    const quick = this.#d.quick()
    if (!quick) throw new EngineUnavailableError('No engine can answer: set up Quick decisions or your API key.')
    options.beforeClaude?.()
    return claudeDecide(quick, request, {
      kind: caller,
      ...(options.companionId ? { companionId: options.companionId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      now: this.#now,
    })
  }

  model(caller: DecisionCaller, request: DecisionRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DecisionResult> {
    if (!this.#d.settings().on) return Promise.reject(new DecisionError('no-key', 'Quick decisions are off.'))
    if (this.paused()) return Promise.reject(new DecisionError('rate-limited', 'Every chosen model’s rate limit was reached a moment ago.'))
    return this.#model(caller, request, options.timeoutMs ?? DECISION_TIMEOUTS[caller], options.signal)
  }

  // ── Settings › Quick decisions ──

  status(): DecisionsStatus {
    const s = this.#d.settings()
    const providers = [...DECISION_PRESETS, ...s.servers.map((x) => x.id)]
    return {
      on: s.on,
      keys: Object.fromEntries(providers.map((p) => [p, this.#d.keys.has(p)])),
      connected: Object.fromEntries(providers.map((p) => [p, this.#connected(p, s)])),
      ready: s.on && this.#chain(s).length > 0,
      models: s.models.map((ref) => {
        const h = this.#health.get(refKey(ref))
        const paused = this.#isPaused(ref)
        return {
          ...ref,
          connected: this.#connected(ref.provider, s),
          lastModel: h?.lastModel ?? null,
          lastMs: h?.lastMs ?? null,
          lastError: h?.lastError ?? null,
          pausedUntil: paused ? (h?.pausedUntil ?? null) : null,
          pausedReason: paused ? (h?.pausedReason ?? null) : null,
        }
      }),
      answered: this.#answered,
      differed: this.#differed,
      ...(this.#d.mini ? { mini: this.#d.mini.status() } : {}),
    }
  }

  /** One tiny request to one model (default: your first choice, whether or not the switch is on). */
  async test(ref?: DecisionModelRef): Promise<DecisionTestResult> {
    const s = this.#d.settings()
    const target = ref ?? s.models[0]
    if (!target)
      return {
        ok: false,
        provider: 'openrouter',
        model: '',
        error: 'no-key',
        detail: 'Choose a model first.',
      }
    if (!this.#endpointOf(target, s))
      return {
        ...target,
        ok: false,
        error: 'no-key',
        detail: isPreset(target.provider) ? 'Paste its key first.' : 'Add that server first.',
      }
    try {
      const result = await this.#model(
        'setup',
        {
          state: `${BRAND_NAME} is checking that this decision model answers.`,
          questions: {
            ok: {
              type: 'noul',
              instructions: 'This text is a connection check.',
            },
          },
        },
        10_000,
        undefined,
        false,
        target,
      )
      return { ...target, ok: true, answered: result.model, ms: result.ms }
    } catch (err) {
      const e = err instanceof DecisionError ? err : new DecisionError('failed', err instanceof Error ? err.message : String(err))
      // The provider's own words, cleaned, rather than its raw JSON; Settings words the error itself.
      const said = providerSaid(e.message)
      return {
        ...target,
        ok: false,
        error: e.code,
        detail: said ?? (e.message.startsWith('The decision model answered') ? '' : e.message),
      }
    }
  }

  /** The decision models each connected provider offers (and those its preset names), for picking yours. */
  async catalog(): Promise<DecisionCatalog[]> {
    const s = this.#d.settings()
    const providers = [...DECISION_PRESETS, ...s.servers.map((x) => x.id)].filter((p) => this.#connected(p, s))
    return Promise.all(
      providers.map(async (provider): Promise<DecisionCatalog> => {
        const key = this.#d.keys.get(provider)
        let where: { url: string; key: string | null; decisionsOnly?: boolean }
        let extra: readonly string[] = []
        if (isPreset(provider)) {
          const preset: DecisionPreset = PROVIDER_DEFAULTS[provider]
          where = {
            url: preset.modelsUrl,
            key,
            decisionsOnly: preset.listsDecisionModelsOnly === true,
          }
          extra = preset.models ?? []
        } else {
          const server = s.servers.find((x) => x.id === provider)!
          where = {
            url: modelsUrlOf(endpointFor(server.url, key, '').url),
            key,
          }
        }
        const listed = await listModels(this.#d.fetch, where, {
          timeoutMs: 10_000,
        })
        const models = [...(listed ?? [])]
        for (const id of extra) if (!models.some((m) => m.id === id)) models.push({ id, price: null, zdr: null })
        return {
          provider,
          models: models.sort((a, b) => a.id.localeCompare(b.id)),
          failed: listed === null,
        }
      }),
    )
  }

  comparisons(): DecisionComparison[] {
    return [...this.#load()]
  }

  clearComparisons(): void {
    this.#comparisons = []
    rmSync(this.#path, { force: true })
  }

  /** Bytes the comparisons take on disk, for Settings › Your data. */
  comparisonsBytes(): number {
    return existsSync(this.#path) ? readFileSync(this.#path).byteLength : 0
  }

  // ── The model call ──

  /** Whether a provider can be asked: a preset with its key (the on-device one once its files are here), or a server of yours (its key is optional). */
  #connected(provider: string, s: DecisionsSettings): boolean {
    if (!isPreset(provider)) return s.servers.some((x) => x.id === provider)
    const preset: DecisionPreset = PROVIDER_DEFAULTS[provider]
    return preset.onDevice ? this.#d.device?.available() === true : this.#d.keys.has(provider)
  }

  #endpointOf(ref: DecisionModelRef, s: DecisionsSettings): Endpoint | null {
    const key = this.#d.keys.get(ref.provider)
    if (isPreset(ref.provider)) {
      const preset: DecisionPreset = PROVIDER_DEFAULTS[ref.provider]
      if (preset.onDevice) return this.#d.device?.available() ? endpointFor(preset.url, null, ref.model, preset.dialect) : null
      if (!key) return null
      return endpointFor(preset.url, key, ref.model, preset.dialect)
    }
    const server = s.servers.find((x) => x.id === ref.provider)
    return server ? endpointFor(server.url, key, ref.model) : null
  }

  /** Your models that can be asked, first choice first; off, none. */
  #chain(s: DecisionsSettings): Link[] {
    if (!s.on) return []
    const links: Link[] = []
    for (const ref of s.models) {
      const endpoint = this.#endpointOf(ref, s)
      if (endpoint && !links.some((l) => sameModel(l.ref, ref))) links.push({ ref, endpoint })
    }
    return links
  }

  #isPaused(ref: DecisionModelRef): boolean {
    return (this.#health.get(refKey(ref))?.pausedUntil ?? 0) > this.#now()
  }

  /**
   * Your models in order (or just `only`, for a Test): the first that answers
   * within the time limit wins. One that fails, is busy, is unreachable or
   * paused by a rate limit hands over to the next while there is time left;
   * a timeout leaves no time for another, so the rule decides.
   */
  async #model(caller: DecisionCaller, request: DecisionRequest, timeoutMs: number, signal?: AbortSignal, count = true, only?: DecisionModelRef): Promise<DecisionResult> {
    const s = this.#d.settings()
    const links = only ? [this.#endpointOf(only, s)].flatMap((endpoint) => (endpoint ? [{ ref: only, endpoint }] : [])) : this.#chain(s)
    if (links.length === 0) throw new DecisionError('no-key', 'Quick decisions are not set up.')
    const started = this.#now()
    let failure: unknown = null
    for (const link of links) {
      if (!only && this.#isPaused(link.ref)) {
        failure ??= new DecisionError('rate-limited', 'Its rate limit was reached a moment ago.')
        continue
      }
      const left = timeoutMs - (this.#now() - started)
      if (left < NEXT_MODEL_MIN_MS && failure) break
      const health = this.#healthOf(link.ref)
      try {
        const { result, sent } = await this.#send(caller, link, request, left, signal)
        if (health.lastModel && health.lastModel !== result.model)
          log.info('decisions', 'The decision model answering changed', {
            from: health.lastModel,
            to: result.model,
          })
        Object.assign(health, {
          lastModel: result.model,
          lastMs: result.ms,
          lastError: null,
        })
        // A Test that passes lifts that model's pause (a request already on its way when the 429 came does not).
        if (only) Object.assign(health, { pausedUntil: 0, pausedReason: null })
        // A second request read the same input (DC-20).
        if (count)
          recordUsage({
            chatId: null,
            companionId: '',
            model: result.model,
            engine: 'api-key',
            kind: 'decide',
            inputTokens: result.inputTokens * sent,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          })
        return { ...result, ms: this.#now() - started }
      } catch (err) {
        const code = err instanceof DecisionError ? err.code : 'failed'
        health.lastError = code
        // A rate limit stays for a while (a free plan's is per minute), so that model sits out until it lifts instead of being tried every time.
        if (code === 'rate-limited') {
          health.pausedUntil = this.#now() + Math.min(RATE_LIMIT_PAUSE_MAX_MS, Math.max(RATE_LIMIT_PAUSE_MIN_MS, (err as DecisionError).retryAfterMs ?? RATE_LIMIT_PAUSE_MS))
          health.pausedReason = providerSaid((err as DecisionError).message)
        }
        if (code !== 'timeout')
          log.warn('decisions', 'A decision model call failed', {
            caller,
            code,
            model: link.ref.model,
          })
        failure = err
        if (signal?.aborted || code === 'timeout') break
      }
    }
    throw failure ?? new DecisionError('failed', 'No decision model answered.')
  }

  #healthOf(ref: DecisionModelRef): ModelHealth {
    const key = refKey(ref)
    let health = this.#health.get(key)
    if (!health) {
      health = {
        lastModel: null,
        lastMs: null,
        lastError: null,
        pausedUntil: 0,
        pausedReason: null,
      }
      this.#health.set(key, health)
    }
    return health
  }

  /**
   * The request, and the same request again when the first has no answer
   * after HEDGE_AFTER_MS (DC-20): the first answer wins and the other is
   * cancelled. A failure before the second is sent fails at once, as without
   * it. A rate limit keeps the second from going out; with both out, the one
   * that met it stops (no retry) and the other may still answer.
   * The answer's time is from the first send, and `sent` counts the requests.
   */
  #send(caller: DecisionCaller, link: Link, request: DecisionRequest, timeoutMs: number, signal?: AbortSignal): Promise<{ result: DecisionResult; sent: number }> {
    const { endpoint } = link
    const started = this.#now()
    const stops = [new AbortController(), new AbortController()]
    const onAbort = (): void => stops.forEach((c) => c.abort())
    if (signal?.aborted) onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let limited = false
    let sent = 1
    /** The requests stopped here because they met a rate limit. */
    const stoppedByLimit = new Set<number>()
    const onRateLimit = (i: number): void => {
      // The plan has no room for two: no second request now or later this session.
      limited = true
      this.#limited.add(refKey(link.ref))
      if (sent === 2) {
        stoppedByLimit.add(i)
        stops[i]!.abort()
      }
    }
    const attempt = (i: number, ms: number): Promise<DecisionResult> =>
      requestDecision(this.#d.fetch, endpoint, request, {
        timeoutMs: ms,
        now: this.#now,
        signal: stops[i]!.signal,
        onRateLimit: () => onRateLimit(i),
      })
    const done = (result: DecisionResult, sent: number): { result: DecisionResult; sent: number } => ({
      result: { ...result, ms: this.#now() - started },
      sent,
    })
    if (!this.#hedges(caller, link, timeoutMs))
      return attempt(0, timeoutMs)
        .then((r) => done(r, 1))
        .finally(() => signal?.removeEventListener('abort', onAbort))
    return new Promise<{ result: DecisionResult; sent: number }>((resolve, reject) => {
      const errors: unknown[] = []
      // The first request's own failure, as the decider should see it: one stopped here after a 429 was rate-limited, not slow.
      const firstError = (): unknown => (stoppedByLimit.has(0) ? new DecisionError('rate-limited', 'The provider’s rate limit was reached.') : errors[0])
      const settle = (i: number, p: Promise<DecisionResult>): void => {
        p.then(
          (result) => {
            clearTimeout(timer)
            stops[1 - i]!.abort()
            resolve(done(result, sent))
          },
          (err: unknown) => {
            errors[i] = err
            if (i === 1) {
              // The second request's own failure (a rate limit, say) is never the answer while the first is out.
              if (errors[0] !== undefined) reject(firstError())
              return
            }
            // The first request's failure is the answer unless a second is still on its way.
            if (sent === 1 || errors[1] !== undefined) {
              clearTimeout(timer)
              stops[1]!.abort()
              reject(firstError())
            }
          },
        )
      }
      const timer = setTimeout(() => {
        if (errors[0] !== undefined || limited) return
        sent = 2
        settle(1, attempt(1, timeoutMs - HEDGE_AFTER_MS))
      }, HEDGE_AFTER_MS)
      settle(0, attempt(0, timeoutMs))
    }).finally(() => signal?.removeEventListener('abort', onAbort))
  }

  /** Whether a slow answer is asked for again: a decision someone waits on, with time left, from a remote provider with room for it. */
  #hedges(caller: DecisionCaller, link: Link, timeoutMs: number): boolean {
    return HEDGED.has(caller) && timeoutMs - HEDGE_AFTER_MS >= HEDGE_LEFT_MS && !this.#limited.has(refKey(link.ref)) && !isLoopback(link.endpoint.url)
  }

  // ── Comparisons on disk ──

  #load(): DecisionComparison[] {
    if (this.#comparisons) return this.#comparisons
    this.#comparisons = []
    try {
      if (existsSync(this.#path)) {
        const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown
        if (Array.isArray(raw)) this.#comparisons = (raw as DecisionComparison[]).filter((c) => c && typeof c.at === 'number' && typeof c.use === 'string').slice(0, COMPARISONS_MAX)
      }
    } catch {
      // A damaged file starts the list over.
    }
    return this.#comparisons
  }

  #remember(row: DecisionComparison): void {
    const next = [row, ...this.#load()].slice(0, COMPARISONS_MAX)
    this.#comparisons = next
    try {
      writeAtomic(this.#path, JSON.stringify(next))
    } catch (err) {
      log.warn('decisions', 'Could not save a decision comparison', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
