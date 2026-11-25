/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, BrowserWindow, session as electronSession, type Session, type WebContents } from 'electron'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '@shared/i18n/core'
import { registerMenuContribution } from '@shared/menuModel'
import type { ProfileHue } from '@shared/profile'
import { DEFAULT_PROFILE_ID, PROFILES_SETTINGS_URL, profileDeleteBlock, profilePartition, type Profile, type ProfileDeletionSummary, type ProfilesEvent, type ProfilesServices } from '@shared/profiles'
import type { SessionInfo } from '../features/types'
import type { SettingsStore } from '../settings'
import { log } from '../log'
import { PROFILE_MENU, appProfilesItems, dockProfileItems, newWindowItems, profileBlockItems, profileIdFromItem } from './menus'
import { profileDataDir } from './paths'
import { ProfileError, ProfileStore } from './store'
import { folderBytes, historyFileCount, sumSummaries } from './summary'
import { clearWindowProfile, profileOfContents, profileOfWindowId, setWindowProfile } from './windowProfiles'

// Profiles (SH-64): one persistent session and data folder
// per profile, profiles.json, the settings scope split's profile side, the
// window bootstrap per profile and the profile menus.

export interface ProfileManager {
  /** The profile's session; the first call runs every Feature.session installer on it once. */
  sessionFor(id: string): Session
  /** Feature.session runs through this for every profile session. Returns an unsubscribe. */
  onSessionCreated(cb: (session: Session, profile: Profile) => void): () => void
  /** The default profile keeps its data at the top of the data folder; the rest live in profiles/<id>/. */
  dataDir(id: string): string
  /** The profile a webContents (a window's chrome or a tab) belongs to. */
  profileOf(webContents: WebContents): string
  windowsOf(id: string): BrowserWindow[]
  list(): Profile[]
  get(id: string): Profile | null
  /** Records a window's profile (windowContext does this for every window it builds). */
  attachWindow(win: BrowserWindow, profileId: string): void
  /** One instance per profile of a per-profile store (history, pinned tabs, bookmarks, downloads…), made on first use in the profile's data folder. */
  store<T>(id: string, name: string, create: (dataDir: string) => T): T
  /** Counts only another feature knows (the chats or companions a profile owns), added to the deletion summary. */
  addSummarySource(source: (id: string) => Partial<ProfileDeletionSummary>): () => void
  /** Runs before a profile's data goes (stop its work, close its stores). */
  onRemoving(cb: (id: string) => void | Promise<void>): () => void
}

/** What the profile manager needs from the window manager (WindowManager fits). */
export interface ProfileWindows {
  all(): { id: number; kind: string; window: BrowserWindow; tabs: { all(): readonly { agentChatId: string | null }[]; openInternal(url: string): unknown } }[]
  focused(): { id: number } | null
  open(kind: 'normal', options: { profileId: string; url?: string }): number
}

export interface ProfilesDeps {
  dataDir: string
  settings: SettingsStore
  broadcast(event: ProfilesEvent): void
  windows?: ProfileWindows
  /** Stops a chat's run (the agent host). */
  stopChat?(chatId: string): void
  /** Where Electron keeps persistent partitions; userData/Partitions by default. */
  partitionsDir?: string
  fromPartition?(partition: string): Session
}

export interface Profiles {
  services: ProfilesServices
  manager: ProfileManager
  /** The window-scoped part of Services.profiles: current() is the asking window's profile. */
  windowServices(windowId: number): Partial<ProfilesServices['profiles']>
  dispose(): void | Promise<void>
}

// ── session installers ──
// startFeatures owns the installers; index.ts hands them over once features
// have started. Sessions made before that are installed then.
type Installer = (session: Session, info: SessionInfo) => void
let installer: Installer | null = null
const waiting: { session: Session; info: SessionInfo; done(): void }[] = []

/**
 * Session set-up that index.ts still wires by hand for the default session
 * (the permission broker, the ad blocker's start state) runs here for each
 * profile session, after the Feature.session installers.
 */
const bootstrapCallbacks = new Set<(session: Session, profile: Profile) => void>()
export function onProfileSession(cb: (session: Session, profile: Profile) => void): () => void {
  bootstrapCallbacks.add(cb)
  return () => bootstrapCallbacks.delete(cb)
}

export function attachSessionInstaller(install: Installer): void {
  installer = install
  for (const w of waiting.splice(0)) {
    install(w.session, w.info)
    w.done()
  }
}

