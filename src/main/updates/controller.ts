/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SupportFeed, UpdateDisabledReason, UpdateRestartRunning, UpdateStatus, WhatsNewEntry } from '@shared/updates'
import { initialUpdateStatus } from '@shared/updates'
import { formatSize } from '@shared/downloads'
import { log } from '../log'
import { mainT } from '../i18n/mainT'
import type { UpdaterBackend } from './backend'
import { retryDelay } from './backoff'
import type { Clock, TimerHandle } from './clock'
import { hasRoom, shortfall } from './diskSpace'
import { classifyError, reduce, type MachineEvent } from './machine'
import { INSTALL_WATCHDOG_MS, MAX_INSTALL_ATTEMPTS, beginPending, canAttemptInstall, startupOutcome } from './pending'
import { CheckScheduler, type CheckReason } from './schedule'
import type { UpdatesStore } from './store'
import { unsupportedFor } from './supportFeed'
import { notesFor, selectWhatsNew, type WhatsNewCard } from './whatsNew'

// The update controller: wires a backend's events through the pure machine,
// and owns what the machine can't decide alone: consent, the free-space
// check, network backoff, the schedule, the install (pending record, session
// flush, watchdog), the unsupported-version prompt and what's new.

/** How long "Remind me later" on the unsupported prompt lasts. */
export const UNSUPPORTED_SNOOZE_MS = 3 * 24 * 60 * 60_000

/** How often "Restart when they finish" looks again. */
export const IDLE_POLL_MS = 5_000

export interface ControllerDeps {
  clock: Clock
  store: UpdatesStore
  currentVersion: string
  /** Null when this build can update itself. */
  disabledReason: UpdateDisabledReason | null
  /** Built on first use, only when updates are enabled. */
  backend(): UpdaterBackend | Promise<UpdaterBackend>
  autoDownload(): boolean
  /** Free bytes on the updater cache volume; null when unknown. */
  freeBytes(): Promise<number | null>
  running(): UpdateRestartRunning
  flushSession(): Promise<void>
  /** The restart card on the focused window: 'now', 'when-idle', or null when dismissed. */
  askRestart(running: UpdateRestartRunning, version: string | null): Promise<'now' | 'when-idle' | null>
  /** The unsupported prompt: 'update', 'later', or null when dismissed. */
  askUnsupported(below: string, message: string | null): Promise<'update' | 'later' | null>
  /**
   * Set when this build can't install updates itself (unsigned): a newer release is
   * only announced, never downloaded, and download() opens the page it is on.
   */
  openDownload?(version: string): void
  /** The release feed's atelier-support.json, or null. Only called when updates are enabled. */
  supportFeed(): Promise<SupportFeed | null>
  entries: readonly WhatsNewEntry[]
  onStatus(status: UpdateStatus): void
  onRestarting(running: UpdateRestartRunning): void
  /**
   * Atelier is quitting to install (true), or the install failed (false). The
   * native updater closes windows before 'before-quit' fires, so main marks
   * the quit itself: close confirmations stay away and the saved session
   * keeps every window.
   */
  quitting?(on: boolean): void
}

export function isBusy(r: UpdateRestartRunning): boolean {
  return r.chats > 0 || r.routines > 0 || r.meeting
}

type Op = 'check' | 'download' | 'install' | null

export class UpdateController {
  readonly #d: ControllerDeps
  #status: UpdateStatus
  #backend: UpdaterBackend | null = null
  #backendLoading: Promise<UpdaterBackend> | null = null
  readonly #scheduler: CheckScheduler
  #op: Op = null
  #networkFailures = 0
  #retryTimer: TimerHandle | null = null
  #watchdog: TimerHandle | null = null
  #idleTimer: TimerHandle | null = null
  #size = 0
  /** A download the person asked for (autoDownloadUpdates off). */
  #consent = false
  /** The version downloaded in this session; a failed install can go back to ready. */
  #readyVersion: string | null = null
  #checkWaiters: Array<(s: UpdateStatus) => void> = []
  #whatsNew: WhatsNewCard | null = null
  #promptedUnsupported = false
  #quittingForUpdate = false
  #started = false

