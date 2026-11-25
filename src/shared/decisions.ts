/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

// Quick decisions (DC-01 to DC-12, docs/decisions.md): an optional decision
// model that answers typed questions about a piece of text (yes or no, one of
// a few options, or a level on a short scale) with probabilities, in about a
// tenth of a second and without writing any text. Atelier keeps its own rules as
// the answer: a decision model only takes over a decision when you turned it
// on in Settings › Quick decisions, it is sure enough and it answers in time.
//
// Providers speak one of two requests: TypeSafe's System One (Jev, Jev on
// OpenRouter, gateways such as Experiential Labs, and self-hosted servers such
// as the open Kev models) or OpenAI's Decisions (GPT-6 Luna, directly or
// through a gateway). The client turns one into the other, so Atelier's questions
// and readers are the same for both; only the address, key and model id
// differ. Nothing is fixed to one provider or one model: you connect any of
// the providers below (each with its own key) and any servers of your own,
// Atelier lists the decision models each one offers, and you pick the ones to
// use, in order. The first answers; when it fails, is busy or hits its rate
// limit, the next one does. Adding a provider is an entry in
// PROVIDER_DEFAULTS and its name and description in the decisions strings.

export interface DecisionPreset {
  /** Its decision endpoint. */
  url: string
  /** The request it takes; 'auto' picks by model (a gateway that serves Luna next to Jev answers OpenAI's Decisions at /v1/decisions). */
  dialect: DecisionDialect | 'auto'
  /** Where it lists its models. */
  modelsUrl: string
  /** That list holds decision models only, so none are picked out by name. */
  listsDecisionModelsOnly?: boolean
  /** A model to start with when you connect it; which models are used is yours to choose. */
  suggested: string
  /** Where to make a key. */
  keyUrl: string
  /** Decision models it serves that its model list doesn't show. */
  models?: readonly string[]
  /** Runs on this computer (src/main/decisions/device.ts): no key, nothing sent anywhere; connected once its files are here. */
  onDevice?: true
}

/** The on-device model's address: requests to it never leave this computer (src/main/decisions/device.ts). */
export const DEVICE_SCHEME = 'atelier-device:'

