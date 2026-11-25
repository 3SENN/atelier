/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DownloadFolderView } from '@shared/downloads'
import type { DownloadInfo } from '@shared/services'
import { downloadManager } from '../downloads'
import { safety } from '../safety'
import { core } from '../app'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The downloads smoke checks and shots: a small download you start asks
// the chrome to open the popover and fly the icon, an agent download never
// does, a flagged file waits for Keep, and the settings page and Downloads
// page render. Files come from the 127.0.0.1 fixture server only.

interface StartedEvent {
  type: 'download-started'
  id: string
  byAgent: boolean
  autoOpen: boolean
}

function serve(ctx: SmokeContext, path: string, name: string, body: Buffer): string {
  ctx.server.route(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'content-disposition': `attachment; filename="${name}"` }).end(body)
  })
  return `${ctx.server.http}${path}`
}

/** Records download-started events in the chrome, as the downloads button hears them. */
async function listen(ctx: SmokeContext): Promise<void> {
  await ctx.chrome.js(`
    window.__l5cStarted = window.__l5cStarted || []
    if (!window.__l5cListening) {
      window.__l5cListening = true
      window.atelier.onAppEvent((e) => { if (e.type === 'download-started') window.__l5cStarted.push(e) })
    }
    return true`)
}

async function startedFor(ctx: SmokeContext, id: string): Promise<StartedEvent> {
  return ctx.chrome.until<StartedEvent>(`return (window.__l5cStarted || []).find((e) => e.id === ${JSON.stringify(id)}) || null`, 5000, 'the download-started event')
}

/** Downloads `url` from a fresh tab and waits for its row to settle. */
async function download(ctx: SmokeContext, url: string, filename: string, prepare?: (tabId: string) => void): Promise<DownloadInfo> {
  const manager = downloadManager()
  assert(manager, 'the download manager exists')
  const tab = ctx.tabs.create('about:blank', { activate: false })
  try {
    prepare?.(tab.id)
    tab.view.webContents.downloadURL(url)
    let row: DownloadInfo | undefined
    await waitFor(() => {
      row = manager.list().find((d) => d.filename === filename && d.state !== 'progressing')
      return row !== undefined
    }, 10_000, `${filename} to finish`)
    return row as unknown as DownloadInfo
  } finally {
    ctx.tabs.setAgentControlled(tab.id, false)
    ctx.tabs.close(tab.id)
  }
}

const smallDownload: SmokeCheck = {
  name: 'downloads: a small download you start opens the popover and flies in',
  async run(ctx) {
    await listen(ctx)
    const url = serve(ctx, '/menus-downloads/small.dat', 'downloads-small.dat', Buffer.alloc(64 * 1024, 7))
    // Not .bin: that is a runnable type, held for review (safety.ts).
    const row = await download(ctx, url, 'downloads-small.dat')
    await waitFor(() => existsSync(row.path), 5000, 'the file to move into place')
    assert(row.state === 'completed', `it finished (${row.state})`)
    assert(row.byAgent === false && row.tabId !== null, 'it is yours, from its tab')
    assert(typeof row.speedBps === 'number' && row.etaSeconds === null, 'speed and time left settle when done')
    assert(readFileSync(row.path).length === 64 * 1024, 'the whole file landed')
    const started = await startedFor(ctx, row.id)
    assert(started.autoOpen && !started.byAgent, 'the chrome is asked to open the popover (under 10 MB)')
    // The button shows while there are downloads; the cue store hands the event to it.
    await ctx.chrome.until(`return document.querySelector('.downloads-btn')`, 5000, 'the downloads button')
  },
}