  constructor(deps: ControllerDeps) {
    this.#d = deps
    this.#status = { ...initialUpdateStatus(deps.currentVersion), disabledReason: deps.disabledReason ?? 'unpackaged', manual: deps.openDownload !== undefined }
    this.#scheduler = new CheckScheduler({
      clock: deps.clock,
      check: (reason) => void this.#scheduledCheck(reason),
      lastCheckAt: () => this.#d.store.get().lastCheckAt,
      lastFailed: () => this.#status.lastCheck === 'failed',
    })
  }

  status(): UpdateStatus {
    return structuredClone(this.#status)
  }

  /** True between quitAndInstall and the watchdog: quit confirmations and background mode should let the app go. */
  get quittingForUpdate(): boolean {
    return this.#quittingForUpdate
  }

  /** Reads the pending record and what's new, then (when enabled) starts the schedule and the support feed. */
  start(): void {
    if (this.#started) return
    this.#started = true
    const file = this.#d.store.get()
    const now = this.#d.clock.now()
    // A first install never shows what's new: remember this version as seen.
    if (file.lastSeenVersion === null) this.#d.store.update({ lastSeenVersion: this.#d.currentVersion })
    this.#computeWhatsNew()
    const snooze = file.unsupportedSnoozeUntil
    if (snooze !== null && snooze <= now) this.#d.store.update({ unsupportedSnoozeUntil: null })

    if (this.#d.disabledReason) {
      this.#dispatch({ type: 'disable', reason: this.#d.disabledReason })
      return
    }
    this.#dispatch({ type: 'enable' })
    const outcome = startupOutcome(file.pending, this.#d.currentVersion)
    if (outcome.kind === 'installed') {
      this.#d.store.update({ pending: null })
      log.info('updates', 'Updated', { version: outcome.version })
    } else if (outcome.kind === 'failed') {
      log.warn('updates', 'The last update did not install', { version: outcome.version, attempts: outcome.attempts })
      this.#dispatch({
        type: 'failed',
        kind: 'install',
        message: outcome.canRetry ? mainT('updates.error.install') : mainT('updates.error.installGaveUp', { count: MAX_INSTALL_ATTEMPTS }),
        attempt: outcome.attempts,
        retryAt: null,
        at: now,
        during: 'install',
        version: outcome.version,
      })
    }
    this.#scheduler.start()
  }

  /** powerMonitor 'resume': checks unless the last check was under an hour ago. */
  wake(): void {
    this.#scheduler.onWake()
  }

  /** The network came back: checks at once after a failure, else under the wake rule. */
  online(): void {
    this.#scheduler.onOnline()
  }

  dispose(): void {
    this.#scheduler.stop()
    this.#clearTimers()
    this.#started = false
  }

  /**
   * On quit with an update ready, electron-updater installs it
   * (autoInstallOnAppQuit), so record it as pending: the next start then
   * knows whether it worked.
   */
  recordInstallOnQuit(): void {
    if (this.#status.phase !== 'ready' || !this.#status.version) return
    const file = this.#d.store.get()
    if (file.pending?.version === this.#status.version) return
    this.#d.store.update({ pending: beginPending(file, this.#status.version, this.#d.clock.now()) })
  }

  // ── checking ──

  /** A manual check (About, the menus, Try again): resets the backoff and resolves with the outcome. */
  check(): Promise<UpdateStatus> {
    return this.#check(true)
  }

  async #scheduledCheck(reason: CheckReason): Promise<void> {
    log.debug('updates', 'Scheduled check', { reason })
    // Each scheduled run starts the backoff afresh; only its own retries count up.
    this.#networkFailures = 0
    await this.#check(false)
    void this.refreshSupport()
  }

  #check(manual: boolean): Promise<UpdateStatus> {
    const s = this.#status
    if (s.phase === 'disabled' || s.phase === 'downloading' || s.phase === 'ready' || s.phase === 'installing') return Promise.resolve(this.status())
    // A failed install with the download still here goes straight back to ready.
    if (s.phase === 'error' && s.error?.kind === 'install' && this.#readyVersion) {
      this.#dispatch({ type: 'downloaded', version: this.#readyVersion })
      return Promise.resolve(this.status())
    }
    if (manual) this.#networkFailures = 0
    this.#d.clock.clearTimeout(this.#retryTimer)
    this.#retryTimer = null
    const done = new Promise<UpdateStatus>((resolve) => this.#checkWaiters.push(resolve))
    if (this.#op === 'check') return done
    this.#op = 'check'
    this.#dispatch({ type: 'checking' })
    void this.#withBackend((b) => b.check())
    return done
  }

  #settleCheck(): void {
    if (this.#op === 'check') this.#op = null
    this.#d.store.update({ lastCheckAt: this.#d.clock.now() })
    this.#scheduler.checked()
    const waiters = this.#checkWaiters
    this.#checkWaiters = []
    const s = this.status()
    for (const w of waiters) w(s)
  }

  // ── downloading ──

  /** The person's go-ahead when autoDownloadUpdates is off (or a retry that should download). */
  download(): void {
    if (this.#d.openDownload) {
      if (this.#status.awaitingConsent && this.#status.version) this.#d.openDownload(this.#status.version)
      else if (this.#status.phase === 'idle' || this.#status.phase === 'error') void this.#check(true)
      return
    }
    this.#consent = true
    if (this.#status.awaitingConsent && this.#status.version) void this.#startDownload(this.#status.version)
    else if (this.#status.phase === 'idle' || this.#status.phase === 'error') void this.#check(true)
  }

  /** autoDownloadUpdates turned on while an update waits. */
  autoDownloadChanged(on: boolean): void {
    if (this.#d.openDownload) return
    if (on && this.#status.awaitingConsent && this.#status.version) void this.#startDownload(this.#status.version)
  }

  async #startDownload(version: string): Promise<void> {
    this.#op = 'download'
    const free = await this.#d.freeBytes().catch(() => null)
    if (!hasRoom(free, this.#size)) {
      this.#fail(new Error('disk-space'), 'disk-space', mainT('updates.error.diskSpace', { size: formatSize(shortfall(free ?? 0, this.#size)) }))
      return
    }
    this.#dispatch({ type: 'download-started', version })
    void this.#withBackend((b) => b.download())
  }

  // ── installing ──

  /**
   * Restart to install. With work still running and no choice made yet, it
   * asks first (the restart card); `whenIdle: true` waits for that work,
   * `whenIdle: false` restarts now.
   */
  async install(options?: { whenIdle?: boolean }): Promise<void> {
    const s = this.#status
    const version = s.version
    const installable = s.phase === 'ready' || (s.phase === 'error' && s.error?.kind === 'install' && this.#readyVersion !== null)
    if (!installable || !version || this.#idleTimer) return
    const running = this.#d.running()
    if (isBusy(running) && options?.whenIdle === undefined) {
      const choice = await this.#d.askRestart(running, version).catch(() => null)
      if (choice === 'now') return this.#restart()
      if (choice === 'when-idle') this.#waitForIdle()
      return
    }
    if (options?.whenIdle && isBusy(running)) {
      this.#waitForIdle()
      return
    }
    await this.#restart()
  }

  /** Puts the ready update off: it installs on the next quit. A "when they finish" wait is dropped. */
  later(): void {
    this.#d.clock.clearTimeout(this.#idleTimer)
    this.#idleTimer = null
  }

  /** Whether a "Restart when they finish" is waiting. */
  get waitingForIdle(): boolean {
    return this.#idleTimer !== null
  }

  #waitForIdle(): void {
    if (this.#idleTimer) return
    const poll = (): void => {
      this.#idleTimer = null
      if (this.#status.phase !== 'ready') return
      if (isBusy(this.#d.running())) this.#idleTimer = this.#d.clock.setTimeout(poll, IDLE_POLL_MS)
      else void this.#restart()
    }
    this.#idleTimer = this.#d.clock.setTimeout(poll, IDLE_POLL_MS)
  }

  async #restart(): Promise<void> {
    const version = this.#status.version
    if (!version) return
    const file = this.#d.store.get()
    if (!canAttemptInstall(file, version)) {
      this.#fail(new Error('install'), 'install', mainT('updates.error.installGaveUp', { count: MAX_INSTALL_ATTEMPTS }), file.pending?.attempts ?? MAX_INSTALL_ATTEMPTS)
      return
    }
    const pending = beginPending(file, version, this.#d.clock.now())
    this.#d.store.update({ pending })
    try {
      await this.#d.flushSession()
    } catch (err) {
      log.warn('updates', "Couldn't save the session before restarting", { error: err instanceof Error ? err.message : String(err) })
    }
    this.#op = 'install'
    this.#dispatch({ type: 'installing' })
    this.#d.onRestarting(this.#d.running())
    this.#quittingForUpdate = true
    this.#d.clock.clearTimeout(this.#watchdog)
    // If Atelier is still here after the watchdog, the install is stuck.
    this.#watchdog = this.#d.clock.setTimeout(() => {
      this.#watchdog = null
      if (this.#status.phase !== 'installing') return
      log.warn('updates', 'The install did not start in time', { version, attempts: pending.attempts })
      this.#fail(new Error('install timed out'), 'install', this.#installMessage(pending.attempts), pending.attempts)
    }, INSTALL_WATCHDOG_MS)
    try {
      const backend = await this.#loadBackend()
      this.#d.quitting?.(true)
      backend.quitAndInstall()
    } catch (err) {
      this.#fail(err, 'install', this.#installMessage(pending.attempts), pending.attempts)
    }
  }

  #installMessage(attempts: number): string {
    return attempts >= MAX_INSTALL_ATTEMPTS ? mainT('updates.error.installGaveUp', { count: MAX_INSTALL_ATTEMPTS }) : mainT('updates.error.install')
  }

  // ── unsupported versions ──

  /** Fetches the support feed and applies it; prompts once per launch unless snoozed. */
  async refreshSupport(feed?: SupportFeed | null): Promise<void> {
    if (this.#status.phase === 'disabled') return
    const loaded = feed === undefined ? await this.#d.supportFeed().catch(() => null) : feed
    const entry = unsupportedFor(loaded, this.#d.currentVersion)
    if (!entry) {
      if (this.#status.unsupported) this.#dispatch({ type: 'unsupported', value: null })
      return
    }
    const now = this.#d.clock.now()
    const until = this.#d.store.get().unsupportedSnoozeUntil
    const snoozedUntil = until !== null && until > now ? until : null
    this.#dispatch({ type: 'unsupported', value: { below: entry.below, message: entry.message, snoozedUntil } })
    if (snoozedUntil !== null || this.#promptedUnsupported) return
    this.#promptedUnsupported = true
    const choice = await this.#d.askUnsupported(entry.below, entry.message).catch(() => null)
    if (choice === 'later') this.snoozeUnsupported()
    else if (choice === 'update') this.updateNow()
  }

  /** "Update now": install a ready update, else fetch it with consent. */
  updateNow(): void {
    if (this.#status.phase === 'ready') void this.install()
    else this.download()
  }

  snoozeUnsupported(): void {
    const until = this.#d.clock.now() + UNSUPPORTED_SNOOZE_MS
    this.#d.store.update({ unsupportedSnoozeUntil: until })
    const u = this.#status.unsupported
    if (u) this.#dispatch({ type: 'unsupported', value: { ...u, snoozedUntil: until } })
  }

  /** Reads updates.json again (smoke: the snooze survives) and re-applies the snooze. */
  reloadStore(): void {
    const file = this.#d.store.reload()
    const u = this.#status.unsupported
    const until = file.unsupportedSnoozeUntil
    if (u) this.#dispatch({ type: 'unsupported', value: { ...u, snoozedUntil: until !== null && until > this.#d.clock.now() ? until : null } })
    this.#computeWhatsNew()
  }

  // ── what's new ──

  whatsNew(): WhatsNewCard | null {
    return this.#whatsNew
  }

  dismissWhatsNew(): void {
    this.#whatsNew = null
    this.#d.store.update({ lastSeenVersion: this.#d.currentVersion, whatsNewShownFor: this.#d.currentVersion })
  }

  notes(): WhatsNewEntry | null {
    return notesFor(this.#d.entries, this.#d.currentVersion)
  }

  #computeWhatsNew(): void {
    const file = this.#d.store.get()
    const current = this.#d.currentVersion
    this.#whatsNew = file.whatsNewShownFor === current ? null : selectWhatsNew(this.#d.entries, file.lastSeenVersion, current)
    // Nothing to show for this version: record it as seen, so the next update compares from here.
    if (!this.#whatsNew && file.lastSeenVersion !== null && file.lastSeenVersion !== current) this.#d.store.update({ lastSeenVersion: current })
  }

  // ── backend events ──

  async #loadBackend(): Promise<UpdaterBackend> {
    if (this.#backend) return this.#backend
    this.#backendLoading ??= Promise.resolve(this.#d.backend()).then((b) => {
      this.#backend = b
      this.#wire(b)
      return b
    })
    return this.#backendLoading
  }

  async #withBackend(fn: (b: UpdaterBackend) => Promise<void>): Promise<void> {
    try {
      await fn(await this.#loadBackend())
    } catch (err) {
      this.#fail(err)
    }
  }

  #wire(b: UpdaterBackend): void {
    b.on('checking', () => this.#dispatch({ type: 'checking' }))
    b.on('available', ({ version, size }) => {
      this.#size = size
      const consent = !this.#d.openDownload && (this.#consent || this.#d.autoDownload())
      this.#dispatch({ type: 'available', version, at: this.#d.clock.now(), awaitingConsent: !consent })
      this.#networkFailures = 0
      this.#settleCheck()
      if (consent) void this.#startDownload(version)
    })
    b.on('not-available', () => {
      this.#networkFailures = 0
      this.#dispatch({ type: 'not-available', at: this.#d.clock.now() })
      this.#settleCheck()
    })
    b.on('progress', ({ percent, bytesPerSecond }) => this.#dispatch({ type: 'progress', percent, bytesPerSecond }))
    b.on('downloaded', ({ version }) => {
      if (this.#op === 'download') this.#op = null
      this.#readyVersion = version
      this.#consent = false
      this.#networkFailures = 0
      this.#dispatch({ type: 'downloaded', version })
    })
    b.on('error', (err) => this.#fail(err))
  }

  #fail(err: unknown, kind = classifyError(err), message?: string, attempt?: number): void {
    const during: 'check' | 'download' | 'install' = this.#op ?? (this.#status.phase === 'installing' ? 'install' : 'check')
    if (during === 'install') {
      this.#d.clock.clearTimeout(this.#watchdog)
      this.#watchdog = null
      if (this.#quittingForUpdate) this.#d.quitting?.(false)
      this.#quittingForUpdate = false
    }
    const now = this.#d.clock.now()
    let retryAt: number | null = null
    let tries = attempt ?? 1
    if (kind === 'network') {
      this.#networkFailures++
      tries = this.#networkFailures
      const delay = retryDelay(this.#networkFailures)
      if (delay !== null) {
        retryAt = now + delay
        this.#d.clock.clearTimeout(this.#retryTimer)
        this.#retryTimer = this.#d.clock.setTimeout(() => {
          this.#retryTimer = null
          void this.#check(false)
        }, delay)
      }
    }
    const text = message ?? (kind === 'network' ? mainT('updates.error.network') : kind === 'signature' ? mainT('updates.error.signature') : kind === 'install' ? mainT('updates.error.install') : mainT('updates.error.unknown'))
    log.warn('updates', 'Update step failed', { kind, during, attempt: tries, error: err instanceof Error ? err.message : String(err) })
    this.#op = null
    this.#dispatch({ type: 'failed', kind, message: text, attempt: tries, retryAt, at: now, during })
    if (during === 'check') this.#settleCheck()
  }

  #clearTimers(): void {
    for (const t of [this.#retryTimer, this.#watchdog, this.#idleTimer]) this.#d.clock.clearTimeout(t)
    this.#retryTimer = this.#watchdog = this.#idleTimer = null
  }

  #dispatch(e: MachineEvent): void {
    const before = this.#status
    const next = reduce(before, e)
    if (next === before) return
    this.#status = next
    // Progress reports whole percents only, so the menus and the pill don't churn.
    if (e.type === 'progress' && before.progress !== null && next.progress !== null && Math.floor(before.progress * 100) === Math.floor(next.progress * 100)) return
    this.#d.onStatus(this.status())
  }
}
