/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null },
  session: { fromPartition: () => null },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { PROFILE_ID, checkProfileName, profileDeleteBlock, profileInitial, profilePartition, type Profile } from '@shared/profiles'
import { SettingsStore } from '../src/main/settings'
import { appProfilesItems, dockProfileItems, newWindowItems, profileAvatarUrl, profileBlockItems, profileIdFromItem } from '../src/main/profiles/menus'
import { attachSessionInstaller, setupProfiles, type Profiles, type ProfileWindows } from '../src/main/profiles/service'
import { ProfileStore, newProfileId } from '../src/main/profiles/store'
import { folderBytes, sumSummaries } from '../src/main/profiles/summary'
import { clearWindowProfile, setWindowProfile } from '../src/main/profiles/windowProfiles'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-profiles-'))
let ids = 0
const nextId = (): string => `prof${String(++ids).padStart(4, '0')}`

describe('profile rules', () => {
  it('names partitions and ids safely', () => {
    expect(profilePartition('default')).toBe('persist:atelier-web')
    expect(profilePartition('a1b2c3d4e5f6')).toBe('persist:atelier-profile-a1b2c3d4e5f6')
    for (let i = 0; i < 20; i++) expect(newProfileId()).toMatch(PROFILE_ID)
  })

  it('checks names: trimmed, not empty, not too long, not taken', () => {
    const others = [{ id: 'default', name: 'Personal' }]
    expect(checkProfileName('  Work   stuff ', others)).toEqual({ ok: true, name: 'Work stuff' })
    expect(checkProfileName('   ', others)).toEqual({ ok: false, problem: 'empty' })
    expect(checkProfileName('x'.repeat(41), others)).toEqual({ ok: false, problem: 'long' })
    expect(checkProfileName('personal', others)).toEqual({ ok: false, problem: 'taken' })
    // Renaming a profile to its own name (in another case) is fine.
    expect(checkProfileName('PERSONAL', others, 'default')).toEqual({ ok: true, name: 'PERSONAL' })
  })

  it('guards the last and the default profile', () => {
    expect(profileDeleteBlock('default', [{ id: 'default' }])).toBe('last')
    expect(profileDeleteBlock('default', [{ id: 'default' }, { id: 'work1234' }])).toBe('default')
    expect(profileDeleteBlock('work1234', [{ id: 'default' }, { id: 'work1234' }])).toBeNull()
  })

  it('takes the first letter or digit as the initial', () => {
    expect(profileInitial('  work')).toBe('W')
    expect(profileInitial('🙂 Éva')).toBe('É')
    expect(profileInitial('***')).toBe('?')
  })
})

describe('ProfileStore', () => {
  it('always has the default profile and keeps created ones', () => {
    const dir = tempDir()
    const store = new ProfileStore(dir, { defaultHue: 'tide', newId: nextId, now: () => 5 })
    expect(store.list()).toMatchObject([{ id: 'default', name: 'Personal', hue: 'tide', isDefault: true, partition: 'persist:atelier-web' }])
    const work = store.create({ name: ' Work ', hue: 'moss' })
    expect(work).toMatchObject({ name: 'Work', hue: 'moss', createdAt: 5, isDefault: false, partition: `persist:atelier-profile-${work.id}` })
    expect(() => store.create({ name: 'work', hue: 'sun' })).toThrow(/already has that name/)
    expect(() => store.rename(work.id, '')).toThrow(/needs a name/)
    store.rename(work.id, 'Office')
    store.setHue(work.id, 'clay')
    const again = new ProfileStore(dir)
    expect(again.get(work.id)).toMatchObject({ name: 'Office', hue: 'clay' })
    again.remove(work.id)
    expect(new ProfileStore(dir).list().map((p) => p.id)).toEqual(['default'])
    expect(() => again.remove('default')).toThrow()
  })

  it('drops broken and duplicate records but keeps the rest', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'profiles.json'),
      JSON.stringify({
        version: 1,
        items: [
          { id: 'abcd1234', name: 'Home', hue: 'fig', createdAt: 2 },
          { id: 'abcd1234', name: 'Again', hue: 'fig', createdAt: 3 },
          { id: 'BAD', name: 'Bad', hue: 'fig', createdAt: 1 },
          { id: 'efgh5678', name: 'home', hue: 'fig', createdAt: 4 },
          { id: 'ijkl9012', name: 'Trip', hue: 'neon', createdAt: 5 },
        ],
      }),
    )
    expect(new ProfileStore(dir).list().map((p) => p.name)).toEqual(['Personal', 'Home'])
    writeFileSync(join(dir, 'profiles.json'), '{not json')
    expect(new ProfileStore(dir).list()).toHaveLength(1)
  })
})

