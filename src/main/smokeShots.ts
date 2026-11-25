/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'node:fs'
import type { WebContents } from 'electron'
import type { MenuCommand } from '@shared/ipc'
import { UI } from '@shared/ipc'
import { isDestinationUrl, resolveInternalUrl } from '@shared/url'
import type { AgentHost } from './agent/host'
import type { HistoryStore } from './history'
import type { SettingsStore } from './settings'
import type { BaseCheckState } from './smokeBase'
import type { SmokeClient } from './smokeClient'
import { captureWindow, docWith, sleep, waitFor, type Chrome } from './smokeKit'
import { captureScene } from './smokeScene'
import type { BookmarkStore, ConnectorStore, RoutineStore, SkillStore } from './stores'
import type { Tab, TabManager } from './tabs'
import type { ChromeWindow } from './window'

// The visual tour (ATELIER_SMOKE_SHOTS=<dir>): every core surface, captured
// as it looks on screen, so both themes can be reviewed by eye. Run it once
// per theme with ATELIER_SMOKE_THEME=light|dark.

export interface ShotDeps {
  chrome: Chrome
  tabs: TabManager
  host: AgentHost
  client: SmokeClient
  settings: SettingsStore
  windowState: ChromeWindow
  skills: SkillStore
  routines: RoutineStore
  connectors: ConnectorStore
  history: HistoryStore
  bookmarks: BookmarkStore
  /** The fixture web page's tab. */
  first: Tab
  base: string
  baseState: BaseCheckState
  dir: string
}

// ---- overlay surfaces in shots ----
// A surface counts as open as soon as main registers it, but its renderer
// draws it a frame or more later, and the interactive view only gets bounds
// once the renderer has measured it. Shots wait for that, and each shot
// closes what it opened so it never shows up in the next one.

type Tier = 'interactive' | 'passive'

/** What the shots read from a window's overlay host: what is open, where it draws, and how to close it. */
export interface OverlayProbe {
  openSurfaces(): readonly { instanceId: string; surface: string; tier: Tier }[]
  interactiveBounds(): { width: number; height: number } | null
  tierWebContents(tier: Tier): Pick<WebContents, 'executeJavaScript' | 'isDestroyed'> | null
  close(instanceId: string): void
}

export type OverlayProbes = () => readonly OverlayProbe[] | Promise<readonly OverlayProbe[]>

/** Every attached window's overlay host in the running app. */
const liveProbes: OverlayProbes = async () => {
  const { core } = await import('./app')
  return (core()?.windows.all() ?? []).filter((w) => !w.window.isDestroyed() && w.overlay.attached).map((w) => w.overlay)
}

/**
 * Runs in an overlay tier: true once every named surface has a frame that is
 * placed and sized (or hidden on purpose), no finite animation is still
 * running, and two frames have been drawn since.
 */
export function drawnScript(surfaces: readonly string[]): string {
  return `(() => {
    const want = ${JSON.stringify(surfaces)}
    const frames = [...document.querySelectorAll('.ov-frame')].filter((f) => !f.hasAttribute('data-exiting'))
    const drawn = want.every((s) => frames.some((f) => f.dataset.surface === s && (f.hidden || (f.hasAttribute('data-placed') && f.getBoundingClientRect().width > 0))))
    const moving = document.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations !== Infinity)
    const visible = frames.some((f) => !f.hidden && f.hasAttribute('data-placed'))
    if (!drawn || moving) return { ready: false, visible }
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ ready: true, visible }))))
  })()`
}

async function tierReady(probe: OverlayProbe, tier: Tier): Promise<boolean> {
  const surfaces = probe.openSurfaces().filter((s) => s.tier === tier).map((s) => s.surface)
  if (surfaces.length === 0) return true
  const wc = probe.tierWebContents(tier)
  if (!wc || wc.isDestroyed()) return true
  const state = (await wc.executeJavaScript(drawnScript(surfaces), true).catch(() => null)) as { ready: boolean; visible: boolean } | null
  if (!state?.ready) return false
  // The interactive view is sized to the drawn surfaces; until then the capture has nothing to draw.
  if (tier === 'interactive' && state.visible) return (probe.interactiveBounds()?.width ?? 0) > 0
  return true
}

