/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Updates: background update checks, prompts and install (UP-01, UP-02),
// plus what's new.
// Updates are app-wide: profiles never get their own updater.

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'

export type UpdateErrorKind = 'network' | 'disk-space' | 'signature' | 'install' | 'unknown'

/**
 * Why updates are off for this build. Unpackaged builds hide the About section (ST-56), and so do unsigned
 * ones without update notices (RELEASE.updateNotices); with them, an unsigned build runs with `manual` set.
 */
export type UpdateDisabledReason = 'unpackaged' | 'unsigned' | 'unsupported-package'

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  /** The version being offered, downloaded or installed; null when none. */
  version: string | null
  /** 0..1 while downloading. */
  progress: number | null
  bytesPerSecond: number | null
  checkedAt: number | null
  lastCheck: 'up-to-date' | 'available' | 'failed' | null
  /** autoDownloadUpdates is off: the download waits for updates.download(). */
  awaitingConsent: boolean
  error: {
    kind: UpdateErrorKind
    message: string
    attempt: number
    retryAt: number | null
  } | null
  /** This version is below the release feed's supported floor (atelier-support.json). */
  unsupported: { below: string; message: string | null; snoozedUntil: number | null } | null
  disabledReason: UpdateDisabledReason | null
  /**
   * This build can't install updates itself (unsigned): it only announces a newer
   * release, and updates.download() opens the page its installer is on.
   */
  manual: boolean
}

export interface WhatsNewEntry {
  version: string
  /** YYYY-MM-DD. */
  date: string
  title: string
  /** `platforms`: only there (a Mac-only feature); `windows`: the body as Windows says it (no Finder, no Mac). */
  highlights: Array<{ title: string; body: string; platforms?: readonly WhatsNewPlatform[]; windows?: string }>
}

export type WhatsNewPlatform = 'darwin' | 'win32' | 'linux'

/** The entries as `platform` shows them: highlights for other systems left out, Windows' wording on Windows. */
export function whatsNewFor(entries: readonly WhatsNewEntry[], platform: string): WhatsNewEntry[] {
  return entries.map((e) => ({
    ...e,
    highlights: e.highlights
      .filter((h) => !h.platforms || (h.platforms as readonly string[]).includes(platform))
      .map(({ title, body, windows }) => ({ title, body: platform === 'win32' && windows ? windows : body })),
  }))
}

/** What is still running when an update restart is asked for; the restart card lists it. */
export interface UpdateRestartRunning {
  chats: number
  routines: number
  meeting: boolean
}

/** The status before the updater has said anything: off until the update machine decides. */
export function initialUpdateStatus(currentVersion: string): UpdateStatus {
  return {
    phase: 'disabled',
    currentVersion,
    version: null,
    progress: null,
    bytesPerSecond: null,
    checkedAt: null,
    lastCheck: null,
    awaitingConsent: false,
    error: null,
    unsupported: null,
    disabledReason: 'unpackaged',
    manual: false,
  }
}

/** The release feed's `atelier-support.json`; fetched only when the build checks for updates. */
export interface SupportFeed {
  schema: 1
  /** `below` is a semver x.y.z: every version under it is unsupported. */
  unsupported: Array<{ below: string; message?: string }>
}

/** `userData/updates.json`. */
export interface UpdatesFile {
  pending: { version: string; startedAt: number; attempts: number } | null
  lastSeenVersion: string | null
  whatsNewShownFor: string | null
  unsupportedSnoozeUntil: number | null
  lastCheckAt: number | null
}

export const EMPTY_UPDATES_FILE: UpdatesFile = {
  pending: null,
  lastSeenVersion: null,
  whatsNewShownFor: null,
  unsupportedSnoozeUntil: null,
  lastCheckAt: null,
}

export interface UpdatesServices {
  updates: {
    status(): UpdateStatus
    check(): Promise<UpdateStatus>
    /** Starts the download when it waits for consent; a `manual` build opens the release page instead. */
    download(): void
    /** Saves session state, emits update-restarting, then quits and installs. `whenIdle` waits for running work. */
    install(options?: { whenIdle?: boolean }): void
    /** Puts the ready update off until the next quit. */
    later(): void
    /** Remind me later on the unsupported-version prompt (3 days). */
    snoozeUnsupported(): void
    /** The card to show once after an update; null when there is none. */
    whatsNew(): WhatsNewEntry | null
    dismissWhatsNew(): void
    /** The current version's entry, for Help › What's New. */
    notes(): WhatsNewEntry | null
  }
}

export type UpdatesEvent =
  | { type: 'update'; status: UpdateStatus }
  | { type: 'update-restarting'; running: UpdateRestartRunning }
