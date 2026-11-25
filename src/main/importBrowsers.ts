/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process'
import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { BROWSER_TYPES, importOutcome, type ImportBrowser, type ImportBrowserKind, type ImportCounts, type ImportProfile, type ImportProgress, type ImportRequest, type ImportSummary, type ImportType } from '@shared/browserImport'
import type { AddressInput } from '@shared/passwords'
import type { HistoryItem } from '@shared/services'
import { chromiumAddresses, firefoxProfileAddresses } from './importAddresses'
import { cookiesFilePath, deriveCookieKey, keychainPassword, readChromiumCookies, safeStorageService, type ImportedCookie } from './importCookies'
import { parseChromiumBookmarks, readChromium } from './importer'
import { mainT } from './i18n/mainT'
import { chromiumEngine, chromiumSessionTabs, firefoxEngines, firefoxSessionTabs, parseXmlPlist, readMozLz4, safariBookmarks, safariTimeToMs, type ImportedEngine, type ImportedTab } from './importFormats'
import { log } from './log'

// Browsers and their profiles on this computer, and importing the chosen
// types from one profile (ST-46, ON-03). Databases are copied before
// reading because the owning browser keeps them locked while it runs; the
// other browser's files are only ever read. Cookies (signed-in sessions) are
// an opt-in offered only for Chromium browsers on macOS; see importCookies.ts.
// Saved addresses go into the wallet, never cards; see importAddresses.ts.

const HISTORY_LIMIT = 5000
const TABS_LIMIT = 200

interface BrowserDef {
  id: string
  name: string
  kind: ImportBrowserKind
  /** Chromium: the "User Data" folder. Firefox: the folder holding profiles.ini. Safari: ~/Library/Safari. */
  root: string
}

export function browserDefs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): BrowserDef[] {
  const chromium = (id: string, name: string, root: string): BrowserDef => ({ id, name, kind: 'chromium', root })
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [
      chromium('chrome', 'Google Chrome', join(support, 'Google', 'Chrome')),
      chromium('arc', 'Arc', join(support, 'Arc', 'User Data')),
      chromium('brave', 'Brave', join(support, 'BraveSoftware', 'Brave-Browser')),
      chromium('edge', 'Microsoft Edge', join(support, 'Microsoft Edge')),
      chromium('vivaldi', 'Vivaldi', join(support, 'Vivaldi')),
      chromium('chromium', 'Chromium', join(support, 'Chromium')),
      { id: 'firefox', name: 'Firefox', kind: 'firefox', root: join(support, 'Firefox') },
      { id: 'safari', name: 'Safari', kind: 'safari', root: join(home, 'Library', 'Safari') },
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
      chromium('chrome', 'Google Chrome', join(local, 'Google', 'Chrome', 'User Data')),
      chromium('brave', 'Brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')),
      chromium('edge', 'Microsoft Edge', join(local, 'Microsoft', 'Edge', 'User Data')),
      chromium('vivaldi', 'Vivaldi', join(local, 'Vivaldi', 'User Data')),
      { id: 'firefox', name: 'Firefox', kind: 'firefox', root: join(roaming, 'Mozilla', 'Firefox') },
    ]
  }
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return [
    chromium('chrome', 'Google Chrome', join(config, 'google-chrome')),
    chromium('brave', 'Brave', join(config, 'BraveSoftware', 'Brave-Browser')),
    chromium('edge', 'Microsoft Edge', join(config, 'microsoft-edge')),
    chromium('chromium', 'Chromium', join(config, 'chromium')),
    chromium('vivaldi', 'Vivaldi', join(config, 'vivaldi')),
    { id: 'firefox', name: 'Firefox', kind: 'firefox', root: join(home, '.mozilla', 'firefox') },
  ]
}

