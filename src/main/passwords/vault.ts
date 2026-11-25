/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { originMatchesSite, siteOfOrigin, type CredentialQuery, type CredentialView, type ImportReport } from '@shared/passwords'
import { mainT } from '../i18n/mainT'

// Atelier's password vault. The whole vault is one blob encrypted with the OS
// keychain (Electron safeStorage in production, injected so it can be
// tested). Credentials match by exact origin: a password saved for
// https://accounts.example.com is never offered on another origin. Nothing
// here is ever logged, and no agent tool, memory path or prompt reaches it.

export interface Credential {
  id: string
  origin: string
  username: string
  password: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export type { CredentialView }

export interface VaultCipher {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export type SaveDecision = { kind: 'new' } | { kind: 'update'; id: string } | { kind: 'same'; id: string }

/** One login from an import; the vault decides new, update or same. */
export interface LoginInput {
  url: string
  username: string
  password: string
}

const MAX_FIELD = 4096
const NEVER_SAVE_MAX = 1000
/** Where the vault lives inside a profile's data folder. */
export const VAULT_FILE = join('passwords', 'vault.bin')

/** The origin credentials are stored under, or null for pages that should not save. */
export function credentialOrigin(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol === 'https:') return parsed.origin
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  return parsed.protocol === 'http:' && local ? parsed.origin : null
}

/** Whether a submitted login is new, a changed password, or already saved. */
export function saveDecision(existing: readonly Credential[], origin: string, username: string, password: string): SaveDecision {
  const match = existing.find((c) => c.origin === origin && c.username === username)
  if (!match) return { kind: 'new' }
  return match.password === password ? { kind: 'same', id: match.id } : { kind: 'update', id: match.id }
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '-_.!@#%*+='

/**
 * A strong random password with every character class and no look-alike
 * characters (0/O, 1/l/I). Uses a CSPRNG by default.
 */
export function generatePassword(length = 20, pick: (max: number) => number = randomInt): string {
  if (length < 12 || length > 128) throw new Error(mainT('passwords.err.generateLength'))
  const classes = [LOWER, UPPER, DIGITS, SYMBOLS]
  const all = classes.join('')
  const chars = classes.map((set) => set[pick(set.length)] ?? '')
  while (chars.length < length) chars.push(all[pick(all.length)] ?? '')
  // Fisher-Yates so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = pick(i + 1)
    const a = chars[i] ?? ''
    chars[i] = chars[j] ?? ''
    chars[j] = a
  }
  return chars.join('')
}

export type Strength = 'weak' | 'fair' | 'strong'

/** A rough strength rating for the UI; not a security guarantee. */
export function passwordStrength(password: string): Strength {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length
  if (password.length >= 14 && classes >= 3) return 'strong'
  if (password.length >= 10 && classes >= 2) return 'fair'
  return 'weak'
}

function view({ password: _password, ...rest }: Credential): CredentialView {
  return rest
}

/** Saved logins filtered by ?site= and search text, sorted by site or most recent. */
export function queryCredentials(items: readonly CredentialView[], q: CredentialQuery = {}): CredentialView[] {
  const text = q.search?.trim().toLowerCase() ?? ''
  const out = items.filter(
    (c) => (!q.site || originMatchesSite(c.origin, q.site)) && (!text || siteOfOrigin(c.origin).toLowerCase().includes(text) || c.username.toLowerCase().includes(text)),
  )
  if (q.sort === 'recent') return out.sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt) || a.username.localeCompare(b.username))
  return out.sort((a, b) => siteOfOrigin(a.origin).localeCompare(siteOfOrigin(b.origin)) || a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
}

interface VaultData {
  credentials: Credential[]
  /** Origins where you chose "Never for this site". */
  neverSave: string[]
}

type Listener = () => void

export class PasswordVault {
  readonly #path: string
  readonly #cipher: VaultCipher
  #data: VaultData | null = null
  /** Set when the file exists but can't be opened; writes are refused so it is never overwritten. */
  #broken = false
  readonly #listeners = new Set<Listener>()

  /** `dataDir` is Atelier's data folder: one vault, shared by every browser profile (passwords/index.ts). */
  constructor(dataDir: string, cipher: VaultCipher) {
    this.#path = join(dataDir, VAULT_FILE)
    this.#cipher = cipher
  }

