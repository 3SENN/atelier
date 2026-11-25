/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings main side: interface zoom, languages, clear-data option sets,
// the reset plan (dry run), storage measuring, notification suppression and
// the presenter, the Dock badge debounce, the Dock icon choice, the import
// type matrix on fixture profiles, and the licence generator. Offline.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shown: Array<{ options: Record<string, unknown>; handlers: Map<string, (...args: unknown[]) => void>; closed: boolean }> = []
vi.mock('electron', () => {
  class Notification {
    static isSupported(): boolean {
      return true
    }
    entry: (typeof shown)[number]
    constructor(options: Record<string, unknown>) {
      this.entry = { options, handlers: new Map(), closed: false }
      shown.push(this.entry)
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.entry.handlers.set(event, fn)
      return this
    }
    show(): void {}
    close(): void {
      this.entry.closed = true
      this.entry.handlers.get('close')?.()
    }
  }
  return { Notification, app: { getPath: () => tmpdir(), dock: undefined }, nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }), createEmpty: () => ({}) }, systemPreferences: {} }
})

import { BROWSER_TYPES, IMPORT_TYPES, type ImportProgress } from '@shared/browserImport'
import { DEFAULT_SETTINGS } from '../src/main/settings'
import { acceptLanguageHeader, addLanguage, canonicalTag, LANGUAGES_MAX, moveLanguage, removeLanguage } from '@shared/languages'
import { CHAT_ZOOM_STEPS, clampZoom, stepZoom, UI_ZOOM_STEPS, zoomPatch, zoomTarget } from '../src/main/uiZoom'
import { clearPlan, originsVisitedSince, rangeStart } from '../src/main/clearData'
import { registerResetStep, resetSteps, runResetSteps } from '../src/main/reset'
import { measureStorage, registerStorageCategory } from '../src/main/storage'
import { notificationButtons, notificationSilent, shouldNotify, targetKey } from '../src/main/notifications'
import { createSystemPresenter } from '../src/main/notificationPresenter'
import { attentionCounts, badgeText, debounced, newlyWaiting } from '../src/main/attention'
import { choiceFromFlags, flagPatches, migratedDockChoice, resolveDockChoice } from '../src/main/dockIcon'
import { chromiumProfiles, detectBrowsers, profileReader, runImport, type ImportSinks, type ProfileReader } from '../src/main/importBrowsers'
// @ts-expect-error: a plain .mjs build script without type declarations.
import { collectLicenses, licenseOf } from '../scripts/licenses.mjs'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-l7-'))

describe('interface zoom (ST-27)', () => {
  it('keeps chrome pages within 30–100% and chat pages within 30–200%', () => {
    expect(UI_ZOOM_STEPS[0]).toBe(0.3)
    expect(UI_ZOOM_STEPS.at(-1)).toBe(1)
    expect(CHAT_ZOOM_STEPS.at(-1)).toBe(2)
    expect(clampZoom(0.1, 'ui')).toBe(0.3)
    expect(clampZoom(1.5, 'ui')).toBe(1)
    expect(clampZoom(1.5, 'chat')).toBe(1.5)
    expect(clampZoom(3, 'chat')).toBe(2)
    expect(clampZoom(Number.NaN, 'chat')).toBe(1)
  })

  it('steps through the table and routes ⌘+ ⌘− ⌘0 by page', () => {
    expect(stepZoom(1, 1, UI_ZOOM_STEPS)).toBe(1)
    expect(stepZoom(1, -1, UI_ZOOM_STEPS)).toBe(0.9)
    expect(stepZoom(0.3, -1, UI_ZOOM_STEPS)).toBe(0.3)
    expect(stepZoom(0.85, 1, UI_ZOOM_STEPS)).toBe(0.9)
    expect(zoomTarget('atelier://chat/abc-123')).toBe('chat')
    expect(zoomTarget('atelier://settings/appearance')).toBe('ui')
    expect(zoomPatch('atelier://chat/abc', { uiZoom: 1, chatZoom: 1 }, 1)).toEqual({ patch: { chatZoom: 1.1 }, value: 1.1 })
    expect(zoomPatch('atelier://settings', { uiZoom: 0.8, chatZoom: 1 }, -1)).toEqual({ patch: { uiZoom: 0.75 }, value: 0.75 })
    expect(zoomPatch('atelier://settings', { uiZoom: 0.5, chatZoom: 1 }, 0).value).toBe(1)
  })
})

