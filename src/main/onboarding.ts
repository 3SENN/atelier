/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The setup flow's store and service (ON-01, ON-11). Progress lives in
// userData/setup.json (version 1), schema-checked on load: an invalid file,
// or one from a newer Atelier, is reset with a notice shown once. Every step is
// saved as you go, so a restart resumes where you left off. Launch starts
// the first chat, seeded from the answers; Atelier never edits the Dock.
import { BRAND_NAME } from '@shared/branding'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  SETUP_FILE_VERSION,
  SETUP_MEMORY_PATH,
  SETUP_STEPS,
  applySetupPatch,
  firstChatSeed,
  freshSetupState,
  type OnboardingMethods,
  type SetupPatch,
  type SetupState,
  type SetupStepId,
} from '@shared/onboarding'
import type { RoutineDraft } from '@shared/routines'
import type { Destination } from '@shared/url'
import { profileFromAnswers, profileMemoryNote, workspacePlan, type PlanDirectoryEntry, type UserProfile, type WorkspacePlan } from '@shared/userProfile'
import type { AgentHostApi } from './agent/hostApi'
import type { QuickModel } from './agent/quick'
import { log } from './log'
import type { ResetStep } from './reset'
import { writeAtomic } from './settings'
import { PROFILE_FILE, applyWorkspace, interviewTurn, profileFromInterview, type UserProfileStore } from './userProfile'

export const SETUP_FILE = 'setup.json'

const answer = z.union([z.string().max(2_000), z.array(z.string().max(200)).max(50), z.null()])
const stepSchema = z.enum(SETUP_STEPS)
const setupSchema = z.object({
  version: z.literal(1),
  step: stepSchema,
  visited: z.array(stepSchema).max(SETUP_STEPS.length * 2),
  answers: z.record(z.string().max(64), answer),
  companionId: z.string().max(64).nullable(),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  finishedAt: z.number().finite().nullable(),
  skipped: z.boolean(),
  notice: z.string().max(500).nullable(),
})

export const NOTICE_INVALID = 'Your setup progress couldn’t be read, so setup starts again from the beginning.'
export const NOTICE_NEWER = `Your setup progress was saved by a newer version of ${BRAND_NAME}, so setup starts again here.`

/** Reads a parsed setup.json: the state, or a fresh one with the reason it was reset. */
export function loadSetupState(raw: unknown, now: number): SetupState {
  if (raw === undefined) return freshSetupState(now)
  const version = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined
  if (typeof version === 'number' && version > SETUP_FILE_VERSION) return freshSetupState(now, null, NOTICE_NEWER)
  const parsed = setupSchema.safeParse(raw)
  if (!parsed.success) return freshSetupState(now, null, NOTICE_INVALID)
  const state = parsed.data as SetupState
  // Duplicates from a hand-edited file are harmless; drop them.
  return { ...state, visited: [...new Set(state.visited.includes(state.step) ? state.visited : [...state.visited, state.step])] }
}

export interface SetupStoreOptions {
  dataDir: string
  now?: () => number
  onChange?(state: SetupState): void
}

export class SetupStore {
  readonly #path: string
  readonly #now: () => number
  readonly #onChange: (state: SetupState) => void
  #state: SetupState