/** Waits until every open overlay surface has drawn; gives up quietly after `timeoutMs` so a shot is still taken. */
export async function settleOverlays(probes: OverlayProbes = liveProbes, timeoutMs = 2500): Promise<boolean> {
  const ready = async (): Promise<boolean> => {
    for (const probe of await probes()) for (const tier of ['interactive', 'passive'] as const) if (!(await tierReady(probe, tier))) return false
    return true
  }
  return waitFor(ready, timeoutMs, 'the overlay surfaces to draw').then(
    () => true,
    () => false,
  )
}

/** The overlay instances open right now, across windows. */
export async function openOverlayIds(probes: OverlayProbes = liveProbes): Promise<Set<string>> {
  return new Set((await probes()).flatMap((p) => p.openSurfaces().map((s) => s.instanceId)))
}

/** Closes every overlay instance that isn't in `before` and waits for it to go; returns the surfaces it closed. */
export async function closeOverlaysSince(before: ReadonlySet<string>, probes: OverlayProbes = liveProbes, timeoutMs = 2000): Promise<string[]> {
  const closed: string[] = []
  for (const probe of await probes())
    for (const s of probe.openSurfaces())
      if (!before.has(s.instanceId)) {
        probe.close(s.instanceId)
        closed.push(s.surface)
      }
  if (closed.length) {
    const left = async (): Promise<boolean> => [...(await openOverlayIds(probes))].every((id) => before.has(id))
    await waitFor(left, timeoutMs, 'the shot’s overlay surfaces to close').catch(() => undefined)
  }
  return closed
}

/** A shot's run with its overlays settled before each capture and closed afterwards. */
export async function withOverlaysClosed<T>(run: () => Promise<T>, probes: OverlayProbes = liveProbes): Promise<T> {
  const before = await openOverlayIds(probes)
  try {
    return await run()
  } finally {
    await closeOverlaysSince(before, probes)
  }
}

/** Sample skills, routines, connectors, history and bookmarks, so the pages show real rows. */
function seed({ skills, routines, connectors, history, bookmarks, base }: ShotDeps, ownerId: string): void {
  skills.save({ name: 'summarize', description: 'Sum up the page in five bullet points', instructions: 'Read the page and write five short bullet points.' })
  skills.save({ name: 'tidy-inbox', description: 'Sort unread mail into today, later and never', instructions: 'Group unread mail by urgency.' })
  skills.save({ name: 'trip-notes', description: 'Keep a running list of travel plans', instructions: 'Collect travel plans into one note.', owner: ownerId })
  routines.save({ name: 'Morning brief', prompt: 'Give me the weather and my first three meetings.', schedule: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, enabled: true })
  routines.save({ name: 'Price watch', prompt: 'Check whether the headphones on my list dropped in price.', schedule: { kind: 'interval', hours: 6 }, enabled: false, owner: ownerId })
  connectors.save({ name: 'Team notes', url: 'https://notes.example.com/mcp', enabled: true })
  connectors.save({ name: 'Calendar', url: 'https://calendar.example.com/mcp', enabled: false })
  history.record(base, 'Atelier smoke test')
  history.record(`${base}second`, 'Second page')
  history.record('https://example.com/', 'Example Domain')
  if (!bookmarks.findByUrl(base)) bookmarks.toggle(base, 'Smoke test')
}