export const PROVIDER_DEFAULTS = {
  // Atelier's own small decision model, on this computer: distilled for these decisions, a few milliseconds a question.
  device: {
    url: 'atelier-device://nano/v1/systemone',
    dialect: 'systemone',
    modelsUrl: 'atelier-device://nano/v1/models',
    listsDecisionModelsOnly: true,
    suggested: 'atelier-nano',
    keyUrl: '',
    onDevice: true,
  },
  typesafe: {
    url: 'https://api.typesafe.ai/v1/systemone',
    dialect: 'systemone',
    modelsUrl: 'https://api.typesafe.ai/v1/models',
    suggested: 'jev-1.14.0',
    keyUrl: 'https://typesafe.ai',
  },
  // OpenRouter's Decisions router takes System One's request for every decision model it carries (Jev, Clef, Luna, Liquid, Perplexity and more).
  openrouter: {
    url: 'https://openrouter.ai/api/alpha/decisions',
    dialect: 'systemone',
    modelsUrl: 'https://openrouter.ai/api/v1/models?output_modalities=decisions',
    listsDecisionModelsOnly: true,
    suggested: 'typesafe/jev-1.14',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  experiential: {
    url: 'https://api.experientiallabs.ai/v1/systemone',
    dialect: 'auto',
    modelsUrl: 'https://api.experientiallabs.ai/v1/models',
    suggested: 'clef-flash',
    keyUrl: 'https://platform.experientiallabs.ai',
  },
  openai: {
    url: 'https://api.openai.com/v1/decisions',
    dialect: 'decisions',
    modelsUrl: 'https://api.openai.com/v1/models',
    suggested: 'gpt-6-luna',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-6-luna'],
  },
} as const satisfies Record<string, DecisionPreset>

export type DecisionPresetId = keyof typeof PROVIDER_DEFAULTS
export const DECISION_PRESETS = Object.keys(PROVIDER_DEFAULTS) as [DecisionPresetId, ...DecisionPresetId[]]
/** A provider: one of the presets, or one of your own servers. */
export type DecisionProviderId = DecisionPresetId | `server-${string}`
export const SERVER_ID = /^server-[a-z0-9]{1,16}$/

export function isProviderId(id: string): id is DecisionProviderId {
  return Object.hasOwn(PROVIDER_DEFAULTS, id) || SERVER_ID.test(id)
}

export function isPreset(id: string): id is DecisionPresetId {
  return Object.hasOwn(PROVIDER_DEFAULTS, id)
}

/** A server of your own (Kev on this Mac, a gateway not listed above): any System One or Decisions address, a key only if it asks. */
export interface DecisionServer {
  id: `server-${string}`
  name: string
  url: string
}

/** One model to use, at one provider. */
export interface DecisionModelRef {
  provider: DecisionProviderId
  model: string
}

/** The address placeholder for your own server (Kev's default port). */
export const OWN_SERVER_PLACEHOLDER = 'http://127.0.0.1:8009'
export const SERVERS_MAX = 8
/** Models in your list: a first choice and backups. */
export const CHOSEN_MODELS_MAX = 6

/** Model families that answer System One requests, for picking them out of a provider's full model list. */
export const DECISION_MODEL_FAMILIES = /(^|[/:_.-])(jev|kev|clef|laya)([/:_.-]|$)/i
/** Models that take OpenAI's Decisions request (`…/v1/decisions`): GPT-6 Luna, and gateways' `-decisions` ids for it. */
export const DECISIONS_API_MODELS = /(^|[/:_.-])gpt-[\w.-]*luna([/:_.-]|$)/i
/** A gateway's model list names decision models of other kinds with this ending (gpt-6-luna-decisions). */
export const DECISION_MODEL_SUFFIX = /-decisions$/i

/** Which request a model takes: OpenAI's Decisions for Luna models or a `/decisions` address, otherwise System One. */
export type DecisionDialect = 'systemone' | 'decisions'
export function dialectOf(model: string, url: string): DecisionDialect {
  return /\/decisions\/?$/i.test(url) || DECISIONS_API_MODELS.test(model) ? 'decisions' : 'systemone'
}

/**
 * The decisions Atelier can hand to a decision model. Each keeps its own rule
 * when the model is off, unsure, slow or unreachable; 'labeling' is the
 * companion's label_items tool, which the companion judges itself without it.
 * 'effort' and 'memory' send your messages and whole chats, so they start off
 * even once a provider is chosen.
 */
export const DECISION_USES = ['needsYou', 'dictation', 'agentClicks', 'searchOrAsk', 'voiceTarget', 'setup', 'labeling', 'effort', 'skills', 'memory', 'tabs'] as const
export type DecisionUse = (typeof DECISION_USES)[number]

/** Model calls that are not one of Atelier's own decisions: routine conditions and packs. Both run on your Claude engine when no decision model is on. */
export type DecisionCaller = DecisionUse | 'routine' | 'pack'

export interface DecisionsSettings {
  /** The master switch: off, Atelier's own rules decide, whatever is set up below. */
  on: boolean
  /** The models to use, first choice first; when one fails, is busy or hits its rate limit, the next answers. */
  models: DecisionModelRef[]
  /** Your own servers, each a provider of its own. */
  servers: DecisionServer[]
  /** 'use': the model's answer wins when it is sure. 'compare': Atelier keeps its rules and only notes where the model would have decided otherwise. */
  mode: 'use' | 'compare'
  uses: Record<DecisionUse, boolean>
}

export const DECISIONS_DEFAULTS: DecisionsSettings = {
  on: false,
  models: [],
  servers: [],
  mode: 'use',
  uses: {
    needsYou: true,
    dictation: true,
    agentClicks: true,
    searchOrAsk: true,
    voiceTarget: true,
    setup: true,
    labeling: true,
    effort: false,
    skills: true,
    memory: false,
    tabs: true,
  },
}

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/~@-]+$/)
/** A server's address: http(s) only, and never with a name or password in it (they would sit in settings.json in plain text). */
export function isServerUrl(text: string): boolean {
  try {
    const u = new URL(text)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && text.length <= 500
  } catch {
    return false
  }
}

const serverUrl = z.string().trim().max(500).refine(isServerUrl)

export const DECISIONS_SETTINGS_SCHEMA = z
  .object({
    on: z.boolean(),
    models: z.array(z.object({ provider: z.string().refine(isProviderId), model: modelId }).strict()).max(CHOSEN_MODELS_MAX) as z.ZodType<DecisionModelRef[]>,
    servers: z
      .array(
        z
          .object({
            id: z.string().regex(SERVER_ID),
            name: z.string().trim().min(1).max(60),
            url: serverUrl,
          })
          .strict(),
      )
      .max(SERVERS_MAX) as z.ZodType<DecisionServer[]>,
    mode: z.enum(['use', 'compare']),
    // A use added later takes its default, so switches turned off before stay off (settings migrate one level deep).
    uses: z.object(Object.fromEntries(DECISION_USES.map((u) => [u, z.boolean().default(DECISIONS_DEFAULTS.uses[u])])) as Record<DecisionUse, z.ZodDefault<z.ZodBoolean>>),
  })
  .strict()

/** Two refs name the same model at the same provider. */
export function sameModel(a: DecisionModelRef, b: DecisionModelRef): boolean {
  return a.provider === b.provider && a.model === b.model
}