  /** False when the keychain can't be used or the vault can't be opened: the UI shows an unavailable state. */
  available(): boolean {
    if (!this.#cipher.available()) return false
    try {
      this.#load()
      return true
    } catch {
      return false
    }
  }

  /** Called after any change: a save, an edit, a removal, the never-save list or a wipe. */
  onChange(fn: Listener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  count(): number {
    try {
      return this.#load().credentials.length
    } catch {
      return 0
    }
  }

  list(): CredentialView[] {
    return queryCredentials(this.#load().credentials.map(view))
  }

  query(q: CredentialQuery = {}): CredentialView[] {
    return queryCredentials(this.#load().credentials.map(view), q)
  }

  get(id: string): CredentialView | null {
    const found = this.#load().credentials.find((c) => c.id === id)
    return found ? view(found) : null
  }

  /** Saved logins for the page's exact origin, most recently used first. */
  forUrl(url: string): CredentialView[] {
    const origin = credentialOrigin(url)
    if (!origin) return []
    return this.#load()
      .credentials.filter((c) => c.origin === origin)
      .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
      .map(view)
  }

  decide(url: string, username: string, password: string): SaveDecision | null {
    const origin = credentialOrigin(url)
    return origin ? saveDecision(this.#load().credentials, origin, username, password) : null
  }

  /** Adds or updates the login for (origin, username). */
  save(url: string, username: string, password: string, now = Date.now()): CredentialView {
    return this.#change((data) => {
      const saved = this.#apply(data.credentials, url, username, password, now)
      if (saved.kind === 'invalid') throw new Error(saved.reason)
      return view(saved.credential)
    })
  }

  /**
   * Many logins at once (CSV import), written once. Each row goes through
   * the same new, update or same decision as a single save; rows that can't
   * be saved (insecure or incomplete) are skipped.
   */
  importLogins(rows: readonly LoginInput[], now = Date.now()): ImportReport {
    const data = this.#copy()
    const report: ImportReport = { added: 0, updated: 0, same: 0, skipped: 0, total: rows.length }
    for (const row of rows) {
      const result = this.#apply(data.credentials, row.url, row.username, row.password, now)
      if (result.kind === 'invalid') report.skipped++
      else if (result.kind === 'new') report.added++
      else if (result.kind === 'update') report.updated++
      else report.same++
    }
    if (report.added || report.updated) this.#persist(data)
    return report
  }

  /** The password itself, for autofill or an authenticated reveal. Main only; never logged. */
  reveal(id: string): string {
    const credential = this.#load().credentials.find((c) => c.id === id)
    if (!credential) throw new Error(mainT('passwords.err.loginGone'))
    return credential.password
  }

  markUsed(id: string, now = Date.now()): void {
    if (!this.#load().credentials.some((c) => c.id === id)) return
    this.#change((data) => {
      const credential = data.credentials.find((c) => c.id === id)
      if (credential) credential.lastUsedAt = now
    })
  }

  update(id: string, patch: { username?: string; password?: string }, now = Date.now()): CredentialView {
    return this.#change((data) => {
      const credential = data.credentials.find((c) => c.id === id)
      if (!credential) throw new Error(mainT('passwords.err.loginGone'))
      if (patch.username !== undefined) {
        const username = patch.username.slice(0, MAX_FIELD)
        if (data.credentials.some((c) => c.id !== id && c.origin === credential.origin && c.username === username)) {
          throw new Error(mainT('passwords.err.usernameTaken'))
        }
        credential.username = username
      }
      if (patch.password !== undefined) {
        if (!patch.password) throw new Error(mainT('passwords.err.passwordEmpty'))
        credential.password = patch.password.slice(0, MAX_FIELD)
      }
      credential.updatedAt = now
      return view(credential)
    })
  }