const popoverOnScreen: SmokeCheck = {
  name: 'downloads: a click on the button shows the list on screen, under it',
  async run(ctx) {
    const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
    assert(win, 'the first window')
    win.overlay.closeAll((s) => s === 'downloads')
    await ctx.chrome.until(`return document.querySelector('.downloads-btn button')`, 5000, 'the downloads button')
    const button = await ctx.chrome.js<{ x: number; y: number; width: number; height: number }>(
      `const b = document.querySelector('.downloads-btn button'); const r = b.getBoundingClientRect(); b.click(); return { x: r.x, y: r.y, width: r.width, height: r.height }`,
    )
    try {
      type Box = { x: number; y: number; width: number; height: number }
      let list: Box | null = null
      let view: Box | null = null
      // Inside the view main sized: on screen, not drawn off its edges. The list's first frame draws before the
      // renderer shifts by the view's origin (it learns its own rect from that frame), so this waits for it to settle.
      const inside = (r: Box | null, v: Box | null): boolean => Boolean(r && v && r.width > 0 && r.x >= -1 && r.y >= -1 && r.x + r.width <= v.width + 1 && r.y + r.height <= v.height + 1)
      await waitFor(
        async () => {
          const wc = win.overlay.tierWebContents('interactive')
          if (!wc || wc.isDestroyed()) return false
          list = await new Chrome(wc).js<Box | null>(`const el = document.querySelector('.dl-pop'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }`).catch(() => null)
          view = win.overlay.interactiveBounds()
          return inside(list, view)
        },
        6000,
        'the downloads list',
      ).catch(() => {
        assert(view, 'the overlay view is not showing')
        assert(list, 'the downloads list never drew')
        assert(false, `the list is drawn outside its view: ${JSON.stringify(list)} in ${JSON.stringify(view)}`)
      })
      const r = list as unknown as Box
      const v = view as unknown as Box
      assert(r.width >= 290, `the list is ${Math.round(r.width)} px wide`)
      const top = v.y + r.y
      assert(top >= button.y + button.height, `the list (top ${Math.round(top)}) is not under the button (bottom ${Math.round(button.y + button.height)})`)
    } finally {
      win.overlay.closeAll((s) => s === 'downloads')
    }
  },
}

