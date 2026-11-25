/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app } from 'electron'
import type { AppEvent } from '@shared/services'
import { whatsNewFor, type SupportFeed, type UpdateRestartRunning, type UpdatesServices } from '@shared/updates'
import type { MeetingRecorder } from '@shared/meetingCapture'
import { RELEASE } from '@shared/release'
import { WHATS_NEW } from '@shared/whatsNew'
import type { AgentHost } from '../agent/host'
import type { ChatStore } from '../chats'
import type { RoutineRunInfo } from '../features/maintenanceRuntime'
import type { WindowContext } from '../features/types'
import { log } from '../log'
import type { SettingsStore } from '../settings'
import { FakeUpdaterBackend, createElectronUpdaterBackend, type UpdaterBackend } from './backend'
import { createUpdateCards, type UpdateCards } from './cards'
import { ManualClock, systemClock, type Clock } from './clock'
import { UpdateController } from './controller'
import { freeBytes, updaterCacheDir } from './diskSpace'
import { disabledReasonFor } from './machine'
import { ReleaseNoticeBackend, releasePageUrl } from './notices'
import { UpdatesStore } from './store'
import { fetchSupportFeed, supportFeedUrl } from './supportFeed'

// The update service: builds the controller with the real or the fake
// backend, and answers Services.updates. ATELIER_SMOKE=1 picks the fake backend
// on a manual clock, so smoke drives every state with no network and no
// waiting; the real backend runs only in a packaged, signed build. A packaged
// build that is unsigned but knows its release repo gets the notice backend
// instead: it announces a newer release and opens its page (notices.ts).

export interface UpdatesDeps {
  settings: SettingsStore
  /** Saves windows and tabs before quitAndInstall. */
  sessionRestore: { flush(): Promise<void> }
  /** Running chats, for the restart card. */
  agent: AgentHost
  /** Running routines, for the restart card (ctx.maintenance.routines). */
  routines: RoutineRunInfo
  /** The MeetingRecorder (ctx.personal.recorder): an active recording, for the restart card. */
  meetings: MeetingRecorder
  /** Rebuilds the menus on every state change. */
  menus: { invalidate(): void }
  /** userData: where updates.json lives. */
  dataDir: string
  chats: ChatStore
  broadcast(event: AppEvent): void
  /** The focused window gets the restart card and the unsupported prompt. */
  windows: { focused(): WindowContext | null; setQuitting?(quitting: boolean): void }
  /** Opens a page in a tab: the release page, from a build that only announces updates. */
  openPage(url: string): void
  smoke: boolean
  /** Which backend: the fake in smoke, otherwise the real one. */
  backend?: 'fake' | 'real'
}

export type BackendKind = 'fake' | 'real'

/** What the feature and smoke hold: the services plus the parts smoke drives. */
export interface UpdatesRuntime {
  services: UpdatesServices
  controller(): UpdateController
  cards: UpdateCards
  clock: Clock
  /** updates.json, shared by every controller this runtime builds. */
  store: UpdatesStore
  /** The fake backend while it is the one in use. */
  fake: FakeUpdaterBackend | null
  kind: BackendKind
  /** Smoke: what the support feed returns with the fake backend. */
  seedFeed(feed: SupportFeed | null): void
  /** Smoke: the free bytes the fake reports (null is unknown, which never blocks). */
  seedFreeBytes(bytes: number | null): void
  /** Smoke: pretend this much is running (null uses the real counts). */
  overrideRunning(running: UpdateRestartRunning | null): void
  /** Smoke: rebuild the controller on the other backend (the real one is disabled when unpackaged). */
  swap(kind: BackendKind): void
  running(): UpdateRestartRunning
  /** The window the cards open on. */
  focusedWindow(): WindowContext | null
  start(): void
  dispose(): void
}

const ACTIVE_CAPTURE = new Set(['starting', 'recording', 'paused', 'stopping'])
/** The longest a restart waits for a running recording to be saved (the speech broker's own limit for a stop). */
const MEETING_SAVE_MS = 120_000