/**
 * Models that take a per-message effort (DC-15): an effort-only system message
 * in the history (beta), which keeps the prompt cache, where changing the
 * request's own effort would write the whole conversation to the cache again.
 * Other models keep the chat's effort. Haiku 5.5 has no effort setting in Atelier.
 */
const PER_MESSAGE_EFFORT_MODELS: ReadonlySet<string> = new Set(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

export function perMessageEffort(model: string): boolean {
  return PER_MESSAGE_EFFORT_MODELS.has(model)
}

// ── The System One request and its answers ──

export type DecisionQuestion =
  | {
      type: 'noul'
      instructions: string
      criteria?: { true?: string; false?: string }
    }
  | {
      type: 'choice'
      instructions: string
      criteria: Record<string, string | null>
    }
  | { type: 'score'; instructions: string; criteria: string[] }

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice'
      choice: string
      confidence: number
      probabilities: Record<string, number>
    }
  | {
      type: 'score'
      score: number
      confidence: number
      probabilities: Record<string, number>
    }

export type DecisionState = string | Record<string, unknown>

export interface DecisionRequest {
  state: DecisionState
  questions: Record<string, DecisionQuestion>
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>
  /** The version that answered (jev-1.14.0), or the Claude model for a fallback answer. */
  model: string
  /** 'model': a decision model's probabilities. 'claude': your Claude engine's own estimate, which is less calibrated. */
  source: 'model' | 'claude'
  ms: number
  inputTokens: number
}

/** Limits Atelier holds every request to (TypeSafe allows more; these keep calls fast and cheap). */
export const DECISION_LIMITS = {
  questions: 20,
  choices: 64,
  levels: 10,
  stateChars: 24_000,
  instructionChars: 1_000,
  keyChars: 64,
} as const

const questionKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
const text = z.string().trim().min(1).max(DECISION_LIMITS.instructionChars)

export const DECISION_QUESTION_SCHEMA: z.ZodType<DecisionQuestion> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('noul'),
      instructions: text,
      criteria: z.object({ true: text.optional(), false: text.optional() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('choice'),
      instructions: text,
      criteria: z.record(questionKey, text.nullable()),
    })
    .strict()
    .refine((q) => Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= DECISION_LIMITS.choices, { message: `A choice needs 2 to ${DECISION_LIMITS.choices} options.` }),
  z
    .object({
      type: z.literal('score'),
      instructions: text,
      criteria: z.array(text).min(2).max(DECISION_LIMITS.levels),
    })
    .strict(),
])

export const DECISION_REQUEST_SCHEMA = z
  .object({
    state: z.union([z.string().max(DECISION_LIMITS.stateChars), z.record(z.string(), z.unknown())]),
    questions: z.record(questionKey, DECISION_QUESTION_SCHEMA).refine(
      (q) => {
        const n = Object.keys(q).length
        return n >= 1 && n <= DECISION_LIMITS.questions
      },
      { message: `Ask 1 to ${DECISION_LIMITS.questions} questions.` },
    ),
  })
  .strict()

// ── Reading answers (the confidence bands of docs/decisions.md › Thresholds) ──

/**
 * A yes or no only when the model is clearly on one side: at or above `yes`
 * it is a yes, at or below `no` a no, and in between it says nothing, so the
 * caller keeps its rule. TypeSafe's suggested starting cutoffs are 0.7 and 0.3.
 */
export function yesNo(answer: DecisionAnswer | undefined, yes = 0.7, no = 0.3): boolean | null {
  if (answer?.type !== 'noul') return null
  if (answer.noul >= yes) return true
  if (answer.noul <= no) return false
  return null
}

/** The chosen option when its own probability reaches `min`; otherwise null. */
export function sureChoice<K extends string>(answer: DecisionAnswer | undefined, min = 0.75): K | null {
  if (answer?.type !== 'choice') return null
  return (answer.probabilities[answer.choice] ?? 0) >= min ? (answer.choice as K) : null
}

/** The most likely level of a score when it holds at least `min` of the probability; otherwise null. */
export function sureLevel(answer: DecisionAnswer | undefined, min = 0.6): number | null {
  if (answer?.type !== 'score') return null
  const [level, p] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0] ?? []
  return level !== undefined && (p ?? 0) >= min ? Number(level) : null
}

/** Claude's own estimates are less calibrated than a decision model's probabilities, so every cutoff is raised for them. */
export function stricter(result: Pick<DecisionResult, 'source'>, cutoff: number): number {
  return result.source === 'claude' ? Math.min(0.97, cutoff + (1 - cutoff) / 2) : cutoff
}

// ── Status, comparisons and the settings page ──