describe('languages (ST-32)', () => {
  it('validates and canonicalises locale tags', () => {
    expect(canonicalTag('en-gb')).toBe('en-GB')
    expect(canonicalTag(' nl_BE ')).toBe('nl-BE')
    expect(canonicalTag('english')).toBeNull()
    expect(canonicalTag('x')).toBeNull()
    expect(canonicalTag('en-')).toBeNull()
  })

  it('adds, orders and removes up to ten, refusing duplicates', () => {
    expect(addLanguage(['en-US'], 'nl')).toEqual({ list: ['en-US', 'nl'], error: null })
    expect(addLanguage(['en-US'], 'EN-us').error).toBe('duplicate')
    expect(addLanguage(['en-US'], '??').error).toBe('invalid')
    const full = Array.from({ length: LANGUAGES_MAX }, (_, i) => ['en', 'nl', 'fr', 'de', 'es', 'it', 'pt', 'sv', 'da', 'fi'][i] ?? 'ja')
    expect(addLanguage(full, 'ja').error).toBe('full')
    expect(moveLanguage(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveLanguage(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(removeLanguage(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(acceptLanguageHeader(['nl-BE', 'en'])).toMatch(/^nl-BE,.*en;q=0\.\d/)
  })
})

describe('clear browsing data (ST-36)', () => {
  const now = 10 * 24 * 3_600_000
  const history = [
    { url: 'https://a.example/page', lastVisit: now - 30 * 60_000 },
    { url: 'https://b.example/', lastVisit: now - 3 * 24 * 3_600_000 },
    { url: 'atelier://settings', lastVisit: now - 1000 },
    { url: 'not a url', lastVisit: now },
  ]

  it('reaches back by range and finds the origins visited in it', () => {
    expect(rangeStart('all', now)).toBeNull()
    expect(rangeStart('hour', now)).toBe(now - 3_600_000)
    expect(originsVisitedSince(history, now - 3_600_000)).toEqual(['https://a.example'])
    expect(originsVisitedSince(history, 0)).toEqual(['https://a.example', 'https://b.example'])
  })

  it('maps each option set to what gets cleared', () => {
    expect(clearPlan({ range: 'all', history: false, siteData: false, cache: true }, history, now)).toEqual({ historySince: false, siteData: false, cache: { origins: null } })
    expect(clearPlan({ range: 'all', history: true, siteData: true, cache: false }, history, now)).toEqual({ historySince: null, siteData: { origins: null }, cache: false })
    expect(clearPlan({ range: 'week', history: true, siteData: true, cache: true }, history, now)).toEqual({
      historySince: now - 7 * 24 * 3_600_000,
      siteData: { origins: ['https://a.example', 'https://b.example'] },
      cache: { origins: ['https://a.example', 'https://b.example'] },
    })
  })
})

describe('reset plan (ST-55)', () => {
  const off: Array<() => void> = []
  afterEach(() => off.splice(0).forEach((f) => f()))

  it('runs steps in order, skips secrets unless asked, and a dry run deletes nothing', async () => {
    const ran: string[] = []
    const step = (id: string, order: number, secrets = false) =>
      registerResetStep({ id, order, label: id, secrets, run: async ({ dryRun }) => (ran.push(`${id}:${dryRun}`), { removed: [`${id}.json`] }) })
    off.push(step('t-settings', 90), step('t-chats', 20), step('t-key', 100, true))
    expect(resetSteps().map((s) => s.id)).toEqual(['t-chats', 't-settings', 't-key'])
    expect(() => step('t-chats', 1)).toThrow(/already registered/)
    expect(await runResetSteps({ secrets: false, dryRun: true })).toEqual({ removed: ['t-chats.json', 't-settings.json'] })
    expect(ran).toEqual(['t-chats:true', 't-settings:true'])
    expect((await runResetSteps({ secrets: true, dryRun: true })).removed).toContain('t-key.json')
  })
})

describe('storage categories (ST-53)', () => {
  it('measures in order and shows a failed one as zero', async () => {
    const off = [
      registerStorageCategory({ id: 't-b', label: 'B', order: 2, measure: async () => 200, clear: { label: 'Clear', run: async () => undefined } }),
      registerStorageCategory({ id: 't-a', label: 'A', order: 1, measure: async () => 100 }),
      registerStorageCategory({ id: 't-bad', label: 'Bad', order: 3, measure: async () => Promise.reject(new Error('EACCES')) }),
    ]
    try {
      const views = (await measureStorage()).filter((v) => v.id.startsWith('t-'))
      expect(views).toEqual([
        { id: 't-a', label: 'A', order: 1, bytes: 100, clearLabel: null },
        { id: 't-b', label: 'B', order: 2, bytes: 200, clearLabel: 'Clear' },
        { id: 't-bad', label: 'Bad', order: 3, bytes: 0, clearLabel: null },
      ])
    } finally {
      off.forEach((f) => f())
    }
  })
})

describe('notifications (NS-01)', () => {
  const ctx = { enabled: true, categories: { 'needs-you': true, 'chat-updates': false }, mutedChat: (id: string) => id === 'muted', chatInView: (id: string) => id === 'open' }

  it('suppresses by master switch, category, mute, view and focus', () => {
    expect(shouldNotify({ category: 'needs-you', target: { chatId: 'c1' } }, ctx)).toBe(true)
    expect(shouldNotify({ category: 'needs-you', target: { chatId: 'c1' } }, { ...ctx, enabled: false })).toBe(false)
    expect(shouldNotify({ category: 'chat-updates', target: { chatId: 'c1' } }, ctx)).toBe(false)
    expect(shouldNotify({ category: 'needs-you', target: { chatId: 'muted' } }, ctx)).toBe(false)
    expect(shouldNotify({ category: 'needs-you', target: { chatId: 'open' } }, ctx)).toBe(false)
    expect(shouldNotify({ category: 'downloads', target: {} }, { ...ctx, appFocused: true })).toBe(false)
    expect(shouldNotify({ category: 'downloads', target: {}, sticky: true }, { ...ctx, appFocused: true })).toBe(true)
  })

  it('offers Allow and Deny on macOS only, and honours sounds and silent', () => {
    expect(notificationButtons(['allow', 'deny'], 'darwin')).toEqual(['allow', 'deny'])
    expect(notificationButtons(['allow', 'deny'], 'win32')).toEqual([])
    expect(notificationSilent({}, false)).toBe(true)
    expect(notificationSilent({}, true)).toBe(false)
    expect(notificationSilent({ silent: true }, true)).toBe(true)
    expect(targetKey({ chatId: 'c1' })).not.toBeNull()
  })

  it('presents, focuses on click, and clears a chat once it is viewed', () => {
    shown.length = 0
    const viewed = new Set<string>()
    const focused: unknown[] = []
    const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: true, sounds: false } }
    const p = createSystemPresenter({
      settings: () => settings,
      mutedChat: () => false,
      chatInView: (id) => viewed.has(id),
      appFocused: () => false,
      focusTarget: (t) => focused.push(t),
      openSettings: () => undefined,
      platform: 'darwin',
    })
    const actions: string[] = []
    p.present({ category: 'needs-you', title: 'Allow?', body: 'Pip wants to send a form', target: { chatId: 'c1' }, sticky: true, actions: ['allow', 'deny'], onAction: (a) => actions.push(a) })
    expect(shown).toHaveLength(1)
    expect(shown[0]?.options).toMatchObject({ timeoutType: 'never', silent: true })
    shown[0]?.handlers.get('action')?.({}, 0)
    expect(actions).toEqual(['allow'])
    expect(shown[0]?.closed).toBe(true)

    p.present({ category: 'needs-you', title: 'Done', body: '', target: { chatId: 'c2' } })
    shown[1]?.handlers.get('click')?.()
    expect(focused).toEqual([{ chatId: 'c2' }])

    p.present({ category: 'needs-you', title: 'Again', body: '', target: { chatId: 'c3' } })
    expect(p.openCount()).toBe(1)
    viewed.add('c3')
    p.clearViewed()
    expect(p.openCount()).toBe(0)
    // While the chat is in view, nothing new is shown.
    p.present({ category: 'needs-you', title: 'Hidden', body: '', target: { chatId: 'c3' } })
    expect(shown).toHaveLength(3)
  })
})

describe('attention (NS-02)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('counts unread chats and caps the badge', () => {
    const chat = { unread: true, archived: false, draft: false, status: 'idle', needsInput: false }
    expect(attentionCounts([chat, { ...chat, archived: true }, { ...chat, draft: true }, { ...chat, unread: false, status: 'needs-approval' }])).toEqual({ unread: 1, needsYou: 1 })
    expect(badgeText(0)).toBe('')
    expect(badgeText(7)).toBe('7')
    expect(badgeText(120)).toBe('99+')
  })

  it('debounces a burst into one badge update with the latest value', () => {
    const applied: number[] = []
    const d = debounced<number>(400, (v) => applied.push(v))
    d.push(1)
    d.push(2)
    vi.advanceTimersByTime(399)
    d.push(3)
    vi.advanceTimersByTime(399)
    expect(applied).toEqual([])
    vi.advanceTimersByTime(1)
    expect(applied).toEqual([3])
    d.push(4)
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(applied).toEqual([3])
  })

  it('bounces once per chat that starts waiting on an approval', () => {
    const before = new Map([
      ['a', 'running'],
      ['b', 'needs-approval'],
    ])
    expect(newlyWaiting(before, [{ id: 'a', status: 'needs-approval' }, { id: 'b', status: 'needs-approval' }, { id: 'new', status: 'needs-approval' }])).toEqual(['a'])
  })
})

