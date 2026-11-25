/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Notification, shell, type Session, type WebContents } from 'electron'
import type { ImportProgress } from '@shared/browserImport'
import { onLanguageChange } from '@shared/i18n/core'
import type { Settings } from '@shared/ipc'
import type { NotificationTarget } from '@shared/notifications'
import type { SettingsServices } from '@shared/services/settings'
import type { ResetStepView } from '@shared/storage'
import { attention, attentionCounts, badgeText, debounced, newlyWaiting } from '../attention'
import { aboutInfo } from '../about'
import { clearBrowsingData } from '../clearData'
import { defaultBrowserStatus, registerDefaultBrowser } from '../defaultBrowser'
import { choiceFromFlags, dockIconImage, flagPatches, migratedDockChoice, resetDockIcon, resolveDockChoice, setDockIcon } from '../dockIcon'
import { toasts } from '../dialogs'
import { mainT } from '../i18n/mainT'
import { detectBrowsers, profileReader, runImport, type ImportSinks } from '../importBrowsers'
import { saveImportedAddresses } from '../importAddresses'
import { extensionImportServices } from '../importExtensionsStore'
import { writeCookies } from '../importCookies'
import { engineId } from '../importFormats'
import { applySessionLanguages, languagesFor, systemOverride, TabLanguages } from '../languages'
import { log } from '../log'
import { createSystemPresenter, systemNotificationStatus } from '../notificationPresenter'
import { notifications } from '../notifications'
import { resetSteps, runResetSteps } from '../reset'
import { hasSettingsDeps, settingsDeps, type SettingsDeps } from '../settingsDeps'
import { writeAtomic } from '../settings'
import { measureStorage, storageCategories } from '../storage'
import { ChatSizes, registerCoreStorage, removeChatImages } from '../coreStorage'
import { clampZoom, zoomPatch } from '../uiZoom'
import { followingLanguages } from './i18n'
import type { AppContext, Feature, WindowContext } from './types'

// Settings, notifications, your data and the kit. The services
// work on the bootstrap's stores (settingsDeps, handed over by index.ts);
// with a fake app (unit tests) they are defined but throw until then.

const BADGE_DEBOUNCE_MS = 400
const MAC_NOTIFICATION_SETTINGS = 'x-apple.systempreferences:com.apple.preference.notifications'
const MAC_FULL_DISK_ACCESS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

interface Runtime {
  ctx: AppContext
  deps: SettingsDeps
  /** Every session, for languages. */
  sessions: Set<Session>
  /** The persistent ones: what Storage measures and clearing reaches (private windows keep nothing). */
  dataSessions: Set<Session>
  tabLanguages: TabLanguages
  sizes: ChatSizes
  importing: boolean
  dispose: Array<() => void>
}

let runtime: Runtime | null = null

function need(): Runtime {
  if (!runtime) throw new Error('Not available yet')
  return runtime
}

/** One-time tips, remembered in tips.json (NS-02). */
function showTipOnce(rt: Runtime, id: string, text: string): void {
  const path = join(rt.ctx.dataDir, 'tips.json')
  let shown: string[] = []
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(raw)) shown = raw.filter((v): v is string => typeof v === 'string')
  } catch {
    // No tips shown yet.
  }
  if (shown.includes(id)) return
  const win = rt.ctx.windows.focused()
  if (!win) return
  toasts.show(win, { kind: 'info', text })
  writeAtomic(path, JSON.stringify([...shown, id]))
}

function focusWindow(win: WindowContext): void {
  if (win.window.isDestroyed()) return
  if (win.window.isMinimized()) win.window.restore()
  win.window.show()
  win.window.focus()
}