/** Chromium profiles from "Local State" (names people gave them), falling back to the folders that look like profiles. */
export function chromiumProfiles(root: string): ImportProfile[] {
  const out: ImportProfile[] = []
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: unknown }> } }
    for (const [dir, info] of Object.entries(state.profile?.info_cache ?? {})) {
      if (/^[A-Za-z0-9 _-]{1,64}$/.test(dir) && existsSync(join(root, dir))) out.push({ id: dir, name: typeof info?.name === 'string' && info.name.trim() ? info.name.trim() : dir })
    }
  } catch {
    // No Local State; look at the folders.
  }
  if (out.length === 0) {
    try {
      for (const dir of readdirSync(root)) {
        if ((dir === 'Default' || /^Profile \d+$/.test(dir)) && (existsSync(join(root, dir, 'Bookmarks')) || existsSync(join(root, dir, 'History')))) out.push({ id: dir, name: dir === 'Default' ? 'Default' : dir })
      }
    } catch {
      // Not installed.
    }
  }
  return out.sort((a, b) => (a.id === 'Default' ? -1 : b.id === 'Default' ? 1 : a.name.localeCompare(b.name)))
}

/** Firefox profiles from profiles.ini: [ProfileN] Name=, Path=, IsRelative=. */
export function parseProfilesIni(text: string): Array<{ name: string; path: string; relative: boolean; isDefault: boolean }> {
  const out: Array<{ name: string; path: string; relative: boolean; isDefault: boolean }> = []
  let current: Record<string, string> | null = null
  const flush = (): void => {
    if (current?.Path) out.push({ name: current.Name || current.Path, path: current.Path, relative: current.IsRelative !== '0', isDefault: current.Default === '1' })
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      flush()
      current = section[1]?.startsWith('Profile') ? {} : null
      continue
    }
    const eq = line.indexOf('=')
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  flush()
  return out
}

function firefoxProfileDirs(root: string): Array<ImportProfile & { dir: string }> {
  try {
    const entries = parseProfilesIni(readFileSync(join(root, 'profiles.ini'), 'utf8'))
    return entries
      .map((e) => ({ id: e.path, name: e.name, dir: e.relative ? join(root, e.path) : e.path, isDefault: e.isDefault }))
      .filter((e) => existsSync(join(e.dir, 'places.sqlite')))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map(({ isDefault: _isDefault, ...p }) => p)
  } catch {
    return []
  }
}

function canRead(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    // macOS lets access() pass for TCC-protected files; opening tells the truth.
    readFileSync(path, { flag: 'r' }).subarray(0, 1)
    return true
  } catch {
    return false
  }
}

/** The browsers installed here with their profiles; Safari shows even without access, so the page can explain how to grant it. */
export function detectBrowsers(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): ImportBrowser[] {
  const out: ImportBrowser[] = []
  for (const def of browserDefs(platform, home, env)) {
    if (def.kind === 'chromium') {
      const profiles = chromiumProfiles(def.root)
      // Cookie import rides on macOS's Keychain + Safe Storage; offer it only there.
      const types = platform === 'darwin' ? [...BROWSER_TYPES.chromium, 'cookies' as const] : BROWSER_TYPES.chromium
      if (profiles.length) out.push({ id: def.id, name: def.name, kind: def.kind, profiles, types, needsAccess: false, extensions: true })
    } else if (def.kind === 'firefox') {
      const profiles = firefoxProfileDirs(def.root).map(({ id, name }) => ({ id, name }))
      if (profiles.length) out.push({ id: def.id, name: def.name, kind: def.kind, profiles, types: BROWSER_TYPES.firefox, needsAccess: false })
    } else if (existsSync(def.root)) {
      const readable = canRead(join(def.root, 'Bookmarks.plist')) || canRead(join(def.root, 'History.db'))
      out.push({ id: def.id, name: def.name, kind: def.kind, profiles: [{ id: 'default', name: 'Safari' }], types: BROWSER_TYPES.safari, needsAccess: !readable })
    }
  }
  return out
}

