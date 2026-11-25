/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, Menu, type WebContentsView } from 'electron'
import { dirname } from 'node:path'
import type { MainMenuModel } from '@shared/menuBase'
import { flattenMenu } from '@shared/menuBase'
import type { OverlayResult } from '@shared/overlay'
import { UPDATES_SURFACES } from '@shared/overlay/updates'
import { RELEASE } from '@shared/release'
import type { SupportFeed, UpdateStatus } from '@shared/updates'
import { commands } from '../commands'
import type { WindowContext } from '../features/types'
import { isQuittingForUpdate, showWhatsNewIfDue, updatesRuntime } from '../features/updates'
import { loadAutoUpdater } from '../updates/backend'
import { mainT } from '../i18n/mainT'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { SmokeContext } from '../smokeBrowser/types'
import type { FakeUpdaterBackend } from '../updates/backend'
import { RETRY_DELAYS_MS } from '../updates/backoff'
import { ManualClock } from '../updates/clock'
import { IDLE_POLL_MS, UNSUPPORTED_SNOOZE_MS } from '../updates/controller'
import { disabledReasonFor } from '../updates/machine'
import { updateAppMenuItem } from '../updates/menu'
import { INSTALL_WATCHDOG_MS } from '../updates/pending'
import type { UpdatesRuntime } from '../updates/service'
import { UpdatesStore } from '../updates/store'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// FakeUpdaterBackend through every state (checking, up to date, waiting
// for a go-ahead, downloading, ready, installing, failed), with the footer
// pill, the App-menu label, the main-menu banner and About's update row read
// at each; the restart card over running work (the fake quitAndInstall is a
// no-op), the 20 s watchdog, a failed install seen on the next start,
// what's new shown once, and the unsupported prompt's snooze surviving a store
// reload and a restart. Time moves on the runtime's manual clock, so backoff
// and the watchdog take no real time. Offline only: the real backend is only
// ever built disabled.

const MB = 1024 * 1024

function runtime(): UpdatesRuntime {
  const r = updatesRuntime()
  assert(r, 'the updates runtime is not running')
  return r
}

function fake(): FakeUpdaterBackend {
  const f = runtime().fake
  assert(f && runtime().kind === 'fake', 'smoke must update through FakeUpdaterBackend')
  return f
}

function clock(): ManualClock {
  const c = runtime().clock
  assert(c instanceof ManualClock, 'smoke must run the updater on the manual clock')
  return c
}

function status(): UpdateStatus {
  return runtime().controller().status()
}

/** A version newer than this one: the next minor. */
function nextVersion(): string {
  const [major = 0, minor = 0] = app
    .getVersion()
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10) || 0)
  return `${major}.${minor + 1}.0`
}

function win(): WindowContext {
  const w = runtime().focusedWindow()
  assert(w && !w.window.isDestroyed(), 'no focused window for the update cards')
  return w
}

function closeUpdateCards(): void {
  const w = runtime().focusedWindow()
  if (w && !w.window.isDestroyed()) w.overlay.closeAll((s) => (UPDATES_SURFACES as readonly string[]).includes(s))
}

/** A clean updater: no pending record, snooze, feed or seeded disk space, automatic downloads on, a new fake. */
function fresh(ctx: SmokeContext): FakeUpdaterBackend {
  const r = runtime()
  closeUpdateCards()
  r.seedFeed(null)
  r.seedFreeBytes(null)
  r.overrideRunning(null)
  r.store.update({ pending: null, unsupportedSnoozeUntil: null })
  if (!ctx.settings.get().autoDownloadUpdates) ctx.settings.update({ autoDownloadUpdates: true })
  r.swap('fake')
  return fake()
}

async function until(test: (s: UpdateStatus) => boolean, what: string, timeoutMs = 4000): Promise<UpdateStatus> {
  await waitFor(() => test(status()), timeoutMs, what)
  return status()
}

const percentOf = (s: UpdateStatus): number => Math.floor((s.progress ?? 0) * 100)

// ── what the chrome shows ──