export function setupUpdates(deps: UpdatesDeps): UpdatesRuntime & { services: UpdatesServices } {
  const smoke = deps.smoke || process.env.ATELIER_SMOKE === '1'
  let kind: BackendKind = deps.backend ?? (smoke ? 'fake' : 'real')
  // Smoke moves time by hand: a 16-minute backoff or the 20 s watchdog take no time.
  const clock: Clock = smoke ? new ManualClock(Date.now()) : systemClock()
  const store = new UpdatesStore(deps.dataDir)
  const cards = createUpdateCards({ focused: () => deps.windows.focused(), smoke })
  let fake: FakeUpdaterBackend | null = null
  let feed: SupportFeed | null = null
  let fakeFree: number | null = null
  let runningOverride: UpdateRestartRunning | null = null

  const running = (): UpdateRestartRunning => {
    if (runningOverride) return { ...runningOverride }
    let chats = 0
    let routines = 0
    let meeting = false
    try {
      chats = deps.chats.list().filter((c) => c.routineId === null && deps.agent.isRunning(c.id)).length
    } catch {
      // The chat store isn't wired in this run.
    }
    try {
      routines = deps.routines.runningCount()
    } catch {
      // Routines aren't wired in this run.
    }
    try {
      meeting = ACTIVE_CAPTURE.has(deps.meetings.status().state)
    } catch {
      // No meeting recorder in this run.
    }
    return { chats, routines, meeting }
  }

  const build = (): UpdateController => {
    const version = app.getVersion()
    fake = kind === 'fake' ? new FakeUpdaterBackend() : null
    const reason =
      kind === 'fake'
        ? null
        : disabledReasonFor({ packaged: app.isPackaged, updatesEnabled: RELEASE.updatesEnabled, platform: process.platform, appImage: Boolean(process.env.APPIMAGE) })
    // Unsigned, but released: it can't install an update, so it looks for one and says so.
    const notices = reason === 'unsigned' && RELEASE.updateNotices ? RELEASE.repo : null
    const disabledReason = notices ? null : reason
    return new UpdateController({
      clock,
      store,
      currentVersion: version,
      disabledReason,
      backend: (): UpdaterBackend | Promise<UpdaterBackend> =>
        fake ?? (notices ? new ReleaseNoticeBackend({ repo: notices, platform: process.platform, currentVersion: version }) : createElectronUpdaterBackend()),
      ...(notices ? { openDownload: (v: string) => deps.openPage(releasePageUrl(notices, v)) } : {}),
      autoDownload: () => deps.settings.get().autoDownloadUpdates,
      freeBytes: () =>
        fake
          ? Promise.resolve(fakeFree)
          : freeBytes(updaterCacheDir({ platform: process.platform, home: app.getPath('home'), localAppData: process.env.LOCALAPPDATA, xdgCache: process.env.XDG_CACHE_HOME })),
      running,
      flushSession: async () => {
        // The restart card asked about a running meeting: stop and save it first, or quitting would throw its audio away.
        if (ACTIVE_CAPTURE.has(deps.meetings.status().state)) {
          await Promise.race([deps.meetings.stop(), new Promise<void>((resolve) => setTimeout(resolve, MEETING_SAVE_MS))]).catch((err: unknown) =>
            log.warn('updates', 'Saving the recording before restarting failed', { error: err instanceof Error ? err.message : String(err) }),
          )
        }
        await deps.sessionRestore.flush()
      },
      askRestart: (r, v) => cards.askRestart(r, v),
      askUnsupported: (below, message) => cards.askUnsupported(below, message),
      supportFeed: async () => {
        if (fake) return feed
        if (!(RELEASE.updatesEnabled || notices) || !RELEASE.repo) return null
        return fetchSupportFeed(supportFeedUrl(RELEASE.repo))
      },
      entries: whatsNewFor(WHATS_NEW, process.platform),
      onStatus: (status) => {
        deps.broadcast({ type: 'update', status })
        deps.menus.invalidate()
      },
      onRestarting: (r) => deps.broadcast({ type: 'update-restarting', running: r }),
      // Only the real updater quits; smoke's fake install never closes a window.
      quitting: (on) => {
        if (kind === 'real') deps.windows.setQuitting?.(on)
      },
    })
  }

  let controller = build()

  const services: UpdatesServices = {
    updates: {
      status: () => controller.status(),
      check: () => controller.check(),
      download: () => controller.download(),
      install: (options) => {
        void controller.install(options).catch((err: unknown) => log.error('updates', 'Install failed', { error: err instanceof Error ? err.message : String(err) }))
      },
      later: () => controller.later(),
      snoozeUnsupported: () => controller.snoozeUnsupported(),
      whatsNew: () => controller.whatsNew()?.entry ?? null,
      dismissWhatsNew: () => controller.dismissWhatsNew(),
      notes: () => controller.notes(),
    },
  }

  return {
    services,
    controller: () => controller,
    cards,
    clock,
    store,
    get fake() {
      return fake
    },
    get kind() {
      return kind
    },
    seedFeed(next) {
      feed = next
    },
    seedFreeBytes(bytes) {
      fakeFree = bytes
    },
    overrideRunning(next) {
      runningOverride = next
    },
    swap(next) {
      controller.dispose()
      kind = next
      controller = build()
      controller.start()
      deps.broadcast({ type: 'update', status: controller.status() })
      deps.menus.invalidate()
    },
    running,
    focusedWindow: () => deps.windows.focused(),
    start() {
      controller.start()
      if (kind === 'real') log.info('updates', 'Updater ready', { disabled: controller.status().disabledReason ?? 'no', manual: controller.status().manual })
    },
    dispose() {
      // A ready update installs on quit; record it so the next start can tell whether it worked.
      if (kind === 'real') controller.recordInstallOnQuit()
      controller.dispose()
    },
  }
}