  constructor(options: SetupStoreOptions) {
    this.#path = join(options.dataDir, SETUP_FILE)
    this.#now = options.now ?? Date.now
    this.#onChange = options.onChange ?? (() => undefined)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.#path, 'utf8'))
    } catch (err) {
      // A missing file is a first run; an unreadable one resets.
      raw = (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { version: 0 }
    }
    this.#state = loadSetupState(raw, this.#now())
    if (this.#state.notice) {
      log.warn('onboarding', 'Setup progress was reset', { reason: this.#state.notice === NOTICE_NEWER ? 'newer' : 'invalid' })
      this.#write()
    }
  }

  state(): SetupState {
    return this.#state
  }

  save(patch: SetupPatch): SetupState {
    return this.#set(applySetupPatch(this.#state, patch, this.#now()))
  }

  goTo(step: SetupStepId): SetupState {
    return this.save({ step })
  }

  /** Skip the rest (after the chrome's confirmation): straight to launch. */
  skipRest(): SetupState {
    const next = applySetupPatch(this.#state, { step: 'launch' }, this.#now())
    return this.#set({ ...next, skipped: true })
  }

  /** Start over; with a new companion the next look step adds one instead of editing the current one. */
  restart(options: { newCompanion: boolean }): SetupState {
    const keep = options.newCompanion ? null : this.#state.companionId
    return this.#set(freshSetupState(this.#now(), keep))
  }

  finish(): SetupState {
    const now = this.#now()
    return this.#set({ ...this.#state, step: 'launch', finishedAt: now, updatedAt: now, notice: null })
  }

  /** Reset (ST-55): the file goes and memory holds a fresh state, so a later save never writes the old progress back. */
  forget(): void {
    this.#state = freshSetupState(this.#now())
    rmSync(this.#path, { force: true })
    this.#onChange(this.#state)
  }

  #set(state: SetupState): SetupState {
    this.#state = state
    this.#write()
    this.#onChange(state)
    return state
  }

  #write(): void {
    try {
      writeAtomic(this.#path, `${JSON.stringify(this.#state, null, 2)}\n`)
    } catch (err) {
      log.error('onboarding', 'Could not save setup progress', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export interface SetupResetDeps {
  dataDir: string
  setup: Pick<SetupStore, 'forget'>
  profile: Pick<UserProfileStore, 'clear'>
  /** The setup flow's other files in userData (dismissed tips, the Dock icon design, preset bases), removed with it. */
  files?: readonly string[]
}

/**
 * Reset Atelier's step for the setup flow (ST-55): setup.json, your profile
 * (profile.json) and the given files. The two stores forget what they hold
 * in memory too, so nothing writes them back before the restart.
 */
export function setupResetStep(deps: SetupResetDeps, label: string): ResetStep {
  return {
    id: 'setup',
    order: 80,
    label,
    run: async ({ dryRun }) => {
      const names = [SETUP_FILE, PROFILE_FILE, ...(deps.files ?? [])]
      const removed = names.filter((name) => existsSync(join(deps.dataDir, name)))
      if (!dryRun) {
        deps.setup.forget()
        deps.profile.clear()
        for (const name of deps.files ?? []) rmSync(join(deps.dataDir, name), { recursive: true, force: true })
      }
      return { removed }
    },
  }
}

export interface OnboardingDeps {
  store: SetupStore
  host: Pick<AgentHostApi, 'startChat'>
  /** The companion launch chats with when setup didn't record one. */
  activeCompanionId(): string
  companionExists(id: string): boolean
  /** ON-18: your profile, the setup conversation and the workspace it asks for. */
  profile: ProfileDeps
}

export interface ProfileDeps {
  store: UserProfileStore
  quick: Pick<QuickModel, 'ready' | 'json'>
  companionName(id: string): string | null
  language(): 'en' | 'nl'
  /** Built-in skill names. */
  skills(): readonly string[]
  directory(): readonly PlanDirectoryEntry[]
  /** The sidebar rows as they are now. */
  destinations(): Record<Destination, boolean>
  setDestinations(next: Record<Destination, boolean>): void
  saveRoutine(draft: RoutineDraft): unknown
  timeZone(): string | null
  /** Writes a shared memory note (the About me note). */
  writeMemory(path: string, text: string): void
  /** What you are called (Settings › You › Name): the one place your name is kept. Absent in tests that don't need it. */
  userName?(): string
  setUserName?(name: string): void
}

/** The onboarding methods added here; the original `complete` stays in index.ts. */
export function createOnboardingService(deps: OnboardingDeps): OnboardingMethods {
  const { store, profile: you } = deps
  /** The companion setup made, or the active one: who talks in the conversation and owns the routines. */
  const companionId = (): string => {
    const id = store.state().companionId
    return id && deps.companionExists(id) ? id : deps.activeCompanionId()
  }
  const interview = {
    quick: you.quick,
    companionName: () => you.companionName(companionId()) ?? 'your companion',
    language: you.language,
    companionId,
    skills: you.skills,
  }
  const planFor = (p: UserProfile): WorkspacePlan => workspacePlan(p, { directory: you.directory(), skills: you.skills(), companionId: companionId(), timeZone: you.timeZone() }, you.destinations())
  /** Saves the profile and rewrites the About me note companions read. Your name is not kept here: Settings › You
   *  holds it (setup's name fills it in when it is empty), so there is one place to change it. */
  const keep = (p: UserProfile): UserProfile => {
    if (p.name && you.setUserName && !you.userName?.().trim()) you.setUserName(p.name.slice(0, 40))
    const saved = you.store.set(you.setUserName ? { ...p, name: null } : p)
    const note = profileMemoryNote(saved)
    if (note) {
      try {
        you.writeMemory(SETUP_MEMORY_PATH, note)
      } catch (err) {
        log.warn('profile', 'The About me note couldn’t be written', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return saved
  }
  return {
    state: () => store.state(),
    save: (patch) => store.save(patch),
    goTo: (step) => store.goTo(step),
    skipRest: () => void store.skipRest(),
    restart: (options) => store.restart(options),
    async launch() {
      const state = store.state()
      const companionId = state.companionId && deps.companionExists(state.companionId) ? state.companionId : deps.activeCompanionId()
      const seed = firstChatSeed(state.answers)
      try {
        // An empty id lets the host pick the active companion.
        const chatId = deps.host.startChat(seed.text, { ...(companionId ? { companionId } : {}), ...(seed.context ? { context: seed.context } : {}), open: 'page' })
        store.finish()
        return { ok: true, chatId }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log.warn('onboarding', 'The first chat could not start', { error })
        return { ok: false, chatId: null, error }
      }
    },
    stepTimeout(step) {
      // The diagnostics log keeps it; the chrome offers to continue.
      log.warn('onboarding', 'A setup step took too long to load', { step, afterMs: 45_000 })
    },
    interviewTurn: (lines) => interviewTurn(interview, lines),
    async finishInterview(lines) {
      const now = Date.now()
      const cards = profileFromAnswers(store.state().answers, now)
      const fromChat = lines ? await profileFromInterview(interview, lines, now) : null
      // What the cards asked (your name) fills in what the conversation didn't.
      const saved = keep(fromChat ? { ...fromChat, name: fromChat.name ?? cards.name } : cards)
      return { profile: saved, plan: planFor(saved) }
    },
    profile: () => you.store.get(),
    saveProfile: (p) => keep({ ...p, updatedAt: Date.now() }),
    clearProfile: () => you.store.clear(),
    plan() {
      const p = you.store.get()
      return p ? planFor(p) : null
    },
    applyPlan(choice) {
      const p = you.store.get()
      if (!p) return { routines: 0 }
      return applyWorkspace(planFor(p), choice, you.destinations(), { setDestinations: you.setDestinations, saveRoutine: you.saveRoutine })
    },
  }
}
