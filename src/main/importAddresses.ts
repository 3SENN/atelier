/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ADDRESS_FIELD_MAX, EMPTY_ADDRESS, type AddressInput, type AddressView } from '@shared/passwords'
import { mainT } from './i18n/mainT'
import { log } from './log'
import { sameAddress, validateAddress } from './passwords/wallet'

// Saved addresses from another browser (ST-46): Chromium's "Web Data" and
// Firefox's autofill-profiles.json, into the wallet. Only address tables and
// Firefox's address list are read; card tables are never queried and
// Firefox's creditCards are never looked at. Nothing read here is logged.

/** A wallet field, or one that is split into wallet fields (a full name, a multi-line street). */
type SourceField = keyof AddressInput | 'fullName' | 'street'
type SourceAddress = Partial<Record<SourceField, string>>

/**
 * Chromium's FieldType ids (components/autofill/core/browser/field_types.h) that
 * the type-token tables can hold and the wallet has a place for. Only these are
 * asked for, so no other type (and no card type) is ever read.
 */
const CHROMIUM_FIELDS: Readonly<Record<number, SourceField>> = {
  3: 'givenName', // NAME_FIRST
  4: 'additionalName', // NAME_MIDDLE
  5: 'familyName', // NAME_LAST
  7: 'fullName', // NAME_FULL
  9: 'email', // EMAIL_ADDRESS
  14: 'tel', // PHONE_HOME_WHOLE_NUMBER
  30: 'line1', // ADDRESS_HOME_LINE1
  31: 'line2', // ADDRESS_HOME_LINE2
  33: 'city', // ADDRESS_HOME_CITY
  34: 'region', // ADDRESS_HOME_STATE
  35: 'postalCode', // ADDRESS_HOME_ZIP
  36: 'country', // ADDRESS_HOME_COUNTRY
  60: 'organization', // COMPANY_NAME
  77: 'street', // ADDRESS_HOME_STREET_ADDRESS
  83: 'line3', // ADDRESS_HOME_LINE3
}

/** Newest first: one table for every address (record_type), then local and account tables, then the old per-field tables. */
const TOKEN_TABLES: ReadonlyArray<readonly [meta: string, tokens: string]> = [
  ['addresses', 'address_type_tokens'],
  ['local_addresses', 'local_addresses_type_tokens'],
  ['contact_info', 'contact_info_type_tokens'],
]

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** One source entry as a wallet input: names and street lines split out, a country kept only when it is already an ISO code. */
export function toAddressInput(source: SourceAddress): AddressInput {
  const out: AddressInput = { ...EMPTY_ADDRESS }
  for (const key of Object.keys(EMPTY_ADDRESS) as (keyof AddressInput)[]) out[key] = text(source[key]).trim()
  const fullName = text(source.fullName).trim()
  // A full name alone goes in as given: splitting it would guess.
  if (!out.givenName && !out.additionalName && !out.familyName && fullName) out.givenName = fullName
  const lines = text(source.street)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length) {
    out.line1 = lines[0] ?? ''
    out.line2 = lines[1] ?? ''
    out.line3 = lines.slice(2).join(', ')
  }
  const country = out.country.toUpperCase()
  out.country = /^[A-Z]{2}$/.test(country) ? country : ''
  for (const key of Object.keys(out) as (keyof AddressInput)[]) out[key] = out[key].slice(0, ADDRESS_FIELD_MAX)
  return out
}