describe('Dock icon choice (ST-09)', () => {
  const flags = [
    { id: 'pip', dockIcon: false },
    { id: 'juniper', dockIcon: true },
  ]
  it('migrates the old per-companion flag, preferring the active companion', () => {
    expect(migratedDockChoice({ kind: 'standard' }, flags, 'pip')).toEqual({ kind: 'companion', companionId: 'juniper' })
    expect(migratedDockChoice({ kind: 'standard' }, flags.map((f) => ({ ...f, dockIcon: true })), 'pip')).toEqual({ kind: 'companion', companionId: 'pip' })
    expect(migratedDockChoice({ kind: 'companion', companionId: 'pip' }, flags, 'pip')).toBeNull()
  })
  it('falls back to standard when the chosen companion is deleted, and keeps flags in step', () => {
    expect(resolveDockChoice({ kind: 'companion', companionId: 'gone' }, flags)).toEqual({ kind: 'standard' })
    expect(flagPatches({ kind: 'companion', companionId: 'pip' }, flags)).toEqual([
      { id: 'pip', dockIcon: true },
      { id: 'juniper', dockIcon: false },
    ])
    expect(choiceFromFlags({ kind: 'companion', companionId: 'juniper' }, flags, flags.map((f) => ({ ...f, dockIcon: false })))).toEqual({ kind: 'standard' })
  })
})

