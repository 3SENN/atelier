/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process'
import { powerMonitor } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AutoGroupResult, SplitServiceAdditions, TabServices, TabsServiceAdditions } from '@shared/services/tabs'
import { UI } from '@shared/ipc'
import { OMNIBOX_GROUPS, matchRanges, textScore } from '@shared/omnibox'
import { isInternalUrl, samePage } from '@shared/url'
import type { SplitZonesBlock } from '@shared/tabs'
import { APP_ORIGIN, devRendererUrl } from '../appProtocol'
import { decider } from '../decisions/service'
import { toasts } from '../dialogs'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { omnibox } from '../omnibox'
import { groupTabs } from '../tabAutoGroup'
import { captureTracker } from '../capture'
import { MediaSessions } from '../mediaSessions'
import { AutoPip } from '../pip'
import { chatIdOf } from '../tabState'
import { EDITED_FORMS_SCRIPT, TabSleeper, canSleep } from '../tabSleep'
import { ResourceWatch, onResourceChange, readPressure, resourceState, setResourceWatch, sleepMinutesNow } from '../resourceSaver'
import { isServing } from '../packs/serving'
import { TearOff } from '../tearOff'
import { SETTLE_MS, ThumbnailCache } from '../thumbnails'
import { stubs } from './stub'
import type { AppContext, Feature, ServiceParts, WindowContext } from './types'

// Tabs, groups, the sidebar and split. Every service acts on the
// window that asked (WindowContext); the commands act on the focused one.

/** Stand-ins, kept for tests that build services without a window. */
export const TABS_ADDITIONS: TabsServiceAdditions = stubs<TabsServiceAdditions>(['setSelection', 'moveToNewWindow', 'moveToWindow', 'thumbnail', 'recent', 'switcherHover'])

export const SPLIT_ADDITIONS: SplitServiceAdditions = stubs<SplitServiceAdditions>(['openUrl', 'setRatio', 'reset', 'closeSide', 'separate', 'choose'])

/** The isolated world the edited-forms check runs in. */
const FORMS_WORLD = 1006

interface WindowParts {
  thumbnails: ThumbnailCache
  dispose(): void
}

let app: AppContext | null = null
let tearOff: TearOff | null = null
/** A check can't move a real drag's pointer, so smoke steers the tear-off's (screen px); null hands it back. */
let smokeCursor: { x: number; y: number } | null = null
export function steerTabDrag(point: { x: number; y: number } | null): void {
  smokeCursor = point
}
const perWindow = new Map<number, WindowParts>()
const appDisposers: (() => void)[] = []

function windowOf(win: WindowContext | null): WindowContext | null {
  return win ?? app?.windows.focused() ?? null
}

/** Why a dragged tab can't drop on the split zones right now (SH-30). */
function splitBlock(win: WindowContext, tabId: string): SplitZonesBlock {
  if (win.tabs.split()) return 'already-split'
  const tab = win.tabs.find(tabId)
  if (tab?.agentControlled) return 'agent'
  const active = win.tabs.active()
  const chatIds = [tab?.agentChatId ?? null, chatIdOf(active?.internalUrl ?? null)].filter((id): id is string => id !== null)
  if (chatIds.some((id) => app?.agent.isRunning(id))) return 'replying'
  return null
}

