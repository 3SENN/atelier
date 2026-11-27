/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { powerMonitor, shell, type WebContents } from 'electron'
import { menus, registerMenuContribution } from '@shared/menuModel'
import { log } from '../log'
import { network } from '../network'
import { sessionRestore } from '../sessionRestore'
import { bindUpdateMenu, primaryAction, runPrimaryAction, updateAppMenuItem, updateHelpItems, updateMenuItems, updatesVisible, type UpdateMenuActions } from '../updates/menu'
import { setupUpdates, type UpdatesRuntime } from '../updates/service'
import type { Feature, WindowContext } from './types'

// The updates feature module: update checks, the restart and what's-new cards, the
// App-menu item, the main menu's banner and Help row, and the commands
// 'check-for-updates' and 'whats-new'. It fills ctx.maintenance.updates (the tray
// reads it). After an update, what's new shows on the window in front once
// the first window has loaded, and stays until the person closes it.

let runtime: UpdatesRuntime | null = null
let unregister: Array<() => void> = []
/** A what's-new card is open: another window loading doesn't open a second one. */
let showingWhatsNew = false

/** Delay before what's new slides in, and before it moves to another window after its own closed. */
const WHATS_NEW_DELAY_MS = 1200

/** Smoke and the tray reach the live updater here; null before start-up. */
export function updatesRuntime(): UpdatesRuntime | null {
  return runtime
}

/** True while Atelier is quitting to install an update: quit confirmations and background mode let it go. */
export function isQuittingForUpdate(): boolean {
  return runtime?.controller().quittingForUpdate ?? false
}

/** A browser window to show what's new on: the one in front, else `win` (never a popup or a chat window). */
function whatsNewWindow(rt: UpdatesRuntime, win: WindowContext | null): WindowContext | null {
  const usable = (w: WindowContext | null): w is WindowContext => Boolean(w && !w.window.isDestroyed() && (w.kind === 'normal' || w.kind === 'private'))
  const front = rt.focusedWindow()
  return usable(front) ? front : usable(win) ? win : null
}

/**
 * Opens what's new if an update armed it. Only the person closing it records
 * the version; when Atelier takes it away (its window closed, a quit) it stays
 * armed, moves to the window in front if there is one, and otherwise shows
 * on the next start.
 */
export async function showWhatsNewIfDue(win: WindowContext | null): Promise<boolean> {
  const rt = runtime
  if (!rt || !rt.controller().whatsNew() || showingWhatsNew) return false
  const target = whatsNewWindow(rt, win)
  const card = rt.controller().whatsNew()
  if (!target || !card) return false
  showingWhatsNew = true
  let seen = false
  try {
    seen = await rt.cards.showWhatsNew(card, target)
    if (seen) rt.controller().dismissWhatsNew()
  } finally {
    showingWhatsNew = false
  }
  if (!seen && target.window.isDestroyed()) {
    setTimeout(() => {
      if (runtime === rt) void showWhatsNewIfDue(null).catch(() => undefined)
    }, WHATS_NEW_DELAY_MS).unref?.()
  }
  return seen
}

/**
 * Opens the release page for a build that only announces updates: in a tab of the browser window in
 * front, else of any other one (never a popup or a chat window), else with the system's handler.
 */
function openReleasePage(windows: { focused(): WindowContext | null; all(): WindowContext[] }, url: string): void {
  const usable = (w: WindowContext | null): w is WindowContext => Boolean(w && !w.window.isDestroyed() && (w.kind === 'normal' || w.kind === 'private'))
  const front = windows.focused()
  const win = usable(front) ? front : windows.all().find(usable)
  if (!win) return void shell.openExternal(url).catch((err: unknown) => log.warn('updates', "Couldn't open the release page", { error: err instanceof Error ? err.message : String(err) }))
  if (win.window.isMinimized()) win.window.restore()
  win.window.show()
  win.window.focus()
  win.tabs.create(url)
}

function whenLoaded(wc: WebContents, fn: () => void): void {
  if (wc.isDestroyed()) return
  if (!wc.isLoading()) fn()
  else wc.once('did-finish-load', fn)
}

export const updatesFeature: Feature = {
  name: 'updates',
  app(ctx) {
    const rt = setupUpdates({
      settings: ctx.settings,
      sessionRestore,
      agent: ctx.agent,
      routines: ctx.maintenance.routines,
      meetings: ctx.personal.recorder,
      menus,
      dataDir: ctx.dataDir,
      chats: ctx.maintenance.chats,
      broadcast: (event) => ctx.broadcast(event),
      windows: ctx.windows,
      openPage: (url) => openReleasePage(ctx.windows, url),
      smoke: ctx.smoke,
    })
    runtime = rt
    showingWhatsNew = false
    ctx.maintenance.updates = rt.services.updates
    const status = () => rt.controller().status()
    const actions: UpdateMenuActions = {
      check: () => void rt.controller().check(),
      download: () => rt.controller().download(),
      install: () => void rt.controller().install(),
    }
    bindUpdateMenu({ status, actions })

    const offSettings = (() => {
      const onChange = (next: { autoDownloadUpdates: boolean }, prev: { autoDownloadUpdates: boolean }): void => {
        if (next.autoDownloadUpdates !== prev.autoDownloadUpdates) rt.controller().autoDownloadChanged(next.autoDownloadUpdates)
      }
      ctx.settings.on('changed', onChange)
      return () => void ctx.settings.off('changed', onChange)
    })()
    const onResume = (): void => rt.controller().wake()
    powerMonitor.on('resume', onResume)

    unregister = [
      offSettings,
      () => void powerMonitor.off('resume', onResume),
      network.onChange((online) => {
        if (online) rt.controller().online()
      }),
      ctx.commands.register('check-for-updates', () => void runPrimaryAction(status(), actions), {
        enabled: () => updatesVisible(status()) && primaryAction(status()) !== 'none',
      }),
      // Help › What's New: the card an update armed, else this version's notes.
      ctx.commands.register('whats-new', async (win) => {
        if (rt.controller().whatsNew()) return void (await showWhatsNewIfDue(win ?? ctx.windows.focused()))
        const entry = rt.controller().notes()
        if (entry) await rt.cards.showWhatsNew({ entry, since: false }, win ?? ctx.windows.focused())
      }),
      registerMenuContribution({ id: 'updates:app', target: 'app', after: 'about', build: () => (updatesVisible(status()) ? [updateAppMenuItem(status(), actions)] : []) }),
      registerMenuContribution({ id: 'updates:main-menu', target: 'main-menu', build: () => updateMenuItems(status()) }),
      registerMenuContribution({ id: 'updates:main-menu-help', target: 'main-menu:help', build: () => updateHelpItems(status()) }),
      () => bindUpdateMenu(null),
    ]
    rt.start()
    return rt.services
  },
  window(win) {
    // Let the window settle before the card slides in (on the window in front, which may be another one).
    whenLoaded(win.chrome, () => {
      setTimeout(() => {
        void showWhatsNewIfDue(win).catch((err: unknown) => log.warn('updates', "Couldn't show what's new", { error: err instanceof Error ? err.message : String(err) }))
      }, WHATS_NEW_DELAY_MS).unref?.()
    })
  },
  dispose() {
    for (const off of unregister) off()
    unregister = []
    runtime?.dispose()
    runtime = null
  },
}
