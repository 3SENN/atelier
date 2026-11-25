/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRAND_NAME } from '@shared/branding'
import { describe, expect, it, vi } from 'vitest'
import { initialUpdateStatus, type UpdateStatus } from '../src/shared/updates'
import { FakeUpdaterBackend, type UpdaterBackend } from '../src/main/updates/backend'
import { ManualClock } from '../src/main/updates/clock'
import { UpdateController } from '../src/main/updates/controller'
import { classifyError } from '../src/main/updates/machine'
import { updateBanner, updateHelpItems } from '../src/main/updates/menu'
import { ReleaseNoticeBackend, parseFeedVersion, releaseFeedUrl, releasePageUrl } from '../src/main/updates/notices'
import { UpdatesStore } from '../src/main/updates/store'
import { aboutView, clickAction, pillHint, pillKind } from '../src/renderer/src/updates/logic/labels'

// Update notices: a build that can't install updates itself (unsigned) looks for
// a newer release and points at its page. No network: the feed is a fake fetch.

const REPO = { owner: 'someone', name: 'atelier' }

const FEED = `version: 1.7.1
files:
  - url: Atelier-Setup-1.7.1.exe
    sha512: abc==
    size: 441546370
path: Atelier-Setup-1.7.1.exe
releaseDate: '2026-11-25T17:33:14.206Z'
`

describe('the release feed', () => {
  it('names this platform’s feed on the latest release, and a version’s page', () => {
    expect(releaseFeedUrl(REPO, 'win32')).toBe('https://github.com/someone/atelier/releases/latest/download/latest.yml')
    expect(releaseFeedUrl(REPO, 'darwin')).toBe('https://github.com/someone/atelier/releases/latest/download/latest-mac.yml')
    expect(releasePageUrl(REPO, '1.7.1')).toBe('https://github.com/someone/atelier/releases/tag/v1.7.1')
  })

  it('reads the top-level version only, and only a real one', () => {
    expect(parseFeedVersion(FEED)).toBe('1.7.1')
    expect(parseFeedVersion(FEED.replace(/\n/g, '\r\n'))).toBe('1.7.1')
    expect(parseFeedVersion("version: '2.0.0-beta.1'\n")).toBe('2.0.0-beta.1')
    expect(parseFeedVersion('files:\n  - version: 9.9.9\n')).toBeNull()
    expect(parseFeedVersion('version: latest\n')).toBeNull()
    expect(parseFeedVersion('<html>Not Found</html>')).toBeNull()
  })
})

function backend(current: string, respond: () => Response | Promise<Response>) {
  const fetcher = vi.fn(async () => respond()) as unknown as typeof fetch
  const b = new ReleaseNoticeBackend({ repo: REPO, platform: 'win32', currentVersion: current, fetcher })
  const events: Array<[string, unknown]> = []
  for (const name of ['checking', 'available', 'not-available', 'error'] as const) b.on(name, (arg?: unknown) => events.push([name, arg]))
  return { b, events, fetcher }
}

describe('the notice backend', () => {
  it('announces a newer release, with nothing sent that identifies the person', async () => {
    const { b, events, fetcher } = backend('1.6.1', () => new Response(FEED))
    await b.check()
    expect(events).toEqual([
      ['checking', undefined],
      ['available', { version: '1.7.1', size: 0 }],
    ])
    expect(fetcher).toHaveBeenCalledWith('https://github.com/someone/atelier/releases/latest/download/latest.yml', expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }))
  })

  it('is up to date on the same or a newer version, and when the release has no build for this platform', async () => {
    for (const current of ['1.7.1', '1.8.0-beta.1']) {
      const { b, events } = backend(current, () => new Response(FEED))
      await b.check()
      expect(events.at(-1)?.[0]).toBe('not-available')
    }
    const missing = backend('1.6.1', () => new Response('Not Found', { status: 404 }))
    await missing.b.check()
    expect(missing.events.at(-1)?.[0]).toBe('not-available')
  })

  it('reports an unreachable feed as a network failure, and an unreadable one as an error', async () => {
    const offline = backend('1.6.1', () => Promise.reject(new TypeError('fetch failed')))
    await offline.b.check()
    expect(classifyError(offline.events.at(-1)?.[1])).toBe('network')
    const down = backend('1.6.1', () => new Response('', { status: 503 }))
    await down.b.check()
    expect(classifyError(down.events.at(-1)?.[1])).toBe('network')
    const junk = backend('1.6.1', () => new Response('<html></html>'))
    await junk.b.check()
    expect(junk.events.at(-1)?.[0]).toBe('error')
    expect(classifyError(junk.events.at(-1)?.[1])).toBe('unknown')
  })
})

