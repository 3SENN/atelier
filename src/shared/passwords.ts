/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The password vault and wallet: what the Passwords page, Settings
// › Passwords and autofill and the autofill surfaces see. No password, card
// number or security code ever appears in these types; the CVC is never in
// any type at all.
import type { MessageKey } from './i18n/core'

/** A saved login without its password. */
export interface CredentialView {
  id: string
  /** The exact origin it was saved for, for example https://accounts.example.com. */
  origin: string
  username: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export interface PasswordsStatus {
  count: number
  locked: boolean
  /** When the Passwords page relocks (5 min after unlock); null while locked. */
  unlockedUntil: number | null
  /** False when the keychain can't be opened: the page shows an unavailable state. */
  available: boolean
}

export interface CredentialQuery {
  /** A host, from atelier://passwords?site=<host>. */
  site?: string
  search?: string
  sort?: 'site' | 'recent'
}

export type PasswordStrength = 'weak' | 'fair' | 'strong'


export type CsvSourceFormat = 'chrome' | 'firefox' | 'safari' | '1password' | 'bitwarden' | 'unknown'

/** Column indexes for the three fields an import needs; null while unmapped. */
export interface CsvMapping {
  url: number | null
  username: number | null
  password: number | null
}

export interface CsvPreview {
  /** Names the private temp copy; every later call passes it back. */
  token: string
  fileName: string
  delimiter: string
  columns: string[]
  /** The first rows, with the mapped password column masked. */
  sample: string[][]
  rowCount: number
  format: CsvSourceFormat
  /** The guessed (or last applied) mapping. */
  mapping: CsvMapping
  /** Rows that will import as things stand. */
  importable: number
}

export interface ImportReport {
  added: number
  updated: number
  same: number
  skipped: number
  total: number
}

// ── wallet ──

export interface AddressInput {
  givenName: string
  additionalName: string
  familyName: string
  organization: string
  line1: string
  line2: string
  line3: string
  /** City or town (address-level2). */
  city: string
  /** State, province or region (address-level1). */
  region: string
  postalCode: string
  /** ISO 3166-1 alpha-2. */
  country: string
  email: string
  tel: string
}

export interface AddressView extends AddressInput {
  id: string
  /** A one-line label, for example "Sam Lee, 1 Main St". */
  label: string
  updatedAt: number
  /** Your own details (Settings › You): at most one address is yours, and autofill and your companion use it first. */
  mine: boolean
}

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' | 'jcb' | 'unionpay' | 'maestro' | 'unknown'

export interface CardView {
  id: string
  brand: CardBrand
  last4: string
  expMonth: number
  expYear: number
  holder: string
}

export interface CardInput {
  id?: string
  /** Required for a new card; omitted keeps the saved number. Luhn-checked. */
  number?: string
  holder: string
  expMonth: number
  expYear: number
}


export interface PasswordsServices {
  passwords: {
    status(): PasswordsStatus
    list(q?: CredentialQuery): CredentialView[]
    /** Touch ID (or the fallbacks); the page stays unlocked for 5 minutes. */
    unlock(): Promise<boolean>
    lock(): void
    /** Behind auth; never logged. */
    reveal(id: string): Promise<string>
    copyPassword(id: string): Promise<void>
    create(input: { url: string; username: string; password: string }): CredentialView
    update(id: string, patch: { username?: string; password?: string }): CredentialView
    remove(id: string): void
    neverSaveList(): string[]
    allowAgain(origin: string): void
    generate(length?: number): string
    strength(password: string): PasswordStrength
    importPick(): Promise<CsvPreview | null>
    importRemap(token: string, mapping: CsvMapping): CsvPreview
    importConfirm(token: string, mapping: CsvMapping): ImportReport
    importCancel(token: string): void
    /** Passwords.app on macOS 15+, else System Settings › Passwords (ON-04). */
    openSystemPasswords(): void
    pickSystemExport(): Promise<CsvPreview | null>
    /** Moves the plaintext export to the Trash. */
    trashFile(token: string): Promise<void>
  }
  wallet: {
    addresses(): AddressView[]
    saveAddress(a: AddressInput & { id?: string; mine?: boolean }): AddressView
    /** Marks a saved address as yours, or none (null). */
    setMine(id: string | null): void
    removeAddress(id: string): void
    cards(): CardView[]
    saveCard(c: CardInput): CardView
    removeCard(id: string): void
  }
}

export type PasswordsAppEvent = { type: 'passwords'; count: number; locked: boolean } | { type: 'wallet' }

export const PASSWORD_MAX = 4096
export const USERNAME_MAX = 4096
export const GENERATED_LENGTH = { min: 12, max: 64, default: 20 } as const
export const ADDRESS_FIELD_MAX = 200

// Shared by main and the renderer, so both check a card or a site the same way

/** How long the Passwords page stays unlocked after Touch ID. */
export const UNLOCK_MS = 5 * 60_000

/** The digits of a card number typed with spaces or dashes. */
export function cardDigits(number: string): string {
  return number.replace(/[\s-]/g, '')
}

/** The Luhn checksum every payment card number carries. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** 12 to 19 digits that pass Luhn. */
export function cardNumberValid(number: string): boolean {
  const digits = cardDigits(number)
  return /^\d{12,19}$/.test(digits) && luhnValid(digits)
}

function inRange(digits: string, from: number, to: number, width: number): boolean {
  const head = Number(digits.slice(0, width))
  return digits.length >= width && head >= from && head <= to
}

/** The network from the number's leading digits (IIN ranges); 'unknown' when none match. */
export function cardBrand(number: string): CardBrand {
  const d = cardDigits(number)
  if (/^3[47]/.test(d)) return 'amex'
  if (/^4/.test(d)) return 'visa'
  if (/^5[1-5]/.test(d) || inRange(d, 2221, 2720, 4)) return 'mastercard'
  if (/^(6011|65|64[4-9])/.test(d) || inRange(d, 622126, 622925, 6)) return 'discover'
  if (/^62/.test(d)) return 'unionpay'
  if (/^(30[0-5]|36|38|39)/.test(d)) return 'diners'
  if (inRange(d, 3528, 3589, 4)) return 'jcb'
  if (/^(50|5[6-8]|6304|6759|676770|676774)/.test(d)) return 'maestro'
  return 'unknown'
}

/** A card stops working after the last day of its expiry month. */
export function cardExpired(expMonth: number, expYear: number, now: Date = new Date()): boolean {
  return expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)
}