/** How one of your models is doing. */
export interface DecisionModelStatus extends DecisionModelRef {
  /** Its provider can be asked: a key saved, or your server's address set. */
  connected: boolean
  /** The version that answered last, so a moved alias shows up. */
  lastModel: string | null
  lastMs: number | null
  lastError: DecisionErrorCode | null
  /** After its provider's rate limit, the next model (or Atelier's rules) answers until this time (ms since 1970). */
  pausedUntil: number | null
  /** What the provider said when it paused (its plan or credit limit, say), cut short and redacted. */
  pausedReason: string | null
}

export interface DecisionsStatus {
  on: boolean
  /** Which providers have a saved key. */
  keys: Record<string, boolean>
  /** Which providers can be asked: a key saved, or your server's address set (its key is optional). */
  connected: Record<string, boolean>
  /** On, with a chosen model whose provider is connected. */
  ready: boolean
  /** Your models in order, with how each is doing. */
  models: DecisionModelStatus[]
  /** Decisions answered by a model since start-up, and how many of those differed from Atelier's rule. */
  answered: number
  differed: number
  /** The on-device model's optional larger half (atelier-mini): whether it is here, downloading, or can be downloaded. */
  mini?: MiniStatus
  /** atelier-step, the optional model for browser tasks (deviceStep in feature.ts), in the same states as the mini. */
  step?: MiniStatus
}

/**
 * atelier-mini, the on-device model's optional download (src/main/decisions/deviceMini.ts). unavailable: no download
 * for this computer; absent: can be downloaded (total bytes); external: a folder set from outside, not managed here.
 */
export type MiniStatus =
  | { state: 'unavailable' }
  | { state: 'absent'; total: number }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'ready'; external: boolean }
  | { state: 'failed'; error: string; total: number }

export const DECISION_ERROR_CODES = ['no-key', 'unauthorized', 'rate-limited', 'overloaded', 'timeout', 'offline', 'bad-request', 'bad-reply', 'failed'] as const
export type DecisionErrorCode = (typeof DECISION_ERROR_CODES)[number]

export type DecisionTestResult =
  | (DecisionModelRef & { ok: true; answered: string; ms: number })
  | (DecisionModelRef & {
      ok: false
      error: DecisionErrorCode
      detail: string
    })

/** A decision model a provider offers. */
export interface DecisionCatalogModel {
  id: string
  /** US dollars per million tokens read: 0 when free, null when the provider doesn't say. Decisions write nothing, so there is no output price. */
  price: number | null
  /** Listed with zero data retention; null when the provider doesn't say. */
  zdr: boolean | null
}

/** What one connected provider offers. */
export interface DecisionCatalog {
  provider: DecisionProviderId
  models: DecisionCatalogModel[]
  /** Its list couldn't be read (offline, a refused key). */
  failed: boolean
}

/** One place where the model and Atelier's rule disagreed, kept on this computer only (never for private windows). */
export interface DecisionComparison {
  at: number
  use: DecisionCaller
  /** What Atelier's rule decided and what the model decided, as short labels. */
  rule: string
  model: string
  /** The model's probability for its own answer. */
  confidence: number
  /** Whether the model's answer was used ('use' mode and sure) or only noted. */
  applied: boolean
  version: string
  /** The start of what was decided about, with secrets removed. */
  excerpt: string
}

export const COMPARISONS_MAX = 200
export const EXCERPT_MAX = 160

export interface DecisionsServices {
  decisions: {
    status(): Promise<DecisionsStatus>
    /** Saves (or with null, forgets) a provider's key in this computer's secure storage. */
    setKey(provider: string, key: string | null): Promise<DecisionsStatus>
    /** One tiny request to one model (default: your first choice): is it reachable, does the key work, which version answers. */
    test(model?: DecisionModelRef): Promise<DecisionTestResult>
    /** The decision models each connected provider offers, for picking yours. */
    catalog(): Promise<DecisionCatalog[]>
    /** Where the model and the rules disagreed, newest first. */
    comparisons(): Promise<DecisionComparison[]>
    clearComparisons(): Promise<void>
    /** The new tab's composer: would this text be better as a web search or a question for the companion? `current` (the composer's mode) comes back unless a decision model is on and sure. */
    searchOrAsk(text: string, current: 'search' | 'ask'): Promise<'search' | 'ask'>
    openKeyPage(provider: DecisionPresetId): void
    /** atelier-mini: starts its download (the status shows progress), stops it, or removes the installed model. */
    installMini(): Promise<DecisionsStatus>
    cancelMini(): Promise<DecisionsStatus>
    removeMini(): Promise<DecisionsStatus>
    /** atelier-step (browser tasks): the same for its download. */
    installStep(): Promise<DecisionsStatus>
    cancelStep(): Promise<DecisionsStatus>
    removeStep(): Promise<DecisionsStatus>
  }
}