// In a freshly loaded overlay the view is as small as whatever it last showed (nothing, at start). Menus that
// sized or placed themselves by that view drew 2 px tall (the chat list) or 0 px wide (Extensions), and the
// user saw them flash or nothing at all. Both must open whole, on screen, under the button.
const menusInFreshOverlay: SmokeCheck = {
  name: 'overlay: the chat list and Extensions open whole in a freshly loaded overlay, under their button',
  async run(ctx) {
    const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
    assert(win, 'the first window')
    const surfaces = ['chat-popover', 'extensions-popover'] as const
    const closeAll = (): void => win.overlay.closeAll((s) => (surfaces as readonly string[]).includes(s))
    closeAll()
    const wc = win.overlay.tierWebContents('interactive')
    assert(wc, 'the interactive overlay')
    wc.reload()
    await waitFor(() => wc.isLoading(), 3000, 'the overlay to start loading')
    await waitFor(() => !wc.isLoading(), 10_000, 'the overlay to load again')
    const width = await ctx.chrome.js<number>('return window.innerWidth')
    type Box = { x: number; y: number; width: number; height: number }
    const button: Box = { x: width - 48, y: 4, width: 32, height: 32 }
    const cases: Array<{ surface: (typeof surfaces)[number]; props: object; card: string; minWidth: number }> = [
      { surface: 'chat-popover', props: { chatId: null, panel: null }, card: '.cd-pop', minWidth: 300 },
      { surface: 'extensions-popover', props: {}, card: '.ext-popover', minWidth: 300 },
    ]
    try {
      for (const c of cases) {
        void win.overlay.open(c.surface, { kind: 'window', rect: button }, c.props as never).catch(() => undefined)
        let card: Box | null = null
        let view: Box | null = null
        const inside = (r: Box | null, v: Box | null): boolean => Boolean(r && v && r.width > 0 && r.x >= -1 && r.y >= -1 && r.x + r.width <= v.width + 1 && r.y + r.height <= v.height + 1)
        await waitFor(
          async () => {
            card = await new Chrome(wc).js<Box | null>(`const el = document.querySelector(${JSON.stringify(c.card)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }`).catch(() => null)
            view = win.overlay.interactiveBounds()
            return inside(card, view) && (card as unknown as Box).height >= 100
          },
          6000,
          `${c.surface} to draw whole`,
        ).catch(() => {
          assert(view, `${c.surface}: the overlay view is not showing`)
          assert(card, `${c.surface}: the card never drew`)
          assert(false, `${c.surface}: the card is ${JSON.stringify(card)} in the view ${JSON.stringify(view)}`)
        })
        const r = card as unknown as Box
        const v = view as unknown as Box
        assert(r.width >= c.minWidth, `${c.surface}: the card is ${Math.round(r.width)} px wide`)
        assert(v.y + r.y >= button.y + button.height, `${c.surface}: the card (top ${Math.round(v.y + r.y)}) is not under the button`)
        assert(v.x + r.x + r.width <= width, `${c.surface}: the card runs off the window's right edge`)
        closeAll()
        await waitFor(async () => !(await new Chrome(wc).js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(c.card)}))`).catch(() => true)), 3000, `${c.surface} to close`)
      }
    } finally {
      closeAll()
    }
  },
}

const agentDownload: SmokeCheck = {
  name: 'downloads: an agent download never opens the popover',
  async run(ctx) {
    await listen(ctx)
    const url = serve(ctx, '/menus-downloads/agent.txt', 'downloads-agent.txt', Buffer.from('from the agent'))
    // A tab held with no chat is Claude Code outside Atelier: an agent run (ST-60).
    const row = await download(ctx, url, 'downloads-agent.txt', (tabId) => ctx.tabs.setAgentControlled(tabId, true, null))
    assert(row.byAgent, 'the row is marked as the agent’s')
    const started = await startedFor(ctx, row.id)
    assert(started.byAgent && !started.autoOpen, 'no auto-open for agent downloads')
  },
}

const flaggedDownload: SmokeCheck = {
  name: 'downloads: a flagged file waits for Keep',
  async run(ctx) {
    const manager = downloadManager()
    assert(manager, 'the download manager exists')
    manager.configure({ classify: () => 'uncommon' })
    try {
      const url = serve(ctx, '/menus-downloads/flagged.bin', 'downloads-flagged.bin', Buffer.from('flagged bytes'))
      const row = await download(ctx, url, 'downloads-flagged.bin')
      assert(row.danger === 'uncommon' && row.state === 'completed', 'finished but held')
      assert(!existsSync(row.path), 'not in place before Keep')
      await ctx.chrome.invoke('downloads', 'keep', row.id)
      await waitFor(() => existsSync(row.path), 5000, 'the kept file')
      assert(manager.list().find((d) => d.id === row.id)?.danger === 'none', 'kept')
    } finally {
      manager.configure({ classify: (input) => safety.classifyDownload(input) })
    }
  },
}

const folderView: SmokeCheck = {
  name: 'downloads: the folder view and the settings page',
  async run(ctx) {
    const folder = await ctx.chrome.invoke<DownloadFolderView>('downloads', 'folder')
    assert(!folder.custom && !folder.missing && folder.path === folder.defaultPath, `the default folder is used (${JSON.stringify(folder)})`)
    ctx.tabs.openInternal('atelier://settings/downloads')
    await ctx.chrome.until(`return document.querySelector('#downloads-folder') && document.body.innerText.includes(${JSON.stringify(join(folder.path))})`, 8000, 'Settings › Downloads')
  },
}

export const downloadChecks: SmokeCheck[] = [smallDownload, popoverOnScreen, menusInFreshOverlay, agentDownload, flaggedDownload, folderView]

export const downloadShots: ShotSpec[] = [
  {
    name: 'downloads-page',
    async run(ctx) {
      ctx.tabs.openInternal('atelier://downloads')
      await ctx.chrome.until(`return document.querySelector('.sp-page .dl-page__item, .sp-page .ui-state')`, 8000, 'the Downloads page')
      await ctx.shot('downloads-page')
    },
  },
  {
    name: 'downloads-settings',
    async run(ctx) {
      ctx.tabs.openInternal('atelier://settings/downloads')
      await ctx.chrome.until(`return document.querySelector('#downloads-folder')`, 8000, 'Settings › Downloads')
      await ctx.shot('downloads-settings')
    },
  },
  {
    name: 'downloads-popover',
    async run(ctx) {
      // Opens from the header button; before the overlay host lands this opens the Downloads page instead.
      await ctx.chrome.js(`const b = document.querySelector('.downloads-btn button'); if (b) b.click(); return Boolean(b)`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      await ctx.shot('downloads-popover')
      await ctx.chrome.js(`const b = document.querySelector('.downloads-btn button[aria-expanded="true"]'); if (b) b.click(); return true`)
    },
  },
]