function controller(fake: UpdaterBackend, auto: boolean) {
  const opened: string[] = []
  const ctl = new UpdateController({
    clock: new ManualClock(Date.UTC(2026, 10, 25)),
    store: new UpdatesStore(mkdtempSync(join(tmpdir(), 'atelier-notices-'))),
    currentVersion: '1.6.1',
    disabledReason: null,
    backend: () => fake,
    openDownload: (version) => opened.push(version),
    autoDownload: () => auto,
    freeBytes: async () => null,
    running: () => ({ chats: 0, routines: 0, meeting: false }),
    flushSession: async () => undefined,
    askRestart: async () => null,
    askUnsupported: async () => null,
    supportFeed: async () => null,
    entries: [],
    onStatus: () => undefined,
    onRestarting: () => undefined,
  })
  return { ctl, opened }
}

describe('a build that only announces updates', () => {
  it('offers the newer version and opens its page, never downloading, even with automatic downloads on', async () => {
    const fake = new FakeUpdaterBackend()
    fake.configure({ available: { version: '1.7.1', size: 0 } })
    const { ctl, opened } = controller(fake, true)
    ctl.start()
    expect(ctl.status()).toMatchObject({ phase: 'idle', manual: true, disabledReason: null })
    expect(await ctl.check()).toMatchObject({ phase: 'idle', version: '1.7.1', awaitingConsent: true, lastCheck: 'available' })
    ctl.autoDownloadChanged(true)
    ctl.download()
    ctl.download()
    expect(opened).toEqual(['1.7.1', '1.7.1'])
    expect(fake.downloads).toBe(0)
    expect(ctl.status()).toMatchObject({ phase: 'idle', version: '1.7.1', awaitingConsent: true })
    ctl.dispose()
  })

  it('checks first when asked to update before it knows of a version', async () => {
    const fake = new FakeUpdaterBackend()
    const { ctl, opened } = controller(fake, false)
    ctl.start()
    ctl.download()
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(fake.checks).toBe(1)
    expect(opened).toEqual([])
    expect(ctl.status()).toMatchObject({ phase: 'idle', lastCheck: 'up-to-date' })
    ctl.dispose()
  })
})

describe('what an announcing build shows', () => {
  const manual = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...initialUpdateStatus('1.6.1'), phase: 'idle', disabledReason: null, manual: true, ...patch })
  const waiting = manual({ awaitingConsent: true, version: '1.7.1', lastCheck: 'available' })

  it('has the update menu items, the pill and About’s row, worded for a download by hand', () => {
    expect(updateHelpItems(manual())).toHaveLength(1)
    expect(updateBanner(waiting)?.label).toBe(`${BRAND_NAME} 1.7.1 is ready to download`)
    expect(pillKind(waiting)).toBe('available')
    expect(clickAction(waiting)).toBe('download')
    expect(pillHint('available', waiting)).toContain('Open the page')
    expect(pillHint('available', { ...waiting, manual: false })).toContain('Download it now')
    const view = aboutView(waiting, 0)
    expect(view).toMatchObject({ line: { text: `${BRAND_NAME} 1.7.1 is available` }, buttons: ['download'] })
    expect(view.line?.detail).toContain("can't update itself")
    expect(aboutView({ ...waiting, manual: false }, 0).line?.detail).toBeNull()
  })
})