/** The host of a saved origin, without a leading www., for rows and sorting. */
export function siteOfOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '')
  } catch {
    return origin
  }
}

/** Whether a saved origin belongs to a ?site=<host> filter: the host itself or one of its subdomains. */
export function originMatchesSite(origin: string, site: string): boolean {
  const host = siteOfOrigin(origin).toLowerCase()
  const want = site.trim().toLowerCase().replace(/^www\./, '')
  return want !== '' && (host === want || host.endsWith(`.${want}`))
}

export const EMPTY_ADDRESS: AddressInput = {
  givenName: '',
  additionalName: '',
  familyName: '',
  organization: '',
  line1: '',
  line2: '',
  line3: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  email: '',
  tel: '',
}

/** A one-line label for an address row: "Sam Lee, 1 Main St", or whatever parts it has. */
export function addressLabel(a: AddressInput): string {
  const name = [a.givenName, a.additionalName, a.familyName].map((s) => s.trim()).filter(Boolean).join(' ')
  const parts = [name || a.organization.trim(), a.line1.trim() || a.city.trim()].filter(Boolean)
  return parts.join(', ') || a.email.trim() || a.tel.trim()
}

/** Whether an address has anything worth saving. */
export function addressHasContent(a: AddressInput): boolean {
  return (Object.keys(EMPTY_ADDRESS) as (keyof AddressInput)[]).some((k) => k !== 'country' && a[k].trim() !== '')
}

// ── view helpers for the Passwords page and Settings › Passwords and autofill ──
// (here rather than in the renderer so the unit tests, which typecheck with
// main, can reach them)