function registerCommands(ctx: AppContext): void {
  // Test contexts can come without a command registry.
  if (typeof ctx.commands?.register !== 'function') return
  const register = (id: Parameters<typeof ctx.commands.register>[0], run: (win: WindowContext) => void): void => {
    try {
      appDisposers.push(ctx.commands.register(id, (w) => {
        const win = windowOf(w)
        if (win) run(win)
      }))
    } catch (err) {
      // Another feature registered it first; theirs stays.
      log.warn('tabs', `Command ${id} was already registered`, { error: err instanceof Error ? err.message : String(err) })
    }
  }
  register('new-tab-in-group', (win) => {
    win.tabs.newTabInGroup()
    // After the batched tab snapshot, so the bar opens on the new tab (see menu.ts focusAddressAfterTabs).
    setImmediate(() => {
      if (!win.chrome.isDestroyed()) win.chrome.send(UI.command, 'focus-omnibox')
    })
  })
  register('move-tab-up', (win) => win.tabs.moveActive(-1))
  register('move-tab-down', (win) => win.tabs.moveActive(1))
  register('toggle-split', (win) => (win.tabs.split() ? win.tabs.closeSplit() : win.tabs.openSplit()))
  register('group-tabs', (win) => void autoGroup(win).catch((err: unknown) => log.warn('tabs', 'Group tabs failed', { error: err instanceof Error ? err.message : String(err) })))
  // ⌘W with a selection closes the selection, before the active tab (never more than one target per press).
  appDisposers.push(
    ctx.commands.intercept('close-tab', {
      when: (w) => {
        const win = windowOf(w)
        return win !== null && win.tabs.rail() === null && win.tabs.selection().length > 1 && win.window.isFocused()
      },
      run: (w) => {
        windowOf(w)?.tabs.closeSelection()
      },
    }),
  )
}

// ── DC-18 Group tabs ──
const autoUndo = new Map<string, () => void>()
/** Undo stays offered for the last few runs only. */
const AUTO_UNDO_KEEP = 10
const autoRuns = new Map<number, Promise<AutoGroupResult>>()

/**
 * "Group tabs" in a window, for the tab menus, the command and the command
 * bar (src/main/tabAutoGroup.ts): one run per window at a time, its outcome
 * in a toast with Undo.
 */
function autoGroup(win: WindowContext, only?: readonly string[]): Promise<AutoGroupResult> {
  const running = autoRuns.get(win.id)
  if (running) return running
  const run = (async (): Promise<AutoGroupResult> => {
    const { tabs } = win
    const done = await groupTabs(tabs, tabs.all().map((t) => tabs.info(t)), {
      isPrivate: win.kind === 'private',
      only,
      topicName: (topic) => mainT(`tabs.topic.${topic}`),
      // The model takes a few seconds for many tabs; the result's toast replaces this one.
      asking: () => void toasts.show(win, { kind: 'info', text: mainT('tabs.autoGroup.working') }).catch(() => undefined),
    })
    let undo: string | null = null
    if (done.tabs > 0) {
      const id = randomUUID()
      undo = id
      autoUndo.set(id, () => {
        if (!win.window.isDestroyed()) done.undo()
      })
      for (const old of [...autoUndo.keys()].slice(0, -AUTO_UNDO_KEEP)) autoUndo.delete(old)
    }
    if (!win.window.isDestroyed()) {
      const text = done.tabs > 0 ? mainT('tabs.autoGroup.done', { tabs: done.tabs, groups: done.groups }) : mainT(done.byTopic ? 'tabs.autoGroup.nothingTopic' : 'tabs.autoGroup.nothing')
      void toasts.show(win, { kind: done.tabs > 0 ? 'success' : 'info', text, ...(undo ? { undo: () => undoAutoGroup(undo) } : {}) }).catch(() => undefined)
    }
    return { tabs: done.tabs, groups: done.groups, undo }
  })().finally(() => autoRuns.delete(win.id))
  autoRuns.set(win.id, run)
  return run
}

function undoAutoGroup(id: string): void {
  const undo = autoUndo.get(id)
  autoUndo.delete(id)
  undo?.()
}