async function openAbout(ctx: SmokeContext): Promise<void> {
  ctx.tabs.openInternal('atelier://settings/about')
  await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('#check-updates .about-version'))`, 8000, 'the About page’s version row')
}

/** About's update line reads `text` (or, with null, has no update line or switch at all). */
async function aboutReads(ctx: SmokeContext, text: string | null): Promise<void> {
  if (text === null) {
    await ctx.chrome.until<boolean>(
      `return Boolean(document.querySelector('#check-updates .about-version')) && !document.querySelector('[data-update-line]') && !document.querySelector('[data-update-section]') && !document.querySelector('#auto-download')`,
      5000,
      'About to hide the update section',
    )
    return
  }
  await ctx.chrome.until<boolean>(
    `const el = document.querySelector('[data-update-line]'); return Boolean(el && el.textContent.includes(${JSON.stringify(text)}))`,
    5000,
    `About to read “${text}”`,
  )
}

async function aboutHasButton(ctx: SmokeContext, label: string): Promise<void> {
  await ctx.chrome.until<boolean>(
    `return [...document.querySelectorAll('#check-updates [data-update-section] button')].some((b) => (b.textContent || '').includes(${JSON.stringify(label)}))`,
    5000,
    `About’s ${label} button`,
  )
}

/** The footer pill shows `kind` with `label` (or, with null, is gone). */
async function pillReads(ctx: SmokeContext, kind: string | null, label?: string): Promise<void> {
  if (kind === null) {
    await ctx.chrome.until<boolean>(`return !document.querySelector('[data-update-pill]')`, 5000, 'the update pill to go')
    return
  }
  await ctx.chrome.until<boolean>(
    `const p = document.querySelector('[data-update-pill=${JSON.stringify(kind)}]')
     if (!p) return false
     const text = (p.querySelector('.update-pill__label') || p).textContent.trim()
     return ${label === undefined ? 'true' : `text === ${JSON.stringify(label)}`}`,
    5000,
    `the ${kind} pill${label ? ` to read “${label}”` : ''}`,
  )
}

/** The App menu's update item reads `label`, enabled or not (the native item on macOS, the model elsewhere). */
async function appMenuReads(label: string, enabled: boolean): Promise<void> {
  const model = updateAppMenuItem(status())
  assert(model.label === label, `the App menu item reads “${model.label}”, expected “${label}”`)
  assert((model.enabled ?? true) === enabled, `the App menu item should be ${enabled ? 'enabled' : 'disabled'}`)
  if (process.platform !== 'darwin') return
  await waitFor(
    () => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('update:app')
      return Boolean(item && item.label === label && item.enabled === enabled)
    },
    4000,
    `the native App menu to read “${label}”`,
  )
}

async function mainMenuIds(ctx: SmokeContext): Promise<Map<string, string>> {
  const model = await ctx.chrome.invoke<MainMenuModel>('menus', 'mainMenu')
  return new Map(flattenMenu(model.items).map((i) => [i.id, i.label]))
}

async function bannerReads(ctx: SmokeContext, label: string | null): Promise<void> {
  await waitFor(
    async () => {
      const banner = (await mainMenuIds(ctx)).get('update:banner')
      return label === null ? banner === undefined : banner === label
    },
    4000,
    label === null ? 'the main menu to drop the update banner' : `the main-menu banner to read “${label}”`,
  )
}

/** The interactive overlay tier's document once it draws `selector` (the chrome as its fallback). */
async function drawn(ctx: SmokeContext, selector: string, what: string): Promise<Chrome> {
  let found: Chrome = ctx.chrome
  await waitFor(
    async () => {
      const wc = runtime().focusedWindow()?.overlay.tierWebContents('interactive')
      for (const doc of [...(wc && !wc.isDestroyed() ? [new Chrome(wc)] : []), ctx.chrome]) {
        if (await doc.js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)) {
          found = doc
          return true
        }
      }
      return false
    },
    8000,
    what,
  )
  return found
}

/** What's new is drawn whole (not a sliver sized by its own overlay view), in the window's bottom-right corner, above the page. */
async function cardShows(w: WindowContext): Promise<void> {
  const wc = w.overlay.tierWebContents('interactive')
  const view = w.overlay.interactiveBounds()
  assert(wc && view, 'the overlay view is not showing')
  const card = await new Chrome(wc).js<{ x: number; y: number; width: number; height: number }>(
    `const r = document.querySelector('.update-card--whats-new').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }`,
  )
  assert(card.width >= 300, `the card is squeezed to ${Math.round(card.width)} px wide`)
  const { width, height } = w.window.getContentBounds()
  const right = view.x + card.x + card.width
  const bottom = view.y + card.y + card.height
  assert(right > width - 40 && right <= width && bottom > height - 40 && bottom <= height, `the card is not in the bottom-right corner: ends at ${Math.round(right)}, ${Math.round(bottom)} in ${width}×${height}`)
  const views = w.window.contentView.children
  const page = w.tabs.active()
  assert(page, 'no active tab')
  const overlayAt = views.findIndex((v) => (v as WebContentsView).webContents?.id === wc.id)
  assert(overlayAt > views.indexOf(page.view), 'the card is under the page')
}

async function gone(doc: Chrome, selector: string, what: string): Promise<void> {
  await doc.until<boolean>(`return !document.querySelector(${JSON.stringify(selector)})`, 5000, what)
}

// ── scenes (shared by the checks and the shots) ──

async function toDownloading(ctx: SmokeContext): Promise<FakeUpdaterBackend> {
  const f = fresh(ctx)
  f.configure({ available: { version: nextVersion(), size: 80 * MB }, steps: [12, 42], hold: true })
  await runtime().controller().check()
  await until((s) => s.phase === 'downloading' && percentOf(s) === 42 && f.holding, 'the download to reach 42%')
  return f
}

async function toReady(ctx: SmokeContext): Promise<FakeUpdaterBackend> {
  const f = fresh(ctx)
  f.configure({ available: { version: nextVersion(), size: 80 * MB }, steps: [40, 100] })
  await runtime().controller().check()
  await until((s) => s.phase === 'ready', 'the update to be ready')
  return f
}

async function toNetworkError(ctx: SmokeContext): Promise<FakeUpdaterBackend> {
  const f = fresh(ctx)
  f.configure({ failChecks: 6 })
  await runtime().controller().check()
  await until((s) => s.phase === 'error' && s.error?.kind === 'network', 'a network failure')
  return f
}

const BUSY = { chats: 2, routines: 1, meeting: true }

/** Ready, with work running: install() asks with the restart card. Returns the card's document and the install promise. */
async function openRestartCard(ctx: SmokeContext): Promise<{ doc: Chrome; done: Promise<void> }> {
  await toReady(ctx)
  runtime().overrideRunning({ ...BUSY })
  const done = runtime().controller().install()
  const doc = await drawn(ctx, '.update-card--restart', 'the restart card')
  return { doc, done }
}

async function press(doc: Chrome, scope: string, label: string): Promise<void> {
  const ok = await doc.js<boolean>(
    `const root = document.querySelector(${JSON.stringify(scope)})
     const b = root && [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)} || x.getAttribute('aria-label') === ${JSON.stringify(label)})
     if (b) b.click()
     return Boolean(b)`,
  )
  assert(ok, `no “${label}” button in ${scope}`)
}

const UNSUPPORTED_FEED: SupportFeed = { schema: 1, unsupported: [{ below: '999.0.0' }] }

// ── checks ──

export const checks: SmokeCheck[] = [
  {
    // Every release up to 1.6.0 read electron-updater's named export, which is undefined when the
    // built main process imports it, so no update check could ever run. This loads it the same way
    // the real backend does, without checking for anything.
    name: 'updates: the real updater loads in this build (electron-updater’s autoUpdater is there)',
    async run() {
      const updater = await loadAutoUpdater()
      assert(typeof updater.checkForUpdates === 'function' && typeof updater.quitAndInstall === 'function', 'electron-updater gave no usable autoUpdater')
    },
  },
  {
    name: 'updates: smoke updates through FakeUpdaterBackend on a manual clock, never the network',
    async run(ctx) {
      fresh(ctx)
      assert(runtime().kind === 'fake', 'the real backend is in use')
      clock()
      const s = status()
      assert(s.phase === 'idle' && s.disabledReason === null, `the fake updater should be idle, got ${s.phase} (${s.disabledReason})`)
    },
  },
  {
    name: 'updates: a manual check goes checking → up to date, and the menu, About and the pill follow',
    async run(ctx) {
      const f = fresh(ctx)
      await openAbout(ctx)
      f.configure({ available: null, holdCheck: true })
      const done = runtime().controller().check()
      await until((s) => s.phase === 'checking' && f.holding, 'the check to start')
      await appMenuReads(mainT('updates.menu.checking'), false)
      await aboutReads(ctx, mainT('updates.about.checking'))
      await pillReads(ctx, null)
      f.configure({ holdCheck: false })
      f.release()
      const after = await done
      assert(after.phase === 'idle' && after.lastCheck === 'up-to-date' && after.checkedAt !== null, `expected up to date, got ${JSON.stringify(after)}`)
      assert(runtime().store.get().lastCheckAt !== null, 'the check time was not saved')
      await appMenuReads(mainT('updates.menu.check'), true)
      await aboutReads(ctx, mainT('updates.about.upToDate'))
      await aboutHasButton(ctx, mainT('updates.about.check'))
      await pillReads(ctx, null)
      await bannerReads(ctx, null)
      assert((await mainMenuIds(ctx)).get('update:check') === mainT('updates.menu.check'), 'the main menu lacks Help › Check for Updates…')
    },
  },
  {
    name: 'updates: an update downloads on its own ("Updating 42%"), then is ready ("Restart to update")',
    async run(ctx) {
      await openAbout(ctx)
      const f = await toDownloading(ctx)
      const version = nextVersion()
      await pillReads(ctx, 'downloading', mainT('updates.pill.downloading', { percent: 42 }))
      assert(await ctx.chrome.js<boolean>(`return document.querySelector('[data-update-pill="downloading"]')?.dataset.percent === '42'`), 'the pill’s ring is not at 42%')
      await appMenuReads(mainT('updates.menu.downloading', { percent: 42 }), false)
      await aboutReads(ctx, mainT('updates.about.downloading', { version, percent: 42 }))
      await bannerReads(ctx, mainT('updates.menu.bannerDownloading', { percent: 42 }))
      f.release()
      await until((s) => s.phase === 'ready' && s.version === version, 'the update to be ready')
      assert(f.downloads === 1, `expected one download, saw ${f.downloads}`)
      await pillReads(ctx, 'ready', mainT('updates.pill.ready'))
      await appMenuReads(mainT('updates.menu.restart'), true)
      await aboutReads(ctx, mainT('updates.about.ready'))
      await aboutHasButton(ctx, mainT('updates.about.restartNow'))
      await aboutHasButton(ctx, mainT('updates.about.later'))
      await bannerReads(ctx, mainT('updates.menu.bannerReady'))
    },
  },
  {
    name: 'updates: with automatic downloads off, an update waits for a go-ahead',
    async run(ctx) {
      const f = fresh(ctx)
      await openAbout(ctx)
      ctx.settings.update({ autoDownloadUpdates: false })
      try {
        const version = nextVersion()
        f.configure({ available: { version, size: 40 * MB }, steps: [100] })
        const s = await runtime().controller().check()
        assert(s.phase === 'idle' && s.awaitingConsent && s.version === version, `expected an update waiting for consent, got ${JSON.stringify(s)}`)
        assert(f.downloads === 0, 'it downloaded without a go-ahead')
        await pillReads(ctx, 'available', mainT('updates.pill.available'))
        await appMenuReads(mainT('updates.menu.download', { version }), true)
        await aboutReads(ctx, mainT('updates.about.available', { version }))
        await bannerReads(ctx, mainT('updates.menu.bannerAvailable', { version }))
        // The go-ahead, as About's Download button sends it.
        await ctx.chrome.invoke('updates', 'download')
        await until((x) => x.phase === 'ready', 'the update to download after the go-ahead')
        assert(fake().downloads === 1, 'the go-ahead did not download')
      } finally {
        ctx.settings.update({ autoDownloadUpdates: true })
      }
    },
  },
  {
    name: 'updates: without room for max(2.5 × size, size + 500 MB) the download is a disk-space error',
    async run(ctx) {
      const f = fresh(ctx)
      await openAbout(ctx)
      runtime().seedFreeBytes(600 * MB)
      f.configure({ available: { version: nextVersion(), size: 300 * MB } })
      await runtime().controller().check()
      const s = await until((x) => x.phase === 'error', 'the free-space check to fail')
      assert(s.error?.kind === 'disk-space', `expected a disk-space error, got ${s.error?.kind}`)
      assert(f.downloads === 0, 'it downloaded without room')
      await pillReads(ctx, 'failed', mainT('updates.pill.failed'))
      await aboutReads(ctx, 'Not enough free disk space')
      runtime().seedFreeBytes(null)
    },
  },
  {
    name: 'updates: network failures retry at 1, 2, 4, 8 and 16 minutes, then wait; Try again resets them',
    async run(ctx) {
      await openAbout(ctx)
      const f = await toNetworkError(ctx)
      const c = clock()
      let s = status()
      assert(s.error?.attempt === 1, `expected the first failure, got ${JSON.stringify(s.error)}`)
      await pillReads(ctx, 'failed', mainT('updates.pill.failed'))
      await appMenuReads(mainT('updates.menu.failed'), true)
      await aboutReads(ctx, mainT('updates.about.failed'))
      await aboutHasButton(ctx, mainT('updates.about.tryAgain'))
      await bannerReads(ctx, mainT('updates.menu.bannerFailed'))
      for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
        assert(s.error?.retryAt === c.now() + delay, `retry ${i + 1} should be ${delay / 60_000} min out, got ${JSON.stringify(s.error)}`)
        c.advance(delay)
        s = await until((x) => x.error?.attempt === i + 2, `retry ${i + 1}`)
        assert(f.checks === i + 2, `expected ${i + 2} checks, saw ${f.checks}`)
      }
      assert(s.error?.retryAt === null, 'a sixth retry was scheduled')
      c.advance(60 * 60_000)
      await sleep(50)
      assert(f.checks === 6, `it kept retrying past five retries (${f.checks} checks)`)
      // Try again (About, the pill, the menus) starts afresh and finds the network back.
      f.configure({ failChecks: 0 })
      const back = await ctx.chrome.invoke<UpdateStatus>('updates', 'check')
      assert(back.phase === 'idle' && back.lastCheck === 'up-to-date', `Try again should find Atelier up to date, got ${back.phase}`)
      await pillReads(ctx, null)
    },
  },
  {
    name: 'updates: Restart lists running work; the no-op install meets the 20 s watchdog, and Retry is ready again',
    async run(ctx) {
      await ctx.chrome.js(`window.__e1Restarting = []; window.__e1Off?.(); window.__e1Off = window.atelier.onAppEvent((e) => { if (e.type === 'update-restarting') window.__e1Restarting.push(e.running) }); return true`)
      const { doc, done } = await openRestartCard(ctx)
      const f = fake()
      const version = nextVersion()
      const items = await doc.js<number>(`return document.querySelectorAll('.update-card--restart .update-card__item').length`)
      assert(items === 3, `the restart card should list chats, routines and the recording, listed ${items}`)
      await press(doc, '.update-card--restart', mainT('updates.restart.now'))
      await done
      await until((s) => s.phase === 'installing', 'the install to start')
      await gone(doc, '.update-card--restart', 'the restart card to close')
      assert(f.installs === 1, 'quitAndInstall was not called')
      assert(isQuittingForUpdate(), 'Atelier should be quitting for the update')
      const pending = runtime().store.get().pending
      assert(pending?.version === version && pending.attempts === 1, `the pending record is ${JSON.stringify(pending)}`)
      const restarting = await ctx.chrome.until<Array<{ chats: number }>>(`return window.__e1Restarting.length ? window.__e1Restarting : null`, 3000, 'the update-restarting event')
      assert(restarting[0]?.chats === BUSY.chats, 'update-restarting did not carry the running chats')
      await pillReads(ctx, 'installing', mainT('updates.pill.installing'))
      await appMenuReads(mainT('updates.menu.installing'), false)
      // The fake never quits: just short of the watchdog it is still installing, then it is an install error.
      clock().advance(INSTALL_WATCHDOG_MS - 1)
      assert(status().phase === 'installing', 'the watchdog fired early')
      clock().advance(1)
      const failed = await until((s) => s.phase === 'error', 'the watchdog')
      assert(failed.error?.kind === 'install', `expected an install error, got ${failed.error?.kind}`)
      assert(!isQuittingForUpdate(), 'still quitting after the watchdog')
      await pillReads(ctx, 'failed', mainT('updates.pill.failed'))
      await appMenuReads(mainT('updates.menu.failed'), true)
      await openAbout(ctx)
      await aboutReads(ctx, mainT('updates.error.install'))
      await aboutHasButton(ctx, mainT('updates.about.tryAgain'))
      // Retry: the download is still here, so it is ready again.
      await ctx.chrome.invoke('updates', 'check')
      await until((s) => s.phase === 'ready', 'Retry to make it ready again')
      // Restart when they finish: it waits while work runs, then restarts.
      void runtime().controller().install({ whenIdle: true })
      await waitFor(() => runtime().controller().waitingForIdle, 2000, 'the wait for running work')
      clock().advance(IDLE_POLL_MS)
      assert(status().phase === 'ready', 'it restarted over running work')
      runtime().overrideRunning({ chats: 0, routines: 0, meeting: false })
      clock().advance(IDLE_POLL_MS)
      await until((s) => s.phase === 'installing', 'the restart once the work finished')
      await waitFor(() => f.installs === 2, 3000, 'the second quitAndInstall')
      clock().advance(INSTALL_WATCHDOG_MS)
      await until((s) => s.phase === 'error', 'the second watchdog')
      assert(runtime().store.get().pending?.attempts === 2, 'attempts do not count up')
      await ctx.chrome.js(`window.__e1Off?.(); return true`)
    },
  },
  {
    name: 'updates: on the next start a pending install with the same app version is a failed install; a new version clears it',
    async run(ctx) {
      fresh(ctx)
      const r = runtime()
      r.store.update({ pending: { version: nextVersion(), startedAt: clock().now(), attempts: 1 } })
      r.swap('fake')
      const s = status()
      assert(s.phase === 'error' && s.error?.kind === 'install', `expected a failed install on start, got ${s.phase}`)
      await pillReads(ctx, 'failed', mainT('updates.pill.failed'))
      r.store.update({ pending: { version: app.getVersion(), startedAt: clock().now(), attempts: 1 } })
      r.swap('fake')
      assert(status().phase === 'idle', 'an installed update should start idle')
      assert(r.store.get().pending === null, 'the pending record was not cleared')
      await pillReads(ctx, null)
    },
  },
  {
    name: "updates: what's new shows once after an update, and Help › What's New reopens it",
    async run(ctx) {
      fresh(ctx)
      const r = runtime()
      const current = app.getVersion()
      r.store.update({ lastSeenVersion: '0.0.1', whatsNewShownFor: null })
      r.controller().reloadStore()
      assert(r.controller().whatsNew(), 'no what’s-new card after an update')
      const shown = showWhatsNewIfDue(win())
      const doc = await drawn(ctx, '.update-card--whats-new', 'the what’s-new card')
      const count = await doc.js<number>(`return document.querySelectorAll('.update-card--whats-new .update-card__highlight').length`)
      assert(count > 0, 'the card has no highlights')
      await press(doc, '.update-card--whats-new', mainT('updates.whatsNew.close'))
      assert((await shown) === true, 'the card did not report being shown')
      await gone(doc, '.update-card--whats-new', 'the what’s-new card to close')
      const file = r.store.get()
      assert(file.lastSeenVersion === current && file.whatsNewShownFor === current, `dismissing did not record the version: ${JSON.stringify(file)}`)
      assert((await showWhatsNewIfDue(win())) === false, 'what’s new showed twice')
      r.controller().reloadStore()
      assert(r.controller().whatsNew() === null, 'what’s new is armed again after a reload')
      // Help › What's New opens this version's notes; Esc closes them.
      const reopened = commands.run('whats-new', win())
      const again = await drawn(ctx, '.update-card--whats-new', 'Help › What’s New')
      await again.escape()
      await gone(again, '.update-card--whats-new', 'Esc to close the notes')
      await reopened
    },
  },
  {
    name: "updates: what's new waits for the person: menus open beside it, and only their own close counts as seen",
    async run(ctx) {
      fresh(ctx)
      const r = runtime()
      r.store.update({ lastSeenVersion: '0.0.1', whatsNewShownFor: null })
      r.controller().reloadStore()
      const w = win()
      const shown = showWhatsNewIfDue(w)
      const first = await drawn(ctx, '.update-card--whats-new', 'the what’s-new card')
      await cardShows(w)
      // A tab that slept gets a fresh view on top; the card stays above it when that tab comes forward.
      const home = w.tabs.activeId()
      const napping = w.tabs.create(`${ctx.server.http}/`, { activate: false })
      await waitFor(() => !napping.view.webContents.isLoading() && napping.view.webContents.getURL() !== '', 8000, 'the background tab to load')
      w.tabs.sleep(napping.id)
      assert(w.tabs.isAsleep(napping.id), 'the background tab did not sleep')
      w.tabs.activate(napping.id)
      await sleep(300)
      await cardShows(w)
      if (home) w.tabs.activate(home)
      w.tabs.close(napping.id)
      // A popover (the downloads list) opens beside the card: a window modal would close it as it mounts ('replaced').
      // (A smoke window behind other apps can lose focus, which closes popovers as 'outside'; that is not the card.)
      w.window.focus()
      let popover: OverlayResult | null = null
      const pop = w.overlay.open('downloads', { kind: 'window', rect: { x: 20, y: 20, width: 10, height: 10 } }, { items: [], total: 0 }).then((res) => (popover = res))
      await drawn(ctx, '.dl-pop__head', 'the downloads list beside the card')
      await sleep(200)
      // Assigned in the open's callback, so TypeScript can't follow it.
      const result = popover as OverlayResult | null
      assert(!(result && 'dismissed' in result && result.dismissed === 'replaced'), "what's new closed the downloads list as it opened")
      const both = w.overlay.openSurfaces().map((o) => o.surface)
      assert(result !== null || (both.includes('whats-new') && both.includes('downloads')), `the card and the list are not open together: ${JSON.stringify(both)}`)
      w.overlay.closeAll((s) => s === 'downloads')
      await pop
      // The host closing the card (its window going, a quit) isn't the person closing it.
      closeUpdateCards()
      assert((await shown) === false, 'a card the host closed counted as shown')
      assert(r.store.get().whatsNewShownFor === null, `what's new was recorded as seen without the person closing it: ${JSON.stringify(r.store.get())}`)
      assert(r.controller().whatsNew() !== null, "what's new is no longer armed after the host closed it")
      await gone(first, '.update-card--whats-new', 'the closed card to finish its exit')
      // It comes back, and the person's own close (the ✕) records it.
      const again = showWhatsNewIfDue(w)
      const doc = await drawn(ctx, '.update-card--whats-new', 'the what’s-new card again')
      await press(doc, '.update-card--whats-new', mainT('updates.whatsNew.dismiss'))
      assert((await again) === true, 'closing with ✕ did not count as shown')
      assert(r.store.get().whatsNewShownFor === app.getVersion(), 'closing with ✕ did not record the version')
    },
  },
  {
    name: "updates: a surface closed before the overlay loads leaves no frame behind, and what's new still shows whole",
    async run(ctx) {
      fresh(ctx)
      const r = runtime()
      const w = win()
      const wc = w.overlay.tierWebContents('interactive')
      assert(wc, 'the interactive overlay')
      // While the overlay page reloads (as at start-up), a popover opens and closes before it can draw.
      wc.reload()
      await waitFor(() => wc.isLoading(), 3000, 'the overlay to start loading')
      void w.overlay.open('downloads', { kind: 'window', rect: { x: 20, y: 20, width: 10, height: 10 } }, { items: [], total: 0 }).catch(() => undefined)
      w.overlay.closeAll((s) => s === 'downloads')
      await waitFor(() => !wc.isLoading(), 10_000, 'the overlay to load again')
      await sleep(500)
      const ghosts = await new Chrome(wc).js<number>(`return document.querySelectorAll('.ov-frame[data-surface="downloads"]').length`)
      assert(ghosts === 0, `the overlay still draws ${ghosts} downloads list main had closed`)
      r.store.update({ lastSeenVersion: '0.0.1', whatsNewShownFor: null })
      r.controller().reloadStore()
      const shown = showWhatsNewIfDue(w)
      const doc = await drawn(ctx, '.update-card--whats-new', 'the what’s-new card')
      await cardShows(w)
      await press(doc, '.update-card--whats-new', mainT('updates.whatsNew.close'))
      assert((await shown) === true, 'Got it did not count as shown')
    },
  },
  {
    name: 'updates: Remind me later snoozes the unsupported prompt for 3 days, across a store reload and a restart',
    async run(ctx) {
      fresh(ctx)
      const r = runtime()
      r.seedFeed(UNSUPPORTED_FEED)
      const asked = r.controller().refreshSupport()
      const doc = await drawn(ctx, '.update-card--unsupported', 'the unsupported prompt')
      await press(doc, '.update-card--unsupported', mainT('updates.unsupported.remindLater'))
      await asked
      await gone(doc, '.update-card--unsupported', 'the unsupported prompt to close')
      const until3d = clock().now() + UNSUPPORTED_SNOOZE_MS
      assert(status().unsupported?.snoozedUntil === until3d, `the snooze should last 3 days, got ${JSON.stringify(status().unsupported)}`)
      assert(new UpdatesStore(dirname(r.store.path)).get().unsupportedSnoozeUntil === until3d, 'the snooze is not in updates.json')
      await bannerReads(ctx, mainT('updates.menu.bannerUnsupported'))
      // A reload of the store, then a restart: still snoozed, and no prompt.
      r.store.reload()
      r.controller().reloadStore()
      assert(status().unsupported?.snoozedUntil === until3d, 'a store reload lost the snooze')
      r.swap('fake')
      await r.controller().refreshSupport()
      await sleep(300)
      const prompted = await doc.js<boolean>(`return Boolean(document.querySelector('.update-card--unsupported'))`).catch(() => false)
      assert(!prompted, 'the snoozed prompt showed again after a restart')
      assert(status().unsupported?.snoozedUntil === until3d, 'a restart lost the snooze')
      // Three days on, it asks again.
      clock().advance(UNSUPPORTED_SNOOZE_MS + 1)
      const again = r.controller().refreshSupport()
      const doc2 = await drawn(ctx, '.update-card--unsupported', 'the prompt after the snooze')
      await doc2.escape()
      await again
      r.seedFeed(null)
      await r.controller().refreshSupport()
      assert(status().unsupported === null, 'a supported version kept the mark')
      fresh(ctx)
    },
  },
  {
    name: 'updates: unpackaged builds, and unsigned ones that announce nothing, hide the pill, the About section and every update menu item',
    async run(ctx) {
      const reason = disabledReasonFor({ packaged: app.isPackaged, updatesEnabled: RELEASE.updatesEnabled, platform: process.platform, appImage: Boolean(process.env.APPIMAGE) })
      // A signed, packaged build would build the real updater, and an unsigned release build the one that
      // announces updates (RELEASE.updateNotices): both check GitHub, so smoke stays offline and skips this.
      if (reason !== 'unpackaged' && reason !== 'unsigned') return
      if (reason === 'unsigned' && RELEASE.updateNotices) return
      await toReady(ctx)
      await pillReads(ctx, 'ready')
      const r = runtime()
      try {
        r.swap('real')
        const s = status()
        assert(s.phase === 'disabled' && s.disabledReason === reason, `expected disabled (${reason}), got ${s.phase} (${s.disabledReason})`)
        await pillReads(ctx, null)
        await openAbout(ctx)
        await aboutReads(ctx, null)
        await waitFor(async () => !(await mainMenuIds(ctx)).has('update:check') && !(await mainMenuIds(ctx)).has('update:banner'), 4000, 'the main menu to drop its update rows')
        if (process.platform === 'darwin') await waitFor(() => !Menu.getApplicationMenu()?.getMenuItemById('update:app'), 4000, 'the App menu to drop Check for Updates…')
      } finally {
        fresh(ctx)
      }
    },
  },
]