interface FakeTab {
  agentChatId: string | null
}
function fakeWindow(id: number, tabs: FakeTab[]) {
  const win = { id, destroyed: false, isDestroyed: () => win.destroyed, destroy: vi.fn(() => (win.destroyed = true)), isMinimized: () => false, restore: vi.fn(), focus: vi.fn(), once: vi.fn() }
  return { id, kind: 'normal', window: win, tabs: { all: () => tabs, openInternal: vi.fn() } }
}

function fakeSession(storagePath: string) {
  return { storagePath, clearStorageData: vi.fn(async () => undefined), clearCache: vi.fn(async () => undefined), clearAuthCache: vi.fn(async () => undefined) }
}

describe('setupProfiles', () => {
  let running: Profiles | null = null
  afterEach(async () => {
    await running?.dispose()
    running = null
  })

  function start(windows: ReturnType<typeof fakeWindow>[] = []) {
    const dir = tempDir()
    electron.userData = dir
    const settings = new SettingsStore(dir)
    const events: { items: Profile[]; currentId: string }[] = []
    const sessions = new Map<string, ReturnType<typeof fakeSession>>()
    const opened: string[] = []
    const stopped: string[] = []
    const wm: ProfileWindows = {
      all: () => windows as never,
      focused: () => windows[0] ?? null,
      open: (_kind, options) => {
        opened.push(options.profileId)
        return 99
      },
    }
    running = setupProfiles({
      dataDir: dir,
      settings,
      broadcast: (e) => events.push(e),
      windows: wm,
      stopChat: (id) => stopped.push(id),
      partitionsDir: join(dir, 'Partitions'),
      fromPartition: (partition) => {
        const s = sessions.get(partition) ?? fakeSession(join(dir, 'Partitions', partition.replace(/^persist:/, '')))
        sessions.set(partition, s)
        return s as never
      },
    })
    return { dir, settings, events, sessions, opened, stopped, profiles: running }
  }

  it('creates a profile with its own settings and opens a window in it', () => {
    const { profiles, settings, opened, events } = start()
    const work = profiles.services.profiles.create({ name: 'Work', hue: 'moss' })
    expect(opened).toEqual([work.id])
    expect(settings.getFor(work.id).profileHue).toBe('moss')
    expect(settings.viewFor(work.id).profile).toMatchObject({ name: 'Work' })
    expect(events.at(-1)?.items.map((p) => p.name)).toEqual(['Personal', 'Work'])
    expect(profiles.manager.dataDir(work.id)).toMatch(new RegExp(`profiles[\\\\/]${work.id}$`))
  })

  it('keeps the hue in step between profiles.json and the profile settings', () => {
    const { profiles, settings } = start()
    const home = profiles.services.profiles.create({ name: 'Home', hue: 'fig' })
    expect(profiles.services.profiles.setHue(home.id, 'tide').hue).toBe('tide')
    expect(settings.getFor(home.id).profileHue).toBe('tide')
    // Appearance changes the hue through the settings; the profile follows.
    settings.updateFor(home.id, { profileHue: 'sun' })
    expect(profiles.manager.get(home.id)?.hue).toBe('sun')
  })

  it('sets up each profile session once, through every installer, then the callbacks', () => {
    const { profiles } = start()
    const work = profiles.services.profiles.create({ name: 'Work', hue: 'moss' })
    const install = vi.fn()
    const created = vi.fn()
    profiles.manager.onSessionCreated(created)
    attachSessionInstaller(install)
    const ses = profiles.manager.sessionFor(work.id)
    expect(profiles.manager.sessionFor(work.id)).toBe(ses)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toEqual({ private: false, partition: `persist:atelier-profile-${work.id}` })
    expect(created).toHaveBeenCalledWith(ses, expect.objectContaining({ id: work.id }))
    expect(() => profiles.manager.sessionFor('nope1234')).toThrow(/no longer exists/)
  })

  it('summarises what a deletion removes', () => {
    const win = fakeWindow(41, [{ agentChatId: null }, { agentChatId: 'c1' }])
    const { profiles, dir } = start([win as never])
    const work = profiles.services.profiles.create({ name: 'Work', hue: 'moss' })
    setWindowProfile(41, work.id)
    mkdirSync(profiles.manager.dataDir(work.id), { recursive: true })
    writeFileSync(join(profiles.manager.dataDir(work.id), 'history.json'), JSON.stringify([{ url: 'a' }, { url: 'b' }, { url: 'c' }]))
    const site = join(dir, 'Partitions', `atelier-profile-${work.id}`)
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'Cookies'), 'x'.repeat(1000))
    profiles.manager.addSummarySource(() => ({ ownedChats: 4 }))
    profiles.manager.addSummarySource(() => {
      throw new Error('vault locked')
    })
    expect(profiles.services.profiles.deletionSummary(work.id)).toEqual({ tabs: 2, historyEntries: 3, siteDataBytes: 1000, ownedChats: 4, ownedCompanions: 0 })
    clearWindowProfile(41)
  })

  it('deletes only with the exact name, and never the last or default profile', async () => {
    const win = fakeWindow(42, [{ agentChatId: 'chat-1' }])
    const { profiles, settings, sessions, stopped, dir } = start([win as never])
    await expect(profiles.services.profiles.remove('default', 'Personal')).rejects.toThrow(/only profile/)
    const work = profiles.services.profiles.create({ name: 'Work', hue: 'moss' })
    await expect(profiles.services.profiles.remove('default', 'Personal')).rejects.toThrow(`data ${BRAND_NAME} started with`)
    await expect(profiles.services.profiles.remove(work.id, 'work')).rejects.toThrow(/exactly/)
    setWindowProfile(42, work.id)
    settings.updateFor(work.id, { theme: 'dark' })
    const removing = vi.fn()
    profiles.manager.onRemoving(removing)
    await profiles.services.profiles.remove(work.id, 'Work')
    expect(stopped).toEqual(['chat-1'])
    expect(removing).toHaveBeenCalledWith(work.id)
    const ses = sessions.get(`persist:atelier-profile-${work.id}`)!
    expect(ses.clearStorageData).toHaveBeenCalled()
    expect(existsSync(join(dir, 'profiles', work.id))).toBe(false)
    expect(profiles.services.profiles.list().map((p) => p.id)).toEqual(['default'])
    expect(settings.getFor(work.id).theme).toBe('system')
    expect(JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')).items).toHaveLength(1)
    clearWindowProfile(42)
  })

  it('switches by focusing the profile window or opening one', () => {
    const win = fakeWindow(43, [])
    const { profiles, opened } = start([win as never])
    const work = profiles.services.profiles.create({ name: 'Work', hue: 'moss' })
    opened.length = 0
    profiles.services.profiles.switchTo('default')
    expect(opened).toEqual([])
    setWindowProfile(43, work.id)
    profiles.services.profiles.switchTo(work.id)
    expect(win.window.focus).toHaveBeenCalled()
    profiles.services.profiles.switchTo('default')
    expect(opened).toEqual(['default'])
    expect(profiles.windowServices(43).current?.().id).toBe(work.id)
    clearWindowProfile(43)
  })
})