describe('browser import (ST-46)', () => {
  it('keeps the type matrix per browser kind (cookies are platform-gated, not in the static matrix)', () => {
    expect(BROWSER_TYPES.chromium).toEqual(['bookmarks', 'history', 'tabs', 'searchEngines', 'addresses'])
    expect(BROWSER_TYPES.firefox).toContain('addresses')
    expect(BROWSER_TYPES.safari).toEqual(['bookmarks', 'history'])
    expect(IMPORT_TYPES).toContain('cookies')
  })

  it('finds Chromium profiles and Safari behind Full Disk Access on fixtures', async () => {
    const home = tempDir()
    const chrome = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    mkdirSync(join(chrome, 'Default'), { recursive: true })
    mkdirSync(join(chrome, 'Profile 1'), { recursive: true })
    writeFileSync(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' }, '../evil': { name: 'x' } } } }))
    writeFileSync(
      join(chrome, 'Default', 'Bookmarks'),
      JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'Example', url: 'https://example.com/' }] } } }),
    )
    mkdirSync(join(home, 'Library', 'Safari'), { recursive: true })
    expect(chromiumProfiles(chrome).map((p) => p.name)).toEqual(['Personal', 'Work'])
    const found = detectBrowsers('darwin', home, {})
    expect(found.map((b) => b.id)).toEqual(['chrome', 'safari'])
    expect(found.find((b) => b.id === 'safari')).toMatchObject({ needsAccess: true, types: ['bookmarks', 'history'] })
    // Cookies are offered for Chromium on macOS only, and sit last in the list.
    expect(found.find((b) => b.id === 'chrome')?.types).toEqual(['bookmarks', 'history', 'tabs', 'searchEngines', 'addresses', 'cookies'])
    const bookmarks = await profileReader('darwin', home, {}, 'chrome', 'Default').bookmarks()
    expect(bookmarks).toEqual([{ url: 'https://example.com/', title: 'Example' }])
    expect(() => profileReader('darwin', home, {}, 'chrome', 'Profile 9')).toThrow()
  })

  it('reports progress per type and sums up success, partial, nothing and error', async () => {
    const sinks: ImportSinks = { bookmarks: (items) => items.length, history: (items) => items.length, tabs: (items) => items.length, searchEngines: (items) => items.length, addresses: (items) => items.length, cookies: (items) => items.length }
    const reader = (fail: string[] = [], empty = false): ProfileReader => ({
      bookmarks: async () => (fail.includes('bookmarks') ? Promise.reject(new Error('SQLITE_BUSY')) : empty ? [] : [{ url: 'https://a.example', title: 'A' }]),
      history: async () => (fail.includes('history') ? Promise.reject(new Error('EPERM')) : []),
      // As Windows says it while the browser holds its open session file.
      tabs: async () => (fail.includes('tabs') ? Promise.reject(new Error("EBUSY: resource busy or locked, open 'C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Sessions\\Session_1'")) : []),
      searchEngines: async () => [],
      addresses: async () => [],
      cookies: async () => [],
    })
    const progress: ImportProgress[] = []
    const ok = await runImport(reader(), sinks, { browserId: 'chrome', profileId: 'Default', types: ['bookmarks', 'history'] }, (p) => progress.push(p))
    expect(ok).toMatchObject({ outcome: 'success', counts: { bookmarks: 1, history: 0 }, failed: [] })
    expect(progress.map((p) => p.current)).toEqual(['bookmarks', 'history', null])
    expect((await runImport(reader(['history']), sinks, { browserId: 'c', profileId: 'D', types: ['bookmarks', 'history'] }, () => undefined)).outcome).toBe('partial')
    expect((await runImport(reader([], true), sinks, { browserId: 'c', profileId: 'D', types: ['bookmarks'] }, () => undefined)).outcome).toBe('nothing')
    const failed = await runImport(reader(['bookmarks', 'history']), sinks, { browserId: 'c', profileId: 'D', types: ['bookmarks', 'history'] }, () => undefined)
    expect(failed.outcome).toBe('error')
    expect(failed.failed.map((f) => f.type)).toEqual(['bookmarks', 'history'])
    // A file the other browser has locked reads as "quit it and try again", on Windows as with SQLite.
    const locked = await runImport(reader(['bookmarks', 'tabs']), sinks, { browserId: 'brave', profileId: 'Default', types: ['bookmarks', 'tabs'] }, () => undefined)
    expect(locked.failed[1]?.message).toBe(locked.failed[0]?.message)
    expect(locked.failed[1]?.message).not.toMatch(/EBUSY|C:\\/)
  })
})