export async function captureTour(deps: ShotDeps): Promise<string[]> {
  const { chrome, tabs, client, settings, windowState, first, baseState, dir } = deps
  const ui = chrome.ui
  const written: string[] = []
  const shoot = async (name: string, wait = 400): Promise<void> => {
    await sleep(wait)
    await settleOverlays()
    writeFileSync(`${dir}/${name}.png`, (await captureWindow(ui, tabs)).toPNG())
    written.push(`${name}.png`)
  }
  // A close-up of the toolbar, for the address pill.
  const shootToolbar = async (name: string, wait = 400): Promise<void> => {
    await sleep(wait)
    const image = await captureWindow(ui, tabs)
    const { width } = image.getSize()
    const left = (await chrome.js<number>(`return Math.round(document.querySelector('.toolbar')?.getBoundingClientRect().left ?? 0)`)) || 0
    writeFileSync(`${dir}/${name}.png`, image.crop({ x: left, y: 0, width: width - left, height: 40 }).toPNG())
    written.push(`${name}.png`)
  }
  const command = (c: MenuCommand): void => ui.send(UI.command, c)
  // A closing panel stays mounted for its exit; it counts as closed.
  const panelOpen = (): Promise<boolean> => chrome.js<boolean>(`return Boolean(document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel'))`)
  const setPanel = async (open: boolean): Promise<void> => {
    if ((await panelOpen()) !== open) command('toggle-agent')
    await chrome.until(`return ${open ? '' : '!'}document.querySelector('.chat-panel')`, 3000, `the panel to ${open ? 'open' : 'close'}`)
  }
  const activeId = await chrome.invoke<string>('companions', 'activeId')
  seed(deps, activeId)

  // The page by itself, as the agent sees it.
  writeFileSync(`${dir}/page.png`, (await first.view.webContents.capturePage()).toPNG())
  written.push('page.png')

  // ---- the shell on a website ----
  tabs.activate(first.id)
  // Badges: the working chat drives this tab, and a pinned tab waits for you.
  if (baseState.runningChatId) tabs.setAgentControlled(first.id, true, baseState.runningChatId)
  if (baseState.pinnedTabIds[1]) tabs.setNeedsInput(baseState.pinnedTabIds[1], true)
  await setPanel(true)
  await shoot('panel', 800)
  await setPanel(false)
  await shoot('sidebar-website')

  windowState.setSidebarOpen(false)
  await shoot('sidebar-collapsed', 600)
  windowState.setSidebarOpen(true)

  settings.update({ layout: 'horizontal' })
  await chrome.until(`return document.querySelector('.app--horizontal')`, 3000, 'the horizontal layout')
  await shoot('horizontal', 600)
  settings.update({ layout: 'sidebar' })
  await chrome.until(`return document.querySelector('.app--sidebar')`, 3000, 'the sidebar layout')

  // ---- Atelier pages, in one tab; destinations on the window-level surface over it (DS-99) ----
  const page = tabs.create('about:blank')
  const open = async (url: string, ready: string, name: string, wait = 500): Promise<void> => {
    if (isDestinationUrl(url)) {
      // As the sidebar opens them: never a tab, and they leave 'Your tabs' alone.
      tabs.activate(page.id)
      tabs.openInternal(url)
      await waitFor(() => tabs.rail() === resolveInternalUrl(url), 3000, `${url} on the destination surface`)
      await chrome.until(`return document.querySelector(${JSON.stringify(`.pane--rail ${ready}`)})`, 6000, `${url} to draw`)
    } else {
      tabs.leaveRail()
      tabs.navigate(page.id, url)
      await chrome.until(`return document.querySelector(${JSON.stringify(ready)})`, 6000, `${url} to draw`)
    }
    await shoot(name, wait)
  }
  await shoot('newtab', 1500)
  // A page with a path: the pill shows the host, a slash and the title.
  tabs.navigate(page.id, `${deps.base}second`)
  await chrome.until(`return document.querySelector('.pill__detail')?.textContent === 'Second page'`, 6000, 'the pill to show the page title')
  await shootToolbar('address-pill-website')
  if (baseState.picnicChatId) await open(`atelier://chat/${baseState.picnicChatId}`, '.chat-log', 'chat-page', 700)
  // Browser tasks (docs/decisions.md): the steps card as a browser_steps run leaves it.
  if (baseState.picnicChatId) {
    deps.host.appendEvent(baseState.picnicChatId, {
      type: 'browser-steps',
      id: 'shot-steps',
      goal: 'Add the Trailrunner 2 in size 43 to the cart and open the cart',
      status: 'done',
      steps: [
        { text: 'Clicked “Trailrunner 2 trail shoes”', ms: 92 },
        { text: 'Filled in “Size (EU)”: “43”', ms: 88 },
        { text: 'Clicked “Add to cart”', ms: 86 },
        { text: 'Clicked “Go to cart”', ms: 90 },
      ],
    })
    await open(`atelier://chat/${baseState.picnicChatId}`, '.cd-steps', 'chat-browser-steps', 700)
  }
  if (baseState.runningChatId) await open(`atelier://chat/${baseState.runningChatId}`, '.chat-log', 'chat-working', 500)
  await open('atelier://chats', '.chats-page', 'all-chats')
  await open('atelier://skills', '.sp-page', 'skills')
  await open('atelier://routines', '.sp-page', 'routines')
  await open('atelier://connectors', '.sp-page', 'connectors')
  // Your details (Settings › You): the saved address marked as yours.
  await chrome
    .invoke('wallet', 'saveAddress', { givenName: 'Sam', additionalName: '', familyName: 'Lee', organization: '', line1: 'Kade 1', line2: '', line3: '', city: 'Utrecht', region: '', postalCode: '3512 AB', country: 'NL', email: 'sam@example.com', tel: '+31 6 1234 5678', mine: true })
    .catch(() => undefined)
  await open('atelier://settings/you', '.sp-page', 'settings-you')
  await open('atelier://settings/decisions', '.sp-page', 'settings-decisions', 700)
  await open('atelier://settings/appearance', '.sp-page', 'settings-appearance')
  await shootToolbar('address-pill-atelier', 100)
  await open('atelier://settings/companions', '.sp-page', 'settings-companions', 700)

  // The new-companion sheet, from Settings › Companions.
  await chrome.click(/^New companion$/)
  await chrome.until(`return document.querySelector('.co-preset img')`, 8000, 'the new-companion sheet')
  await shoot('new-companion-sheet', 1200)
  await chrome.escape()
  await chrome.until(`return !document.querySelector('.co-preset')`, 3000, 'the sheet to close')

  // A look is changed on the card: the ring of bubbles around the figure, and the option card a bubble opens.
  await open(`atelier://companion/${activeId}/general/look`, '.co-ring__bubble', 'companion-editor', 2000)
  await chrome.js(`document.querySelectorAll('.co-ring__bubble')[2]?.click(); return true`)
  await chrome.until(`return document.querySelector('.co-ring-card .co-ring-tile')`, 6000, 'the eyes options')
  await shoot('companion-look', 600)
  await chrome.js(`document.querySelector('.co-hero__look')?.click(); return true`)

  // A confirmation: History › Clear all.
  await open('atelier://history', '.sp-page', 'history')
  await chrome.click(/^Clear (all|history)/)
  const confirmDoc = await docWith(chrome, '[role="alertdialog"], [role="dialog"]', 5000, 'the confirmation')
  await shoot('confirm-dialog', 400)
  await confirmDoc.escape()
  await confirmDoc.until(`return !document.querySelector('[role="alertdialog"], [role="dialog"]')`, 3000, 'the confirmation to close').catch(() => undefined)
  await open('atelier://bookmarks', '.sp-page', 'bookmarks')
  await open('atelier://downloads', '.sp-page', 'downloads')

  // ---- the companion card, opened as an atelier://companion tab (the toolbar has no avatar any more, DS-24) ----
  tabs.navigate(first.id, `atelier://companion/${activeId}/general`)
  tabs.activate(first.id)
  await sleep(300)
  await chrome.until(`return document.querySelector('.co-card')`, 6000, 'the companion card')
  await shoot('companion-card-general', 2200)
  await chrome.click(/^Skills/, `document.querySelector('.co-card__tabs')`)
  await shoot('companion-card-skills', 900)
  await chrome.click(/^Memory/, `document.querySelector('.co-card__tabs')`)
  await shoot('companion-card-memory', 900)
  // As a tab, Esc leaves the card (and the tab) open (DS-121); the tab goes back to a blank page.
  await chrome.escape()
  await sleep(200)
  if (!(await chrome.js<boolean>(`return Boolean(document.querySelector('.co-card'))`))) throw new Error('Esc closed the companion tab')
  tabs.navigate(first.id, 'about:blank')
  await chrome.until(`return !document.querySelector('.co-card')`, 3000, 'the card to close')
  // The same card as an atelier://companion tab, on another section.
  tabs.navigate(page.id, `atelier://companion/${activeId}/models`)
  tabs.activate(page.id)
  await chrome.until(`return document.querySelector('.co-card')`, 6000, 'the companion card tab')
  await shoot('companion-card-models', 1200)
  tabs.navigate(page.id, 'about:blank')

  // ---- the floating card over the washed content area (DS-29, DS-30), opened
  // from a reply face, with its switcher and more menus (DS-34, DS-35) and the
  // in-place look editor (DS-43) ----
  if (baseState.picnicChatId) {
    const face = '.chat-log .chat-reply__face .chat-avatar--button'
    tabs.leaveRail()
    tabs.navigate(page.id, `atelier://chat/${baseState.picnicChatId}`)
    tabs.activate(page.id)
    await chrome.until(`return document.querySelector(${JSON.stringify(face)})`, 6000, 'a reply face')
    await chrome.js(`document.querySelector(${JSON.stringify(face)})?.click(); return true`)
    await chrome.until(`return document.querySelector('.co-card--float .co-hero__look')`, 6000, 'the floating card')
    await shoot('companion-card-float', 1600)
    // The look editor comes first, before any menu has been over the card. The
    // pill is clicked only while it reads collapsed (a second click before React
    // re-renders just opens it again), and a miss reports what the card showed.
    await chrome
      .until(
        `const b = document.querySelector('.co-layer:not(.co-layer--leaving) .co-card--float .co-hero__look')
         if (!b || b.closest('[inert]')) return false
         if (b.getAttribute('aria-expanded') !== 'true') b.click()
         return Boolean(document.querySelector('.co-card--float .co-hero--looking .co-look__tools'))`,
        6000,
        'the look editor',
      )
      .catch(async (err: unknown) => {
        const seen = await chrome
          .js(
            `const b = document.querySelector('.co-hero__look')
             return { card: Boolean(document.querySelector('.co-card--float')), leaving: Boolean(document.querySelector('.co-layer--leaving')), expanded: b ? b.getAttribute('aria-expanded') : null, inert: Boolean(b && b.closest('[inert]')), looking: Boolean(document.querySelector('.co-hero--looking')), editor: Boolean(document.querySelector('.co-look')), error: document.querySelector('.chrome-error')?.textContent?.slice(0, 160) ?? null }`,
          )
          .catch(() => null)
        throw new Error(`${err instanceof Error ? err.message : String(err)} ${JSON.stringify(seen)}`)
      })
    await shoot('companion-card-editor', 1400)
    // Esc closes the editor and leaves the card open.
    await chrome.escape()
    await chrome.until(`return !document.querySelector('.co-hero--looking') && document.querySelector('.co-card--float')`, 3000, 'the look editor to close')
    // The card shrinks back by the editor's extra width; menus anchor to where it settles.
    await chrome.until(`return !document.querySelector('.co-hero--unlooking') && document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`, 3000, 'the card to settle').catch(() => undefined)
    await sleep(400)
    // Each menu is closed through the overlay host (a synthetic Esc in the overlay
    // can miss the menu and reach the card instead), so the card stays open.
    const menuShot = async (opener: string, name: string): Promise<void> => {
      await chrome.until(`return document.querySelector(${JSON.stringify(opener)})`, 4000, `the ${name} opener`)
      await withOverlaysClosed(async () => {
        await chrome.js(`document.querySelector(${JSON.stringify(opener)})?.click(); return true`)
        await docWith(chrome, '[role="menu"]', 4000, `the ${name} menu`)
        await shoot(name, 500)
      })
      await chrome.until(`return document.querySelector('.co-card--float')`, 3000, `the card to stay open after the ${name} menu`)
    }
    await menuShot('.co-card--float .co-switcher', 'companion-card-switcher')
    await menuShot('.co-card--float .co-card__actions [aria-haspopup="menu"]', 'companion-card-more')
    // Esc closes the card; its Close button is the fallback if the Esc went elsewhere.
    await chrome.escape()
    await chrome.until(`return !document.querySelector('.co-card')`, 3000, 'the card to close').catch(async () => {
      await chrome.js(`document.querySelector('.co-card--float .co-card__actions .co-round:not([aria-haspopup])')?.click(); return true`)
      await chrome.until(`return !document.querySelector('.co-card')`, 3000, 'the card to close')
    })
    tabs.navigate(page.id, 'about:blank')
  }

  // ---- the design scene, at the design window size ----
  written.push(...(await captureScene({ chrome, tabs, settings, bookmarks: deps.bookmarks, first, base: deps.base, baseState, dir })))
  tabs.activate(page.id)

  // ---- the welcome flow ----
  await open('atelier://welcome', '.welcome', 'welcome', 1500)
  await chrome.click(/^Get started$/).catch(() => undefined)
  await shoot('welcome-companion', 2500)

  // Put things back for anything that runs after.
  if (baseState.runningChatId) tabs.setAgentControlled(first.id, false)
  if (baseState.pinnedTabIds[1]) tabs.setNeedsInput(baseState.pinnedTabIds[1], false)
  client.release()
  return written
}