export const BRAND_KEY: Record<CardBrand, MessageKey> = {
  visa: 'passwords.brand.visa',
  mastercard: 'passwords.brand.mastercard',
  amex: 'passwords.brand.amex',
  discover: 'passwords.brand.discover',
  diners: 'passwords.brand.diners',
  jcb: 'passwords.brand.jcb',
  unionpay: 'passwords.brand.unionpay',
  maestro: 'passwords.brand.maestro',
  unknown: 'passwords.brand.unknown',
}

export const STRENGTH_KEY: Record<PasswordStrength, MessageKey> = {
  weak: 'passwords.strength.weak',
  fair: 'passwords.strength.fair',
  strong: 'passwords.strength.strong',
}

/** How many of the meter's three bars are lit. */
export function strengthBars(s: PasswordStrength): number {
  return s === 'strong' ? 3 : s === 'fair' ? 2 : 1
}

/** "03/27". */
export function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year % 100).padStart(2, '0')}`
}

/** A card number grouped as it's printed: 4-6-5 for American Express, fours otherwise. */
export function groupCardNumber(input: string): string {
  const digits = cardDigits(input).replace(/\D/g, '').slice(0, 19)
  const groups = cardBrand(digits) === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3]
  const out: string[] = []
  let at = 0
  for (const size of groups) {
    if (at >= digits.length) break
    out.push(digits.slice(at, at + size))
    at += size
  }
  return out.join(' ')
}

/** The expiry years a card picker offers: this year and the next 20, plus a saved year outside that range. */
export function expiryYears(now: Date = new Date(), saved?: number): number[] {
  const first = now.getFullYear()
  const years = Array.from({ length: 21 }, (_, i) => first + i)
  if (saved !== undefined && !years.includes(saved)) years.unshift(saved)
  return years
}

export type ImportOutcome = 'none' | 'incomplete' | 'ok'

/** How an import went (ON-04): nothing usable, some rows skipped, or all fine. */
export function importOutcome(r: ImportReport): ImportOutcome {
  if (r.added + r.updated + r.same === 0) return 'none'
  return r.skipped > 0 ? 'incomplete' : 'ok'
}

export type MappingField = keyof CsvMapping

/** The select options for one mapping field: "None", then each column by its header (or "Column n"). */
export function mappingOptions(columns: readonly string[], noneLabel: string, columnLabel: (n: number) => string): Array<{ value: string; label: string }> {
  return [{ value: '', label: noneLabel }, ...columns.map((c, i) => ({ value: String(i), label: c.trim() || columnLabel(i + 1) }))]
}

/** Sets one field of the mapping; a column already used by another field is moved, never shared. */
export function remap(mapping: CsvMapping, field: MappingField, value: string): CsvMapping {
  const index = value === '' ? null : Number(value)
  const next: CsvMapping = { ...mapping, [field]: index }
  if (index !== null) {
    for (const other of ['url', 'username', 'password'] as const) {
      if (other !== field && next[other] === index) next[other] = null
    }
  }
  return next
}

/** Normalizes what someone typed as a site into an address the vault accepts. */
export function siteInput(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

// ISO 3166-1 alpha-2 codes; names come from Intl.DisplayNames in the person's language.
const COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')

/** Every country as { value: code, label: name }, sorted by name in `locale`. */
export function countryOptions(locale?: string): Array<{ value: string; label: string }> {
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'region' })
  } catch {
    names = null
  }
  return COUNTRY_CODES.map((code) => ({ value: code, label: names?.of(code) ?? code })).sort((a, b) => a.label.localeCompare(b.label, locale))
}

/** The country a new address starts with: the region of the person's locale, when it is a real country. */
export function defaultCountry(locale: string = typeof navigator === 'undefined' ? 'en-US' : navigator.language): string {
  const region = /[-_]([A-Z]{2})\b/.exec(locale)?.[1] ?? ''
  return COUNTRY_CODES.includes(region) ? region : ''
}