function withCopy<T>(file: string, read: (copy: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-addresses-'))
  const copy = join(dir, 'web-data.sqlite')
  try {
    // The browser keeps Web Data locked while it runs; read a copy with its journal beside it.
    copyFileSync(file, copy)
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
    return read(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function tokenAddresses(db: DatabaseSync, meta: string, tokens: string): Array<[guid: string, SourceAddress]> {
  if (!hasTable(db, meta) || !hasTable(db, tokens)) return []
  const types = Object.keys(CHROMIUM_FIELDS).join(', ')
  const out = new Map<string, SourceAddress>()
  for (const row of db.prepare(`SELECT guid FROM "${meta}" ORDER BY use_count DESC, use_date DESC`).all()) out.set(text(row.guid), {})
  for (const row of db.prepare(`SELECT guid, type, value FROM "${tokens}" WHERE type IN (${types})`).all()) {
    const entry = out.get(text(row.guid))
    const field = CHROMIUM_FIELDS[Number(row.type)]
    if (entry && field) entry[field] = text(row.value)
  }
  return [...out]
}

/** Before the type-token tables: autofill_profiles with names, emails and phones kept per guid. */
function legacyAddresses(db: DatabaseSync): Array<[guid: string, SourceAddress]> {
  if (!hasTable(db, 'autofill_profiles')) return []
  const out = new Map<string, SourceAddress>()
  for (const row of db.prepare('SELECT * FROM autofill_profiles ORDER BY use_count DESC').all()) {
    out.set(text(row.guid), {
      organization: text(row.company_name),
      street: text(row.street_address),
      city: text(row.city),
      region: text(row.state),
      postalCode: text(row.zipcode),
      country: text(row.country_code),
    })
  }
  // Very old profiles can hold several names, emails or phones; the first filled one is kept.
  const fill = (table: string, pick: (row: Record<string, unknown>) => SourceAddress): void => {
    if (!hasTable(db, table)) return
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      const entry = out.get(text(row.guid))
      if (!entry) continue
      for (const [key, value] of Object.entries(pick(row)) as Array<[SourceField, string]>) if (!entry[key]?.trim() && value.trim()) entry[key] = value
    }
  }
  fill('autofill_profile_names', (r) => ({ givenName: text(r.first_name), additionalName: text(r.middle_name), familyName: text(r.last_name), fullName: text(r.full_name) }))
  fill('autofill_profile_emails', (r) => ({ email: text(r.email) }))
  fill('autofill_profile_phones', (r) => ({ tel: text(r.number) }))
  return [...out]
}

/** The saved addresses in a Chromium profile's Web Data file, whichever schema that browser version uses. */
export function chromiumAddresses(webDataFile: string): AddressInput[] {
  return withCopy(webDataFile, (copy) => {
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const seen = new Set<string>()
      const out: AddressInput[] = []
      let firstError: unknown = null
      let anyRead = false
      const sources = [...TOKEN_TABLES.map(([meta, tokens]) => () => tokenAddresses(db, meta, tokens)), () => legacyAddresses(db)]
      for (const source of sources) {
        try {
          // After a schema migration the old table can still hold the same entries (same guid); the newest copy wins.
          for (const [guid, entry] of source()) {
            if (seen.has(guid)) continue
            seen.add(guid)
            out.push(toAddressInput(entry))
          }
          anyRead = true
        } catch (err) {
          firstError ??= err
        }
      }
      if (!anyRead && firstError) throw firstError
      return out
    } finally {
      db.close()
    }
  })
}

/** Firefox's autofill-profiles.json: the "addresses" list only, minus deleted entries. */
export function firefoxAddresses(json: unknown): AddressInput[] {
  const list = json && typeof json === 'object' ? (json as { addresses?: unknown }).addresses : null
  if (!Array.isArray(list)) return []
  const out: AddressInput[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    if (a.deleted) continue
    out.push(
      toAddressInput({
        givenName: text(a['given-name']),
        additionalName: text(a['additional-name']),
        familyName: text(a['family-name']),
        fullName: text(a.name),
        organization: text(a.organization),
        street: text(a['street-address']),
        city: text(a['address-level2']),
        region: text(a['address-level1']),
        postalCode: text(a['postal-code']),
        country: text(a.country),
        tel: text(a.tel),
        email: text(a.email),
      }),
    )
  }
  return out
}

/** The saved addresses in a Firefox profile folder. */
export function firefoxProfileAddresses(profileDir: string): AddressInput[] {
  const file = join(profileDir, 'autofill-profiles.json')
  return existsSync(file) ? firefoxAddresses(JSON.parse(readFileSync(file, 'utf8'))) : []
}

/** What the import needs of the wallet. */
export interface AddressWallet {
  addresses(): AddressView[]
  saveAddress(a: AddressInput): AddressView
}

export interface AddressImportResult {
  /** New entries in the wallet. */
  added: number
  /** Already there (perhaps with a field filled in now). */
  already: number
  /** The wallet would refuse them (nothing to save, or a field it can't take). */
  skipped: number
  /** New ones that didn't fit: the wallet is full. */
  full: number
}

const ADDRESS_KEYS = Object.keys(EMPTY_ADDRESS) as (keyof AddressInput)[]

/** The entry as the wallet takes it; a phone or email it won't take is left out rather than the whole address. */
function acceptable(a: AddressInput): AddressInput | null {
  try {
    return validateAddress(a)
  } catch {
    try {
      return validateAddress({ ...a, tel: '', email: '' })
    } catch {
      return null
    }
  }
}

/**
 * Saves imported addresses into the wallet. A copy of a saved one fills that
 * one in (saveAddress merges near-copies), so importing twice adds nothing.
 * A wallet the keychain can't open or save fails the whole type.
 */
export function saveImportedAddresses(wallet: AddressWallet, items: readonly AddressInput[]): AddressImportResult {
  // Read first: a wallet the keychain can't open throws here, before anything is written.
  const known = new Set(wallet.addresses().map((a) => a.id))
  const fullMessage = mainT('passwords.err.addressesFull')
  const result: AddressImportResult = { added: 0, already: 0, skipped: 0, full: 0 }
  for (const item of items) {
    const fields = acceptable(item)
    if (!fields) {
      result.skipped++
      continue
    }
    // Already there with everything this one has: nothing to write.
    const saved = wallet.addresses()
    const twin = saved[sameAddress(saved, fields)]
    if (twin && ADDRESS_KEYS.every((k) => fields[k] === '' || twin[k].trim() !== '')) {
      result.already++
      continue
    }
    try {
      const view = wallet.saveAddress(fields)
      if (known.has(view.id)) result.already++
      else {
        known.add(view.id)
        result.added++
      }
    } catch (err) {
      if (err instanceof Error && err.message === fullMessage) {
        result.full++
        continue
      }
      throw err
    }
  }
  log.info('import', 'addresses', { ...result })
  // Every new one was turned away: say why instead of "nothing new".
  if (result.full > 0 && result.added === 0) throw new Error(fullMessage)
  return result
}