  remove(id: string): void {
    if (!this.#load().credentials.some((c) => c.id === id)) return
    this.#change((data) => {
      data.credentials = data.credentials.filter((c) => c.id !== id)
    })
  }

  // ── never-save list (ST-42) ──

  neverSave(origin: string): void {
    const key = normalizeOrigin(origin)
    if (!key) return
    if (this.#load().neverSave.includes(key)) return
    this.#change((data) => {
      data.neverSave = [...data.neverSave, key].slice(-NEVER_SAVE_MAX)
    })
  }

  isNeverSave(origin: string): boolean {
    const key = normalizeOrigin(origin)
    try {
      return key !== null && this.#load().neverSave.includes(key)
    } catch {
      return false
    }
  }

  allowAgain(origin: string): void {
    const key = normalizeOrigin(origin)
    if (!key || !this.#load().neverSave.includes(key)) return
    this.#change((data) => {
      data.neverSave = data.neverSave.filter((o) => o !== key)
    })
  }

  neverSaveList(): string[] {
    return [...this.#load().neverSave].sort((a, b) => siteOfOrigin(a).localeCompare(siteOfOrigin(b)))
  }

  /** Deletes every saved login and the never-save list (Reset with secrets, ST-55). */
  wipe(): void {
    this.#broken = false
    this.#data = { credentials: [], neverSave: [] }
    if (existsSync(this.#path)) {
      // An empty vault replaces the old one; without the keychain the file itself goes.
      if (this.#cipher.available()) this.#write(this.#data)
      else writeFileSync(this.#path, Buffer.alloc(0), { mode: 0o600 })
    }
    this.#emit()
  }

  #apply(credentials: Credential[], url: string, username: string, password: string, now: number): { kind: 'invalid'; reason: string } | { kind: SaveDecision['kind']; credential: Credential } {
    const origin = credentialOrigin(url)
    if (!origin) return { kind: 'invalid', reason: mainT('passwords.error.insecure') }
    if (!password || password.length > MAX_FIELD || username.length > MAX_FIELD) return { kind: 'invalid', reason: mainT('passwords.err.loginInvalid') }
    const decision = saveDecision(credentials, origin, username, password)
    if (decision.kind === 'new') {
      const credential = { id: randomUUID(), origin, username, password, createdAt: now, updatedAt: now, lastUsedAt: null }
      credentials.push(credential)
      return { kind: 'new', credential }
    }
    const credential = credentials.find((c) => c.id === decision.id)
    if (!credential) return { kind: 'invalid', reason: mainT('passwords.err.loginGone') }
    if (decision.kind === 'update') {
      credential.password = password
      credential.updatedAt = now
    }
    return { kind: decision.kind, credential }
  }

  #load(): VaultData {
    if (this.#data) return this.#data
    if (this.#broken) throw new Error(mainT('passwords.err.vaultBroken'))
    if (!existsSync(this.#path)) {
      this.#data = { credentials: [], neverSave: [] }
      return this.#data
    }
    const raw = readFileSync(this.#path)
    if (raw.length === 0) {
      this.#data = { credentials: [], neverSave: [] }
      return this.#data
    }
    if (!this.#cipher.available()) throw new Error(mainT('passwords.err.vaultNoKeychainOpen'))
    try {
      this.#data = parseVault(JSON.parse(this.#cipher.decrypt(raw)))
    } catch {
      this.#broken = true
      throw new Error(mainT('passwords.err.vaultBroken'))
    }
    return this.#data
  }

  /** Applies a change to a copy and keeps it only once it is written, so a failed write changes nothing. */
  #change<T>(fn: (data: VaultData) => T): T {
    const data = this.#copy()
    const out = fn(data)
    this.#persist(data)
    return out
  }

  #copy(): VaultData {
    const data = this.#load()
    return { credentials: data.credentials.map((c) => ({ ...c })), neverSave: [...data.neverSave] }
  }

  #persist(data: VaultData): void {
    if (this.#broken) throw new Error(mainT('passwords.err.vaultBroken'))
    if (!this.#cipher.available()) throw new Error(mainT('passwords.err.vaultNoKeychainSave'))
    this.#write(data)
    this.#data = data
    this.#emit()
  }

  #write(data: VaultData): void {
    const dir = join(this.#path, '..')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.${process.pid}.tmp`
    writeFileSync(temp, this.#cipher.encrypt(JSON.stringify({ v: 2, ...data })), { mode: 0o600 })
    renameSync(temp, this.#path)
  }

  #emit(): void {
    for (const fn of this.#listeners) fn()
  }
}

/** The lowercase origin of an origin or URL, or null. */
function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin)
    return url.origin === 'null' ? null : url.origin.toLowerCase()
  } catch {
    return null
  }
}

/** Reads both shapes: the original bare credential array, and { v: 2, credentials, neverSave }. */
function parseVault(parsed: unknown): VaultData {
  if (Array.isArray(parsed)) return { credentials: parsed.filter(isCredential).map(normalizeCredential), neverSave: [] }
  if (!parsed || typeof parsed !== 'object') return { credentials: [], neverSave: [] }
  const v = parsed as Record<string, unknown>
  const credentials = Array.isArray(v.credentials) ? v.credentials.filter(isCredential).map(normalizeCredential) : []
  const neverSave = Array.isArray(v.neverSave) ? v.neverSave.filter((o): o is string => typeof o === 'string') : []
  return { credentials, neverSave }
}

function normalizeCredential(c: Credential): Credential {
  return { ...c, lastUsedAt: typeof c.lastUsedAt === 'number' ? c.lastUsedAt : null }
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.origin === 'string' && typeof v.username === 'string' && typeof v.password === 'string' &&
    typeof v.createdAt === 'number' && typeof v.updatedAt === 'number'
}