describe('licence list (ST-56)', () => {
  it('walks production dependencies once each, with licence text', () => {
    const root = tempDir()
    const pkg = (dir: string, json: Record<string, unknown>, license?: string): void => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
      if (license) writeFileSync(join(dir, 'LICENSE'), license)
    }
    pkg(root, { name: 'app', dependencies: { alpha: '1', beta: '1' }, devDependencies: { tooling: '1' } })
    pkg(join(root, 'node_modules', 'alpha'), { name: 'alpha', version: '1.0.0', license: 'MIT', dependencies: { shared: '1' } }, 'MIT text')
    pkg(join(root, 'node_modules', 'beta'), { name: 'beta', version: '2.0.0', licenses: [{ type: 'Apache-2.0' }], dependencies: { shared: '1' } })
    pkg(join(root, 'node_modules', 'shared'), { name: 'shared', version: '3.0.0', license: { type: 'ISC' } })
    pkg(join(root, 'node_modules', 'tooling'), { name: 'tooling', version: '1.0.0', license: 'MIT' })
    const out = collectLicenses(root, { extra: [], native: [], models: [] }) as Array<{ name: string; license: string; text: string }>
    expect(out.map((e) => `${e.name}:${e.license}`)).toEqual(['alpha:MIT', 'beta:Apache-2.0', 'shared:ISC'])
    expect(out[0]?.text).toBe('MIT text')
    expect(licenseOf(null)).toBe('UNKNOWN')
  })
})