/** The command bar's Group tabs row, saying how it will group in this window. */
function registerGroupRow(ctx: AppContext): void {
  try {
    appDisposers.push(
      omnibox.registerProvider({
        id: 'tabs.group',
        group: OMNIBOX_GROUPS.commands,
        order: 81,
        maxRows: 1,
        query: async (text, q) => {
          const title = mainT('tabs.autoGroup.command')
          // Word starts only, so short fragments don't keep offering it.
          if (textScore(title, '', text) < 55) return []
          // Compare mode asks the model but keeps grouping by site.
          const byTopic = decider().active('tabs') && ctx.settings.get().decisions.mode === 'use' && ctx.windows.get(q.windowId)?.kind !== 'private'
          return [{ id: 'commands:command:group-tabs', group: OMNIBOX_GROUPS.commands, title, subtitle: mainT(byTopic ? 'tabs.autoGroup.byTopic' : 'tabs.autoGroup.bySite'), icon: 'command', match: matchRanges(title, text.trim()), action: { kind: 'command', id: 'group-tabs' } }]
        },
      }),
    )
  } catch (err) {
    log.warn('tabs', 'The Group tabs row was already registered', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The services, acting on `current()`: the window itself for window-scoped
 * parts, the focused window for the app-wide fallbacks.
 */
function windowServices(ctx: AppContext, current: () => WindowContext): ServiceParts {
  const sameSessionWindow = (id: number): WindowContext => {
    const win = current()
    const target = ctx.windows.get(id)
    if (!target || target.window.isDestroyed()) throw new Error('That window is no longer open.')
    if (target.session !== win.session || target.kind === 'popup') throw new Error('Tabs can’t move between private and normal windows.')
    return target
  }
  const moveInto = (target: WindowContext, tabIds: readonly string[], index?: number): void => {
    const { tabs } = current()
    tabIds.forEach((id, i) => {
      if (!tabs.find(id)) return
      target.tabs.adopt(tabs.release(id), index === undefined ? undefined : index + i)
    })
  }
  const tabsOf = () => current().tabs
  const tabsParts: TabsServiceAdditions = {
    setSelection: (ids) => tabsOf().setSelection(ids),
    moveToNewWindow: (tabIds) => {
      const win = current()
      if (win.tabs.all().length <= 1) throw new Error('This is the window’s only tab.')
      const id = ctx.windows.open(win.kind === 'private' ? 'private' : 'normal')
      const target = sameSessionWindow(id)
      const starting = target.tabs.all().map((t) => t.id)
      moveInto(target, tabIds)
      for (const s of starting) if (target.tabs.find(s) && target.tabs.all().length > 1) target.tabs.close(s)
      return id
    },
    moveToWindow: (tabIds, windowId, index) => {
      if (windowId === current().id) return
      moveInto(sameSessionWindow(windowId), tabIds, index)
    },
    thumbnail: async (tabId) => {
      const win = current()
      const wc = win.tabs.get(tabId).view.webContents
      const cache = perWindow.get(win.id)?.thumbnails
      if (!cache) return win.tabs.capture(tabId, win.chrome)
      // A background tab playing video gets a throttled live frame while hovered.
      return cache.get(tabId, { live: !wc.isDestroyed() && wc.isCurrentlyAudible() })
    },
    recent: () => tabsOf().recent(),
    reveal: (tabId) => {
      const here = current()
      const owner = ctx.windows.get(ctx.tabsRegistry.windowOf(tabId) ?? -1)
      if (owner && !owner.window.isDestroyed() && owner.tabs.find(tabId)) {
        // The same kind of window only: a link never carries you between private and normal browsing.
        if ((owner.kind === 'private') !== (here.kind === 'private')) return 'gone'
        if (owner.id !== here.id) ctx.windows.focus(owner.id)
        owner.tabs.activate(tabId)
        return 'shown'
      }
      const closed = ctx.tabsRegistry.closedTab(tabId)
      if (!closed || closed.private !== (here.kind === 'private')) return 'gone'
      if (isInternalUrl(closed.url)) here.tabs.openInternal(closed.url, { newTab: true })
      else here.tabs.create(closed.url, { activate: true })
      return 'reopened'
    },
    revealUrl: (url) => {
      const here = current()
      const windows = [here, ...ctx.windows.all().filter((w) => w.id !== here.id && (w.kind === 'private') === (here.kind === 'private') && w.kind !== 'popup')]
      for (const win of windows) {
        const tab = win.tabs.all().find((t) => !t.sandbox && !t.view.webContents.isDestroyed() && samePage(t.view.webContents.getURL() || t.requestedUrl, url))
        if (!tab) continue
        if (win.id !== here.id) ctx.windows.focus(win.id)
        win.tabs.activate(tab.id)
        return true
      }
      return false
    },
    switcherHover: (index) => current().send({ type: 'recent-tabs-hover', index }),
  }
  const splitParts: SplitServiceAdditions = {
    openUrl: (url) => {
      tabsOf().openSplitUrl(url)
    },
    setRatio: (ratio) => tabsOf().setSplitRatio(ratio),
    reset: () => tabsOf().setSplitRatio(0.5),
    closeSide: (side) => tabsOf().closeSplitSide(side),
    separate: () => tabsOf().closeSplit(),
    choose: (tabId) => tabsOf().chooseSplit(tabId),
  }
  const groups: TabServices['tabGroups'] = {
    create: (tabIds, name) => tabsOf().createGroup(tabIds, name),
    update: (id, patch) => tabsOf().updateGroup(id, patch),
    ungroup: (id) => tabsOf().ungroup(id),
    close: (id) => void tabsOf().closeGroup(id),
    addTabs: (id, tabIds) => tabsOf().addToGroup(id, tabIds),
    removeTabs: (tabIds) => tabsOf().removeFromGroup(tabIds),
    newTab: (id) => void tabsOf().newTabInGroup(id),
    auto: (tabIds) => autoGroup(current(), tabIds),
    undoAuto: (id) => undoAutoGroup(id),
  }
  return {
    tabs: tabsParts,
    split: splitParts,
    tabGroups: groups,
    tabMedia: {
      control: (tabId, action) => void media.get(current().id)?.control(tabId, action),
    },
    tabDrag: {
      start: (tabId, list) => tearOff?.start(current(), tabId, list ?? null),
      end: (onList) => tearOff?.end(current(), onList),
      cancel: () => tearOff?.cancel(),
      // Only the window that started the drag can morph its ghost (TearOff checks the source).
      over: (zone) => tearOff?.over(current(), zone),
      // The split zones of any window take part: a tab can split into another window's page.
      zonesSeen: (session) => tearOff?.zonesSeen(session),
      dropOnZone: (session, side) => tearOff?.dropOnZone(current(), session, side),
    },
  }
}

function focusedWindow(): WindowContext {
  const win = app?.windows.focused()
  if (!win) throw new Error('No browser window is open.')
  return win
}

const media = new Map<number, MediaSessions>()

export const tabsFeature: Feature = {
  name: 'tabs',
  app(ctx): ServiceParts {
    app = ctx
    registerCommands(ctx)
    registerGroupRow(ctx)
    tearOff = new TearOff({
      windows: ctx.windows,
      preload: join(__dirname, '../preload/ui.js'),
      uiUrl: () => devRendererUrl() ?? `${APP_ORIGIN}/index.html`,
      thumbnails: (win) => perWindow.get(win.id)?.thumbnails,
      splitBlock,
      reduceMotion: () => ctx.settings.get().reduceMotion,
      cursor: () => (ctx.smoke ? smokeCursor : null),
      broadcast: (event) => {
        for (const w of ctx.windows.all()) w.send(event)
      },
    })
    // The ghost is pre-created once the app is up, so the first drag shows it at once (smoke runs skip it).
    if (!ctx.smoke && process.versions.electron) setTimeout(() => tearOff?.prewarm(), 3000).unref?.()
    // The memory and energy savers (resourceSaver.ts) go by the computer's memory pressure and its power source.
    // Smoke runs keep the state where no saver applies, so a run's tabs sleep by the setting alone.
    if (!ctx.smoke && process.versions.electron) {
      const watch = new ResourceWatch({
        pressure: () =>
          readPressure({
            platform: process.platform,
            sysctl: (name) => new Promise((resolve, reject) => execFile('/usr/sbin/sysctl', ['-n', name], { timeout: 2000 }, (err, out) => (err ? reject(err) : resolve(out)))),
            meminfo: () => readFile('/proc/meminfo', 'utf8'),
            system: () => process.getSystemMemoryInfo(),
          }),
        onBattery: () => powerMonitor.isOnBatteryPower(),
        onPower: (listener) => {
          powerMonitor.on('on-battery', listener)
          powerMonitor.on('on-ac', listener)
          return () => {
            powerMonitor.off('on-battery', listener)
            powerMonitor.off('on-ac', listener)
          }
        },
      })
      setResourceWatch(watch)
      watch.start()
    }
    return windowServices(ctx, focusedWindow)
  },
  window(win): ServiceParts {
    const ctx = app
    if (!ctx) return {}
    const { tabs } = win
    const thumbnails = new ThumbnailCache((id) => tabs.capture(id, win.chrome))
    // Refresh a tab's frame shortly after it is switched to, once it has painted.
    let settle: ReturnType<typeof setTimeout> | null = null
    const onActivated = (tab: { id: string }): void => {
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        if (tabs.activeId() === tab.id && !tabs.isHidden()) void thumbnails.refresh(tab.id)
      }, SETTLE_MS)
    }
    const onClosed = (tab: { id: string }): void => thumbnails.drop(tab.id)
    tabs.on('activated', onActivated)
    tabs.on('closed', onClosed)

    const sessions = new MediaSessions({ tabs, enabled: () => ctx.settings.get().mediaCard })
    media.set(win.id, sessions)
    tabs.setMediaSource(() => sessions.current())

    const pip = win.kind === 'popup' ? null : new AutoPip({ tabs, enabled: () => ctx.settings.get().autoPictureInPicture })

    // The person's setting, brought forward while memory is short or on battery (resourceSaver.ts).
    const sleepMinutes = (): number | null => {
      const s = ctx.settings.get()
      return sleepMinutesNow(s.tabSleepMinutes, resourceState(), { memorySaver: s.memorySaver, energySaver: s.energySaver })
    }
    const sleeper = new TabSleeper({
      minutes: sleepMinutes,
      candidates: (now) => {
        const split = tabs.split()
        const active = tabs.activeId()
        return tabs.all().filter((t) => {
          const info = tabs.info(t)
          const visible = t.id === active || (split !== null && (split.primaryId === t.id || split.secondaryId === t.id))
          const capture = info.capture
          return canSleep(
            {
              visible,
              pinned: t.pinned,
              audible: info.audible,
              // A tab whose screen is being shared stays awake until capture ends.
              // An app running a web server (atelier.server) stays awake too: sleeping would stop it and drop its phones.
              capturing: capture.camera || capture.microphone || capture.screen || captureTracker.isShared(t.id) || isServing(t.view.webContents.id),
              agentControlled: t.agentControlled,
              asleep: tabs.isAsleep(t.id),
              chromeDrawn: tabs.isChromeDrawn(t),
              lastActiveAt: t.lastActiveAt,
            },
            now,
            sleepMinutes(),
          )
        }).map((t) => t.id)
      },
      hasEditedForms: async (id) => {
        const wc = tabs.find(id)?.view.webContents
        if (!wc || wc.isDestroyed()) return true
        return (await wc.executeJavaScriptInIsolatedWorld(FORMS_WORLD, [{ code: EDITED_FORMS_SCRIPT }])) === true
      },
      sleep: (id) => tabs.sleep(id),
    })

    // Memory running short, or the power cable coming out: don't wait for the next minute's check.
    const offResources = onResourceChange((state, before) => {
      if (state.pressure !== 'normal' && state.pressure !== before.pressure) void sleeper.check()
      else if (state.onBattery && !before.onBattery) void sleeper.check()
    })

    const parts: WindowParts = {
      thumbnails,
      dispose: () => {
        if (settle) clearTimeout(settle)
        tabs.off('activated', onActivated)
        tabs.off('closed', onClosed)
        sessions.dispose()
        media.delete(win.id)
        tabs.setMediaSource(null)
        pip?.dispose()
        offResources()
        sleeper.dispose()
      },
    }
    perWindow.set(win.id, parts)
    win.window.once('closed', () => {
      parts.dispose()
      perWindow.delete(win.id)
    })
    return windowServices(ctx, () => win)
  },
  dispose(): void {
    tearOff?.dispose()
    tearOff = null
    for (const off of appDisposers.splice(0)) off()
    for (const parts of perWindow.values()) parts.dispose()
    perWindow.clear()
    app = null
  },
}