function focusTarget(ctx: AppContext, target: NotificationTarget): void {
  const win = (target.windowId !== undefined ? ctx.windows.get(target.windowId) : undefined) ?? ctx.windows.focused()
  if (!win) return
  focusWindow(win)
  if (target.chatId) win.tabs.openInternal(`atelier://chat/${target.chatId}`)
  else if (target.tabId && win.tabs.find(target.tabId)) win.tabs.activate(target.tabId)
  else if (target.url?.startsWith('atelier://')) win.tabs.openInternal(target.url)
  else if (target.url && /^https?:\/\//.test(target.url)) win.tabs.create(target.url)
}

/** The routine notification, which index.ts used to show itself (NS-01). */
export function notifyRoutineResult(routine: { name: string }, run: { ok: boolean; chatId?: string | null }): void {
  notifications.notify({
    category: 'routine-results',
    title: mainT(run.ok ? 'settings.notify.routine.ready' : 'settings.notify.routine.failed', { name: routine.name }),
    body: mainT('settings.notify.routine.body'),
    target: run.chatId ? { chatId: run.chatId } : { url: 'atelier://routines' },
  })
}

function applyZoom(rt: Runtime, settings: Settings): void {
  const factor = clampZoom(settings.uiZoom, 'ui')
  for (const win of rt.ctx.windows.all()) if (!win.chrome.isDestroyed()) win.chrome.setZoomFactor(factor)
}

function applyLanguages(rt: Runtime, settings: Settings): void {
  const list = languagesFor(settings)
  for (const s of rt.sessions) applySessionLanguages(s, list)
  applyTabLanguages(rt, settings)
}

/**
 * What tabs hold: a custom list, or, following the system, the list the
 * header carries (features/i18n.ts puts the app language first) wherever
 * Chromium's own navigator.languages would say otherwise (Linux: glib's 'c').
 */
function applyTabLanguages(rt: Runtime, settings: Settings): void {
  if (settings.languages.mode === 'custom' && settings.languages.list.length > 0) rt.tabLanguages.set(languagesFor(settings))
  else rt.tabLanguages.set(systemOverride(followingLanguages(settings) ?? languagesFor(settings)))
}

/** Smoke runs record what would have been shown instead of showing it (no system UI in checks). */
export const smokeNotified: Array<{ category: string; title: string }> = []

function startNotifications(rt: Runtime): void {
  const { ctx, deps } = rt
  if (ctx.smoke) {
    notifications.setPresenter((spec) => {
      smokeNotified.push({ category: spec.category, title: spec.title })
      return { clear: () => undefined }
    })
    rt.dispose.push(() => notifications.setPresenter(null))
    return
  }
  const appFocused = (): boolean => BrowserWindow.getFocusedWindow() !== null
  const presenter = createSystemPresenter({
    settings: () => ctx.settings.get(),
    mutedChat: (id) => deps.chats.summary(id)?.muted === true,
    chatInView: (id) => appFocused() && ctx.agent.isViewed(id),
    appFocused,
    focusTarget: (target) => focusTarget(ctx, target),
    openSettings: (target) => {
      const win = ctx.windows.focused()
      if (!win) return
      focusWindow(win)
      win.tabs.openInternal(target.url?.startsWith('atelier://') ? target.url : 'atelier://settings/notifications')
    },
    onFirstShown: () => showTipOnce(rt, 'first-notification', mainT('settings.tip.firstNotification')),
  })
  notifications.setPresenter(presenter.present)
  const clearViewed = (): void => presenter.clearViewed()
  deps.chats.on('changed', clearViewed)
  app.on('browser-window-focus', clearViewed)
  rt.dispose.push(() => {
    notifications.setPresenter(null)
    deps.chats.off('changed', clearViewed)
    app.off('browser-window-focus', clearViewed)
  })
}

function startAttention(rt: Runtime): void {
  const { ctx, deps } = rt
  const badge = debounced<number>(BADGE_DEBOUNCE_MS, (unread) => {
    if (process.platform === 'darwin') app.dock?.setBadge(badgeText(unread))
    else app.setBadgeCount(unread)
  })
  const offChange = attention.onChange((s) => badge.push(s.unread))
  const flashing = new Set<BrowserWindow>()
  attention.setRequester(() => {
    if (ctx.smoke) return
    if (process.platform === 'darwin') {
      app.dock?.bounce('critical')
      return
    }
    for (const win of ctx.windows.all()) {
      if (win.window.isDestroyed() || win.window.isFocused()) continue
      win.window.flashFrame(true)
      flashing.add(win.window)
    }
  })
  const stopFlash = (): void => {
    for (const w of flashing) if (!w.isDestroyed()) w.flashFrame(false)
    flashing.clear()
  }
  app.on('browser-window-focus', stopFlash)

  const statuses = new Map<string, string>()
  const update = (): void => {
    const chats = deps.chats.list()
    const counts = attentionCounts(chats)
    attention.setUnread(counts.unread)
    attention.setNeedsYou(counts.needsYou)
    if (newlyWaiting(statuses, chats).length > 0) attention.request()
    for (const chat of chats) {
      if (chat.status === 'finished' && statuses.has(chat.id) && statuses.get(chat.id) !== 'finished') showTipOnce(rt, 'first-done', mainT('settings.tip.firstDone'))
      statuses.set(chat.id, chat.status)
    }
  }
  update()
  deps.chats.on('changed', update)
  rt.dispose.push(() => {
    badge.cancel()
    offChange()
    attention.setRequester(null)
    app.off('browser-window-focus', stopFlash)
    deps.chats.off('changed', update)
  })
}

/** ST-09: the chosen companion and the per-companion flag stay in step; a deleted companion falls back to standard. */
function startDockChoice(rt: Runtime): void {
  const { ctx, deps } = rt
  const flags = (): Array<{ id: string; dockIcon: boolean }> => deps.companions.list().map((c) => ({ id: c.id, dockIcon: c.dockIcon }))
  let syncing = false
  const sync = (choice: Settings['dockIcon']): void => {
    syncing = true
    try {
      for (const p of flagPatches(choice, flags())) deps.companions.update(p.id, { dockIcon: p.dockIcon })
    } finally {
      syncing = false
    }
  }
  const migrated = migratedDockChoice(ctx.settings.get().dockIcon, flags(), deps.companions.activeId())
  if (migrated) ctx.settings.update({ dockIcon: migrated })
  sync(ctx.settings.get().dockIcon)
  if (ctx.settings.get().dockIcon.kind === 'standard') resetDockIcon()

  let before = flags()
  const onCompanions = (): void => {
    const after = flags()
    const current = ctx.settings.get().dockIcon
    if (!syncing) {
      const resolved = resolveDockChoice(current, after)
      const next = resolved !== current ? resolved : choiceFromFlags(current, before, after)
      if (next) ctx.settings.update({ dockIcon: next })
      else sync(current)
    }
    before = flags()
  }
  const onSettings = (next: Settings, previous: Settings): void => {
    if (JSON.stringify(next.dockIcon) === JSON.stringify(previous.dockIcon)) return
    sync(next.dockIcon)
    before = flags()
    if (next.dockIcon.kind === 'standard') {
      resetDockIcon()
      ctx.broadcast({ type: 'dock-icon', kind: 'standard', companionId: null })
    }
  }
  deps.companions.on('changed', onCompanions)
  ctx.settings.on('changed', onSettings)
  rt.dispose.push(() => {
    deps.companions.off('changed', onCompanions)
    ctx.settings.off('changed', onSettings)
  })
}

function applyDockImage(companionId: string | null, dataUrl: string): boolean {
  const rt = need()
  const choice = rt.ctx.settings.get().dockIcon
  // A late render for a choice that has since changed is dropped.
  if (choice.kind !== 'companion' || (companionId !== null && choice.companionId !== companionId)) return false
  if (!setDockIcon(dockIconImage(dataUrl))) return false
  rt.ctx.broadcast({ type: 'dock-icon', kind: 'companion', companionId: choice.companionId })
  return true
}

function importSinks(rt: Runtime): ImportSinks {
  const { ctx, deps } = rt
  return {
    bookmarks: (items) => deps.bookmarks.addMany(items),
    history: (items) => deps.history.importMany(items),
    tabs: (items) => {
      const win = ctx.windows.focused()
      if (!win) return 0
      const open = new Set(win.tabs.all().map((t) => (t.view.webContents.isDestroyed() ? '' : t.view.webContents.getURL())))
      let added = 0
      for (const tab of items) {
        if (open.has(tab.url)) continue
        win.tabs.create(tab.url, { activate: false, ...(tab.pinned ? { pinned: true } : {}) })
        open.add(tab.url)
        added++
      }
      return added
    },
    searchEngines: (items) => {
      const current = ctx.settings.get().customSearchEngines
      const taken = new Set(['google', 'duckduckgo', 'bing', ...current.map((e) => e.id)])
      const templates = new Set(current.map((e) => e.template))
      const next = [...current]
      for (const engine of items) {
        if (templates.has(engine.template) || next.length >= 50) continue
        const id = engineId(engine.name, taken)
        taken.add(id)
        templates.add(engine.template)
        next.push({ id, name: engine.name, template: engine.template })
      }
      const added = next.length - current.length
      if (added > 0) ctx.settings.update({ customSearchEngines: next })
      return added
    },
    // Into the one wallet (passwords feature); a near-copy fills in the saved
    // one, so the count is only the addresses that weren't there. A wallet the
    // keychain can't open fails this type alone.
    addresses: (items) => saveImportedAddresses(ctx.personal.wallet, items).added,
    // The import runs into the asking window's profile (ST-46): set the
    // signed-in sessions into that window's session. The count is the number
    // of sites; writeCookies logs imported/skipped but never a value.
    cookies: async (items) => {
      const win = ctx.windows.focused()
      if (!win || win.window.isDestroyed()) return 0
      const result = await writeCookies(win.session.cookies, items, Math.floor(Date.now() / 1000), log)
      return result.sites
    },
  }
}

function openClearDialog(rt: Runtime, win: WindowContext | null): void {
  const target = win ?? rt.ctx.windows.focused()
  if (!target || target.window.isDestroyed()) return
  focusWindow(target)
  const { width, height } = target.window.getContentBounds()
  target.overlay
    .open('clear-data', { kind: 'window', rect: { x: 0, y: 0, width, height } }, {})
    .then((result) => {
      // The overlay renderer has no toast host of its own; the window's toast says it worked.
      if ('value' in result && result.value === 'cleared' && !target.window.isDestroyed()) void toasts.show(target, { kind: 'success', text: mainT('settings.clearData.done') })
    })
    .catch(() => {
      // Until the overlay host lands, the dialog opens on the Privacy page.
      target.tabs.openInternal('atelier://settings/privacy?clear=1')
    })
}

function start(ctx: AppContext, deps: SettingsDeps): Runtime {
  const rt: Runtime = { ctx, deps, sessions: new Set(), dataSessions: new Set(), tabLanguages: new TabLanguages(), sizes: new ChatSizes(ctx.dataDir), importing: false, dispose: [] }
  runtime = rt
  rt.sessions.add(deps.webSession)
  rt.dataSessions.add(deps.webSession)
  startNotifications(rt)
  startAttention(rt)
  startDockChoice(rt)
  // A saved list holds from the start; an app language change reorders the system's (after i18n has switched).
  applyTabLanguages(rt, ctx.settings.get())
  rt.dispose.push(onLanguageChange(() => applyTabLanguages(rt, ctx.settings.get())))
  rt.dispose.push(
    registerCoreStorage({
      dataDir: ctx.dataDir,
      chats: deps.chats,
      sizes: rt.sizes,
      discard: (ids) => ctx.agent.discard(ids),
      history: deps.history,
      bookmarks: deps.bookmarks,
      sessions: () => [...rt.dataSessions],
      stopAll: () => {
        ctx.agent.stopAll()
        deps.stopRoutines()
      },
      removeApiKey: () => ctx.settings.setApiKey(null),
    }),
  )
  try {
    rt.dispose.push(ctx.commands.register('clear-data', (win) => openClearDialog(rt, win)))
  } catch (err) {
    log.warn('settings', 'The clear-data command is already registered', { error: err instanceof Error ? err.message : String(err) })
  }
  const onSettings = (next: Settings, previous: Settings): void => {
    if (next.uiZoom !== previous.uiZoom) applyZoom(rt, next)
    if (JSON.stringify(next.languages) !== JSON.stringify(previous.languages)) applyLanguages(rt, next)
  }
  ctx.settings.on('changed', onSettings)
  rt.dispose.push(() => ctx.settings.off('changed', onSettings))
  return rt
}

export const settingsFeature: Feature = {
  name: 'settings',
  app(ctx): SettingsServices & { companion: { setDockIcon(dataUrl: string): boolean } } {
    if (hasSettingsDeps() && !runtime) start(ctx, settingsDeps())
    const zoom = (delta: 1 | -1 | 0): number => {
      const rt = need()
      const url = rt.ctx.windows.focused()?.tabs.active()?.internalUrl ?? null
      const { patch, value } = zoomPatch(url, rt.ctx.settings.get(), delta)
      rt.ctx.settings.update(patch)
      return value
    }
    return {
      uiZoom: { step: (delta) => zoom(delta), reset: () => zoom(0) },
      storage: {
        categories: () => measureStorage(),
        clear: async (id) => {
          const category = storageCategories().find((c) => c.id === id)
          if (!category?.clear) throw new Error('That kind of data can’t be cleared here.')
          await category.clear.run()
        },
        chats: async () => {
          const rt = need()
          const rows = await rt.sizes.rows(rt.deps.chats.list())
          // A chat's prepared attachments count toward its size and its images.
          return rows
            .map((row) => {
              const extra = attachmentSize(rt.ctx, row.chatId)
              return { ...row, bytes: row.bytes + extra.bytes, imageBytes: row.imageBytes + extra.imageBytes }
            })
            .sort((a, b) => b.bytes - a.bytes)
        },
        removeImages: async (options) => {
          const rt = need()
          const result = await removeChatImages({ chats: rt.deps.chats, sizes: rt.sizes, discard: (ids) => rt.ctx.agent.discard(ids) }, options)
          // The attachment store's images for the same chats (or all chats older than the cut-off) go too.
          try {
            result.removed += rt.ctx.content.attachments.pruneImages(options.olderThanDays, options.chatIds)
          } catch {
            // No attachment store (tests, or the attachments feature failed to start): the chat logs' images are still removed.
          }
          return result
        },
        clearBrowsingData: async (request) => {
          const rt = need()
          await clearBrowsingData(request, { sessions: () => [...rt.dataSessions], history: rt.deps.history })
        },
        openClearDialog: () => openClearDialog(need(), null),
      },
      reset: {
        run: async (options) => {
          const rt = need()
          const result = await runResetSteps(options)
          // Restart into the welcome flow; app.exit skips before-quit, so nothing writes the old state back.
          if (!options.dryRun && !rt.ctx.smoke) {
            setTimeout(() => {
              app.relaunch()
              app.exit(0)
            }, 250)
          }
          return result
        },
        steps: (): ResetStepView[] => resetSteps().map((s) => ({ id: s.id, order: s.order, label: s.label, secrets: s.secrets === true })),
      },
      browserImport: {
        browsers: async () => detectBrowsers(process.platform, app.getPath('home'), process.env),
        run: async (request) => {
          const rt = need()
          if (rt.importing) throw new Error(mainT('settings.import.error.busyImport'))
          rt.importing = true
          try {
            const reader = profileReader(process.platform, app.getPath('home'), process.env, request.browserId, request.profileId)
            const summary = await runImport(reader, importSinks(rt), request, (progress: ImportProgress) => rt.ctx.broadcast({ type: 'import-progress', progress }))
            if ((summary.counts.bookmarks ?? 0) + (summary.counts.history ?? 0) > 0) rt.deps.signalImport()
            return summary
          } finally {
            rt.importing = false
          }
        },
        openAccessSettings: () => {
          if (process.platform === 'darwin') void shell.openExternal(MAC_FULL_DISK_ACCESS)
        },
        ...extensionImportServices(() => need().ctx), // ST-46 X, ST-40 R
      },
      defaultBrowser: {
        status: () => defaultBrowserStatus(),
        register: () => registerDefaultBrowser(),
      },
      notificationAccess: {
        status: async () => systemNotificationStatus(),
        openSystemSettings: () => {
          if (process.platform === 'darwin') void shell.openExternal(MAC_NOTIFICATION_SETTINGS)
          else if (process.platform === 'win32') void shell.openExternal('ms-settings:notifications')
        },
        test: () => {
          const rt = need()
          if (!Notification.isSupported()) throw new Error(mainT('settings.notifications.systemOff'))
          new Notification({ title: mainT('settings.notify.test.title'), body: mainT('settings.notify.test.body'), silent: !rt.ctx.settings.get().notifications.sounds }).show()
        },
      },
      dockChoice: {
        apply: (companionId, dataUrl) => applyDockImage(companionId, dataUrl),
      },
      about: { info: () => aboutInfo() },
      // The chrome renders the chosen companion and calls this (ST-09 replaces the active-companion rule).
      companion: { setDockIcon: (dataUrl) => applyDockImage(null, dataUrl) },
    }
  },
  window(win) {
    if (!runtime) return
    win.chrome.setZoomFactor(clampZoom(runtime.ctx.settings.get().uiZoom, 'ui'))
    // Zoom is per origin in Chromium; a reload of the chrome keeps it, a new window needs it once.
    win.chrome.once('did-finish-load', () => {
      if (runtime && !win.chrome.isDestroyed()) win.chrome.setZoomFactor(clampZoom(runtime.ctx.settings.get().uiZoom, 'ui'))
    })
  },
  session(session, info) {
    if (!runtime) return
    runtime.sessions.add(session)
    if (!info.private) runtime.dataSessions.add(session)
    applySessionLanguages(session, languagesFor(runtime.ctx.settings.get()))
  },
  tab(tab) {
    if (!runtime) return
    const wc: WebContents = tab.view.webContents
    return runtime.tabLanguages.track(wc, tab.requestedUrl)
  },
  dispose() {
    for (const off of runtime?.dispose.splice(0) ?? []) {
      try {
        off()
      } catch {
        // Quitting; nothing to do.
      }
    }
    runtime = null
  },
}

/** A chat's prepared attachments, or nothing when the attachment store isn't there. */
function attachmentSize(ctx: AppContext, chatId: string): { bytes: number; imageBytes: number } {
  try {
    return ctx.content.attachments.chatSize(chatId)
  } catch {
    return { bytes: 0, imageBytes: 0 }
  }
}