describe('profile menus', () => {
  const list: Profile[] = [
    { id: 'default', name: 'Personal', hue: 'stone', createdAt: 0, partition: 'persist:atelier-web', isDefault: true },
    { id: 'work1234', name: 'Work', hue: 'moss', createdAt: 1, partition: 'persist:atelier-profile-work1234', isDefault: false },
  ]

  it('builds the main menu profile block', () => {
    const items = profileBlockItems(list, 'work1234')
    expect(items.map((i) => i.id)).toEqual(['profile:current', 'profile:switch', 'profile:manage', 'profile:import'])
    expect(items[0]).toMatchObject({ label: 'Work', variant: 'header' })
    expect(items[1]?.submenu?.map((i) => i.id)).toEqual(['profile:current', 'profile:switch:default', 'profile:switch-sep', 'profile:add'])
    // One profile: no header (the menu's head already names the person), just Switch › Add, Manage and Import.
    expect(profileBlockItems(list.slice(0, 1), 'default').map((i) => i.id)).toEqual(['profile:switch', 'profile:manage', 'profile:import'])
    expect(profileAvatarUrl(list[1]!)).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('builds the app, file and Dock menus', () => {
    const app = appProfilesItems(list, 'default')[0]!
    expect(app.submenu?.filter((i) => i.type === 'checkbox').map((i) => [i.label, i.checked])).toEqual([
      ['Personal', true],
      ['Work', false],
    ])
    expect(newWindowItems(list)[0]?.submenu?.map((i) => i.id)).toEqual(['new-window-in-profile:default', 'new-window-in-profile:work1234'])
    expect(newWindowItems(list.slice(0, 1))).toEqual([])
    expect(dockProfileItems(list).map((i) => i.id)).toEqual(['dock-profile:default', 'dock-profile:work1234', 'dock-profile-separator'])
    expect(dockProfileItems(list.slice(0, 1))).toEqual([])
    expect(profileIdFromItem('dock-profile:work1234', 'dock-profile:')).toBe('work1234')
    expect(profileIdFromItem('dock-profile:../x', 'dock-profile:')).toBeNull()
  })

  it('sums summaries and sizes folders', () => {
    expect(sumSummaries([{ tabs: 2 }, { tabs: -1, ownedChats: Number.NaN }, { ownedChats: 3 }])).toMatchObject({ tabs: 2, ownedChats: 3 })
    expect(folderBytes(join(tmpdir(), 'atelier-does-not-exist'))).toBe(0)
  })
})

describe('Profiles page logic', async () => {
  const logic = await import('@shared/profiles')
  const summary = { tabs: 3, historyEntries: 120, siteDataBytes: 2_500_000, ownedChats: 0, ownedCompanions: 0 }

  it('lists what a deletion removes, and shared things only when owned', () => {
    // Passwords, addresses and cards are shared by every profile, so a deletion never lists them.
    expect(logic.deletionRows(summary).map((r) => r.key)).toEqual(['profiles.delete.tabs', 'profiles.delete.history', 'profiles.delete.siteData'])
    expect(logic.deletionRows({ ...summary, ownedChats: 1 }).map((r) => r.key)).toContain('profiles.delete.chats')
    expect(logic.deletionRows(summary)[2]?.vars?.size).toMatch(/MB/)
  })

  it('arms delete only on the exact name', () => {
    expect(logic.deleteArmed('Work', 'Work')).toBe(true)
    expect(logic.deleteArmed('work', 'Work')).toBe(false)
    expect(logic.deleteArmed('', '')).toBe(false)
  })

  it('explains name problems and delete blocks', () => {
    expect(logic.nameMessage('', [])).toEqual({ key: 'profiles.error.empty' })
    expect(logic.nameMessage('x'.repeat(50), [])).toEqual({ key: 'profiles.error.long', vars: { max: 40 } })
    expect(logic.nameMessage('Work', [{ id: 'a', name: 'work' }])).toEqual({ key: 'profiles.error.taken' })
    expect(logic.nameMessage('Work', [{ id: 'a', name: 'work' }], 'a')).toBeNull()
    expect(logic.deleteBlockMessage('last').key).toBe('profiles.block.last')
  })

  it('moves through the hues with the arrow keys and starts new profiles on an unused one', () => {
    expect(logic.nextHue('stone', 'ArrowRight')).toBe('fig')
    expect(logic.nextHue('stone', 'ArrowLeft')).toBe('peony')
    expect(logic.nextHue('fig', 'End')).toBe('peony')
    expect(logic.nextHue('fig', 'a')).toBeNull()
    expect(logic.freshHue([{ hue: 'stone' }, { hue: 'fig' }])).toBe('moss')
    expect(logic.hueSwatches()).toHaveLength(9)
    for (const s of logic.hueSwatches()) expect(s.light).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