function withCopy<T>(file: string, read: (copy: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-import-'))
  const copy = join(dir, 'db.sqlite')
  try {
    copyFileSync(file, copy)
    // SQLite's write-ahead log holds recent rows; copy it beside the database.
    for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
    return read(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function query<T>(file: string, sql: string): T[] {
  return withCopy(file, (copy) => {
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const statement = db.prepare(sql)
      statement.setReadBigInts(true)
      return statement.all() as T[]
    } finally {
      db.close()
    }
  })
}

const toNumber = (value: unknown): number => (typeof value === 'bigint' ? Number(value) : Number(value) || 0)

/** What one profile holds, read type by type (each type can fail on its own). */
export interface ProfileReader {
  bookmarks(): Promise<Array<{ url: string; title: string }>>
  history(): Promise<HistoryItem[]>
  tabs(): Promise<ImportedTab[]>
  searchEngines(): Promise<ImportedEngine[]>
  /** Saved addresses (autofill profiles); card data is never read. */
  addresses(): Promise<AddressInput[]>
  /** Chromium on macOS only; the key comes from the Keychain (a prompt), others return []. */
  cookies(): Promise<ImportedCookie[]>
}

const execFileAsync = promisify(execFile)

/** Reads one profile of one browser. Throws when the browser or profile isn't here. */
export function profileReader(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, browserId: string, profileId: string): ProfileReader {
  const def = browserDefs(platform, home, env).find((d) => d.id === browserId)
  if (!def) throw new Error(mainT('settings.import.error.noBrowser'))
  if (def.kind === 'chromium') {
    if (!chromiumProfiles(def.root).some((p) => p.id === profileId)) throw new Error(mainT('settings.import.error.noProfile'))
    const dir = join(def.root, profileId)
    return {
      bookmarks: async () => {
        const file = join(dir, 'Bookmarks')
        return existsSync(file) ? parseChromiumBookmarks(JSON.parse(readFileSync(file, 'utf8'))) : []
      },
      history: async () => readChromium(dir).history,
      tabs: async () => {
        const sessions = join(dir, 'Sessions')
        const files = existsSync(sessions) ? readdirSync(sessions).filter((f) => f.startsWith('Session_')).sort() : []
        const latest = files[files.length - 1]
        const legacy = join(dir, 'Current Session')
        const file = latest ? join(sessions, latest) : existsSync(legacy) ? legacy : null
        return file ? chromiumSessionTabs(readFileSync(file)).slice(0, TABS_LIMIT) : []
      },
      searchEngines: async () => {
        const file = join(dir, 'Web Data')
        if (!existsSync(file)) return []
        return query<{ short_name: string; url: string }>(file, 'SELECT short_name, url FROM keywords')
          .map((r) => chromiumEngine({ short_name: String(r.short_name), url: String(r.url) }))
          .filter((e): e is ImportedEngine => e !== null)
      },
      addresses: async () => {
        const file = join(dir, 'Web Data')
        return existsSync(file) ? chromiumAddresses(file) : []
      },
      cookies: async () => {
        // Only ever requested on macOS (detectBrowsers gates the checkbox).
        if (platform !== 'darwin') return []
        const file = cookiesFilePath(dir)
        if (!file) return []
        const password = await keychainPassword(safeStorageService(def.id, def.name))
        const key = deriveCookieKey(password)
        const { cookies, decryptFailures } = readChromiumCookies(file, key)
        if (decryptFailures > 0) log.info('import', 'some cookies could not be decrypted', { browser: def.id, skipped: decryptFailures })
        return cookies
      },
    }
  }
  if (def.kind === 'firefox') {
    const profile = firefoxProfileDirs(def.root).find((p) => p.id === profileId)
    if (!profile) throw new Error(mainT('settings.import.error.noProfile'))
    const places = join(profile.dir, 'places.sqlite')
    return {
      bookmarks: async () =>
        query<{ url: string; title: string | null }>(places, 'SELECT p.url AS url, b.title AS title FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id WHERE b.type = 1').map((r) => ({ url: r.url, title: r.title ?? r.url })),
      history: async () =>
        query<{ url: string; title: string | null; visit_count: bigint; last_visit_date: bigint | null }>(
          places,
          `SELECT url, title, visit_count, last_visit_date FROM moz_places WHERE visit_count > 0 ORDER BY last_visit_date DESC LIMIT ${HISTORY_LIMIT}`,
        ).map((r) => ({ url: r.url, title: r.title ?? '', visits: toNumber(r.visit_count) || 1, lastVisit: r.last_visit_date ? Number(r.last_visit_date / 1000n) : 0 })),
      tabs: async () => {
        const candidates = [join(profile.dir, 'sessionstore-backups', 'recovery.jsonlz4'), join(profile.dir, 'sessionstore.jsonlz4')]
        const file = candidates.find((f) => existsSync(f))
        return file ? firefoxSessionTabs(readMozLz4(readFileSync(file))).slice(0, TABS_LIMIT) : []
      },
      searchEngines: async () => {
        const file = join(profile.dir, 'search.json.mozlz4')
        return existsSync(file) ? firefoxEngines(readMozLz4(readFileSync(file))) : []
      },
      addresses: async () => firefoxProfileAddresses(profile.dir),
      cookies: async () => [],
    }
  }
  // Safari: bookmarks need plutil to turn the binary list into XML; history is SQLite.
  return {
    bookmarks: async () => {
      const file = join(def.root, 'Bookmarks.plist')
      if (!existsSync(file)) return []
      const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], { maxBuffer: 64 * 1024 * 1024 })
      return safariBookmarks(parseXmlPlist(stdout))
    },
    history: async () => {
      const file = join(def.root, 'History.db')
      if (!existsSync(file)) return []
      return query<{ url: string; title: string | null; visit_count: bigint; last_visit: number | null }>(
        file,
        `SELECT i.url AS url, (SELECT v2.title FROM history_visits v2 WHERE v2.history_item = i.id ORDER BY v2.visit_time DESC LIMIT 1) AS title, i.visit_count AS visit_count, MAX(v.visit_time) AS last_visit
         FROM history_items i JOIN history_visits v ON v.history_item = i.id GROUP BY i.id ORDER BY last_visit DESC LIMIT ${HISTORY_LIMIT}`,
      ).map((r) => ({ url: r.url, title: r.title ?? '', visits: toNumber(r.visit_count) || 1, lastVisit: r.last_visit ? safariTimeToMs(Number(r.last_visit)) : 0 }))
    },
    tabs: async () => [],
    searchEngines: async () => [],
    // Safari keeps addresses in Contacts, not in its own files.
    addresses: async () => [],
    cookies: async () => [],
  }
}

/** Where imported things go: Atelier's own stores. Each returns how many were new. */
export interface ImportSinks {
  bookmarks(items: Array<{ url: string; title: string }>): number
  history(items: HistoryItem[]): number
  tabs(items: ImportedTab[]): number
  searchEngines(items: ImportedEngine[]): number
  /** Saves into the wallet; the count is the addresses that weren't there yet. */
  addresses(items: AddressInput[]): number
  /** Writes cookies into a session (async); the count returned is the number of sites. */
  cookies(items: ImportedCookie[]): number | Promise<number>
}

/**
 * Runs an import: each requested type in turn, reporting progress, then a
 * summary. One type failing doesn't stop the rest (a partial import).
 */
export async function runImport(reader: ProfileReader, sinks: ImportSinks, request: ImportRequest, onProgress: (p: ImportProgress) => void): Promise<ImportSummary> {
  const types = [...new Set(request.types)]
  const counts: ImportCounts = {}
  const failed: ImportSummary['failed'] = []
  const done: ImportType[] = []
  for (const type of types) {
    onProgress({ browserId: request.browserId, current: type, done: [...done], counts: { ...counts } })
    try {
      const items = await reader[type]()
      counts[type] = await (sinks[type] as (items: unknown[]) => number | Promise<number>)(items)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed.push({ type, message: friendlyError(message) })
      log.warn('import', `Importing ${type} failed`, { browser: request.browserId, error: message })
    }
    done.push(type)
  }
  onProgress({ browserId: request.browserId, current: null, done, counts: { ...counts } })
  return { outcome: importOutcome(types, counts, failed), counts, failed }
}

function friendlyError(message: string): string {
  if (/EPERM|EACCES|operation not permitted/i.test(message)) return mainT('settings.import.error.access')
  // Windows: a running Chromium keeps its open session file locked (EBUSY), where macOS lets it be read.
  if (/SQLITE_BUSY|database is locked|EBUSY|resource busy or locked/i.test(message)) return mainT('settings.import.error.busy')
  if (/SQLITE|malformed|Corrupt|Not a/i.test(message)) return mainT('settings.import.error.unreadable')
  return message.slice(0, 200)
}