export function setupProfiles(deps: ProfilesDeps): Profiles {
  const store = new ProfileStore(deps.dataDir, { defaultHue: deps.settings.get().profileHue })
  const sessions = new Map<string, Session>()
  const listeners = new Set<(session: Session, profile: Profile) => void>()
  const removing = new Set<(id: string) => void | Promise<void>>()
  const summarySources = new Set<(id: string) => Partial<ProfileDeletionSummary>>()
  const stores = new Map<string, Map<string, unknown>>()
  const fromPartition = deps.fromPartition ?? ((p: string) => electronSession.fromPartition(p))
  const partitionsDir = (): string => deps.partitionsDir ?? join(app.getPath('userData'), 'Partitions')

  const dataDir = (id: string): string => profileDataDir(deps.dataDir, id)
  const require = (id: string): Profile => store.require(id)
  const allWindows = (): BrowserWindow[] => (deps.windows ? deps.windows.all().map((w) => w.window) : BrowserWindow.getAllWindows())
  const windowsOf = (id: string): BrowserWindow[] => allWindows().filter((w) => !w.isDestroyed() && profileOfWindowId(w.id) === id)
  const focusedProfile = (): string => profileOfWindowId(deps.windows?.focused()?.id ?? BrowserWindow.getFocusedWindow()?.id)

  // SettingsView.profile, and the profile settings' hue kept in step with profiles.json.
  deps.settings.setProfileResolver((id) => store.get(id))
  const onSettings = (id: string, next: { profileHue: ProfileHue }): void => {
    const profile = store.get(id)
    if (profile && profile.hue !== next.profileHue) store.setHue(id, next.profileHue)
  }
  deps.settings.on('profileChanged', onSettings)
  const emit = (): void => deps.broadcast({ type: 'profiles', items: store.list(), currentId: focusedProfile() })
  store.on('changed', emit)

  const installed = (ses: Session, profile: Profile): void => {
    for (const cb of [...bootstrapCallbacks, ...listeners]) {
      try {
        cb(ses, profile)
      } catch (err) {
        log.error('profiles', 'a session callback failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  const manager: ProfileManager = {
    sessionFor(id) {
      const known = sessions.get(id)
      if (known) return known
      const profile = require(id)
      const ses = fromPartition(profile.partition)
      sessions.set(id, ses)
      const info: SessionInfo = { private: false, partition: profile.partition }
      if (installer) {
        installer(ses, info)
        installed(ses, profile)
      } else {
        waiting.push({ session: ses, info, done: () => installed(ses, profile) })
      }
      return ses
    },
    onSessionCreated(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dataDir,
    profileOf(webContents) {
      for (const [id, ses] of sessions) if (webContents.session === ses) return id
      return profileOfContents(webContents)
    },
    windowsOf,
    list: () => store.list(),
    get: (id) => store.get(id),
    attachWindow(win, profileId) {
      const id = win.id
      setWindowProfile(id, profileId)
      win.once('closed', () => clearWindowProfile(id))
      emit()
    },
    store<T>(id: string, name: string, create: (dir: string) => T): T {
      let byName = stores.get(id)
      if (!byName) stores.set(id, (byName = new Map()))
      if (!byName.has(name)) byName.set(name, create(dataDir(id)))
      return byName.get(name) as T
    },
    addSummarySource(source) {
      summarySources.add(source)
      return () => summarySources.delete(source)
    },
    onRemoving(cb) {
      removing.add(cb)
      return () => removing.delete(cb)
    },
  }

  const openIn = (id: string): number | null => {
    require(id)
    const existing = windowsOf(id)[0]
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return existing.id
    }
    return deps.windows ? deps.windows.open('normal', { profileId: id }) : null
  }

  const deletionSummary = (id: string): ProfileDeletionSummary => {
    const profile = require(id)
    const wins = deps.windows?.all().filter((w) => profileOfWindowId(w.id) === id && w.kind !== 'popup') ?? []
    const history = stores.get(id)?.get('history') as { entries(): Iterable<unknown> } | undefined
    const ses = sessions.get(id)
    const own: Partial<ProfileDeletionSummary> = {
      tabs: wins.reduce((n, w) => n + w.tabs.all().length, 0),
      historyEntries: history ? [...history.entries()].length : historyFileCount(dataDir(id)),
      siteDataBytes: folderBytes(ses?.storagePath ?? join(partitionsDir(), profile.partition.replace(/^persist:/, ''))),
    }
    const parts: Partial<ProfileDeletionSummary>[] = [own]
    for (const source of summarySources) {
      try {
        parts.push(source(id))
      } catch {
        // A count that fails is left out, never the whole summary.
      }
    }
    return sumSummaries(parts)
  }

  const remove = async (id: string, typedName: string): Promise<void> => {
    const profile = require(id)
    const block = profileDeleteBlock(id, store.list())
    if (block) throw new ProfileError(t(`profiles.block.${block}`))
    if (typedName !== profile.name) throw new ProfileError(t('profiles.error.typedName'))
    // Agent runs on its tabs stop first, then its windows close without asking.
    for (const w of deps.windows?.all() ?? []) {
      if (profileOfWindowId(w.id) !== id) continue
      for (const tab of w.tabs.all()) if (tab.agentChatId) deps.stopChat?.(tab.agentChatId)
    }
    for (const cb of [...removing]) await Promise.resolve(cb(id)).catch(() => undefined)
    for (const win of windowsOf(id)) win.destroy()
    const ses = sessions.get(id) ?? fromPartition(profile.partition)
    await ses.clearStorageData().catch(() => undefined)
    await ses.clearCache().catch(() => undefined)
    await ses.clearAuthCache().catch(() => undefined)
    const storagePath = ses.storagePath ?? join(partitionsDir(), profile.partition.replace(/^persist:/, ''))
    sessions.delete(id)
    stores.delete(id)
    deps.settings.forgetProfile(id)
    store.remove(id)
    for (const path of [storagePath, dataDir(id)]) {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 })
      } catch (err) {
        log.warn('profiles', 'a profile folder could not be removed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  const services: ProfilesServices = {
    profiles: {
      list: () => store.list(),
      current: () => require(focusedProfile()),
      create(input) {
        const profile = store.create(input)
        deps.settings.createProfile(profile.id, { profileHue: profile.hue })
        openIn(profile.id)
        return profile
      },
      rename: (id, name) => store.rename(id, name),
      setHue(id, hue) {
        require(id)
        // Through the settings, so the profile's windows recolour; the listener above updates profiles.json.
        deps.settings.updateFor(id, { profileHue: hue })
        return require(id)
      },
      switchTo(id) {
        openIn(id)
      },
      deletionSummary,
      remove,
    },
  }

  // ── menus ── (registerMenuContribution only; A builds the rest)
  const runItem = (itemId: string, windowId: number | null): void => {
    const target = profileIdFromItem(itemId, PROFILE_MENU.switchTo) ?? profileIdFromItem(itemId, PROFILE_MENU.appTo) ?? profileIdFromItem(itemId, PROFILE_MENU.dockTo)
    if (target) return void openIn(target)
    const fresh = profileIdFromItem(itemId, PROFILE_MENU.newWindowIn)
    if (fresh) return void deps.windows?.open('normal', { profileId: fresh })
    const pages = (url: string): void => {
      const id = windowId ?? deps.windows?.focused()?.id ?? null
      deps.windows?.all().find((w) => w.id === id)?.tabs.openInternal(url)
    }
    if (itemId === PROFILE_MENU.manage) pages(PROFILES_SETTINGS_URL)
    else if (itemId === PROFILE_MENU.import) pages('atelier://settings/import')
    else if (itemId === PROFILE_MENU.add) pages(`${PROFILES_SETTINGS_URL}?new=1`)
  }
  const profileOfMenu = (s: { focusedWindow: { id: number } | null }): string => profileOfWindowId(s.focusedWindow?.id)
  const unregister = [
    registerMenuContribution({
      id: 'c-profiles:main-menu',
      target: 'main-menu:profile',
      build: (s) => profileBlockItems(store.list(), profileOfMenu(s)),
      run: runItem,
    }),
    registerMenuContribution({ id: 'c-profiles:app', target: 'app', after: 'open-settings', build: (s) => appProfilesItems(store.list(), profileOfMenu(s)), run: runItem }),
    registerMenuContribution({ id: 'c-profiles:file', target: 'file', after: 'new-window', build: () => newWindowItems(store.list()), run: runItem }),
    registerMenuContribution({ id: 'c-profiles:dock', target: 'dock', after: 'core-dock-separator', build: () => dockProfileItems(store.list()), run: runItem }),
  ]

  return {
    services,
    manager,
    windowServices: (windowId) => ({ current: () => require(profileOfWindowId(windowId)) }),
    dispose() {
      for (const off of unregister) off()
      deps.settings.off('profileChanged', onSettings)
      deps.settings.setProfileResolver(null)
      store.removeAllListeners()
      listeners.clear()
    },
  }
}