// ── shots (light and dark, each from a clean updater) ──

export const shots: ShotSpec[] = [
  {
    name: 'e1 About: up to date',
    async run(ctx) {
      fresh(ctx)
      await openAbout(ctx)
      await runtime().controller().check()
      await aboutReads(ctx, mainT('updates.about.upToDate'))
      await sleep(300)
      await ctx.shot('updates-about-up-to-date')
    },
  },
  {
    name: 'e1 pill and About: downloading',
    async run(ctx) {
      await openAbout(ctx)
      const f = await toDownloading(ctx)
      await pillReads(ctx, 'downloading')
      await sleep(400)
      await ctx.shot('updates-downloading')
      f.release()
      fresh(ctx)
    },
  },
  {
    name: 'e1 pill and About: ready to restart',
    async run(ctx) {
      await openAbout(ctx)
      await toReady(ctx)
      await pillReads(ctx, 'ready')
      await aboutReads(ctx, mainT('updates.about.ready'))
      await sleep(400)
      await ctx.shot('updates-ready')
      fresh(ctx)
    },
  },
  {
    name: 'e1 pill and About: update failed',
    async run(ctx) {
      await openAbout(ctx)
      await toNetworkError(ctx)
      await pillReads(ctx, 'failed')
      await aboutReads(ctx, mainT('updates.about.failed'))
      await sleep(400)
      await ctx.shot('updates-failed')
      fresh(ctx)
    },
  },
  {
    name: 'e1 main menu: the update banner',
    async run(ctx) {
      await toReady(ctx)
      await bannerReads(ctx, mainT('updates.menu.bannerReady'))
      const opened = await ctx.chrome.js<boolean>(`const b = document.querySelector('.profile-row'); if (b) b.click(); return Boolean(b)`)
      assert(opened, 'no sidebar footer profile row')
      const doc = await drawn(ctx, '.mm [data-item="update:banner"]', 'the main menu’s update banner')
      await sleep(300)
      await ctx.shot('updates-main-menu')
      await doc.escape()
      await gone(doc, '.mm', 'the main menu to close')
      fresh(ctx)
    },
  },
  {
    name: 'e1 restart card',
    async run(ctx) {
      const { doc, done } = await openRestartCard(ctx)
      await sleep(400)
      await ctx.shot('updates-restart-card')
      await press(doc, '.update-card--restart', mainT('updates.restart.cancel'))
      await done
      await gone(doc, '.update-card--restart', 'the restart card to close')
      fresh(ctx)
    },
  },
  {
    name: 'e1 unsupported prompt',
    async run(ctx) {
      fresh(ctx)
      runtime().seedFeed(UNSUPPORTED_FEED)
      const asked = runtime().controller().refreshSupport()
      const doc = await drawn(ctx, '.update-card--unsupported', 'the unsupported prompt')
      await sleep(400)
      await ctx.shot('updates-unsupported')
      await doc.escape()
      await asked
      fresh(ctx)
    },
  },
  {
    name: "e1 what's new card",
    async run(ctx) {
      fresh(ctx)
      const r = runtime()
      r.store.update({ lastSeenVersion: '0.0.1', whatsNewShownFor: null })
      r.controller().reloadStore()
      const card = r.controller().whatsNew()
      assert(card, 'no what’s-new card after an update')
      // Opened straight on the cards, so the once-only rule (checked above) is left alone.
      const shown = r.cards.showWhatsNew(card, win())
      const doc = await drawn(ctx, '.update-card--whats-new', 'the what’s-new card')
      await sleep(400)
      await ctx.shot('updates-whats-new')
      await doc.escape()
      await shown
      r.controller().dismissWhatsNew()
      fresh(ctx)
    },
  },
]
