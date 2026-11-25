/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADDRESS_FIELD_MAX,
  addressHasContent,
  addressLabel,
  cardBrand,
  cardDigits,
  cardExpired,
  cardNumberValid,
  EMPTY_ADDRESS,
  type AddressInput,
  type AddressView,
  type CardBrand,
  type CardInput,
  type CardView,
} from '@shared/passwords'
import type { Address, Wallet } from '../features/personalRuntime'
import { mainT } from '../i18n/mainT'
import type { VaultCipher } from './vault'

// The wallet: addresses and payment cards in one safeStorage-encrypted
// blob, written atomically with mode 0600. Card numbers never leave main:
// views carry only brand, last four, expiry and holder, and cardForFill is
// for the autofill controller. Security codes are never accepted or stored;
// no type has a field for one. Nothing here is ever logged.
//
// One address can be yours (`mine`): your own name, email, phone and address,
// shown in Settings › You and used first by autofill and your companion. It is
// the one place Atelier keeps those details; nothing else holds a copy.

interface StoredAddress extends Address {
  updatedAt: number
}

interface StoredCard {
  id: string
  number: string
  holder: string
  expMonth: number
  expYear: number
  brand: CardBrand
  updatedAt: number
}

interface WalletData {
  addresses: StoredAddress[]
  cards: StoredCard[]
  /** Offer dismissals keyed by "<fingerprint> <site>". */
  strikes: Record<string, number>
  /** The HMAC key for card fingerprints; it lives inside the encrypted blob, so the keychain guards it. */
  hmacKey: string
  /** The id of your own address, or '' when none is marked as yours. */
  mine: string
}

export const WALLET_FILE = join('passwords', 'wallet.bin')
/** Three dismissals of a save-card offer on a site stop the offers for that card there. */
export const STRIKES_TO_STOP = 3
const STRIKES_MAX = 500
const ADDRESSES_MAX = 200
const CARDS_MAX = 100

/** Any key that could carry a security code; a card input with one is refused outright. */
const SECURITY_CODE_KEYS = /^(cvc|cvv|csc|cvv2|cvc2|cid|securitycode|security_code|code)$/i

/** Trims and checks an address; throws a readable error when it can't be saved. */
export function validateAddress(input: AddressInput): AddressInput {
  const out = { ...EMPTY_ADDRESS }
  for (const key of Object.keys(EMPTY_ADDRESS) as (keyof AddressInput)[]) {
    const value = input[key]
    if (typeof value !== 'string') throw new Error(mainT('passwords.err.addressIncomplete'))
    out[key] = value.trim().slice(0, ADDRESS_FIELD_MAX)
  }
  out.country = out.country.toUpperCase()
  if (out.country && !/^[A-Z]{2}$/.test(out.country)) throw new Error(mainT('passwords.err.country'))
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new Error(mainT('passwords.err.email'))
  if (out.tel && !/^[+()0-9\s.-]{3,40}$/.test(out.tel)) throw new Error(mainT('passwords.err.tel'))
  if (!addressHasContent(out)) throw new Error(mainT('passwords.err.addressEmpty'))
  return out
}

/** Checks a card input; security codes are refused, the number must pass Luhn and the expiry can't be past. */
export function validateCard(input: CardInput, existing: StoredCard | null, now: Date = new Date()): { number: string; holder: string; expMonth: number; expYear: number } {
  if (Object.keys(input).some((k) => SECURITY_CODE_KEYS.test(k))) throw new Error(mainT('passwords.err.securityCode'))
  const number = input.number !== undefined ? cardDigits(input.number) : existing?.number
  if (!number) throw new Error(mainT('passwords.err.cardNumberMissing'))
  if (!cardNumberValid(number)) throw new Error(mainT('passwords.card.invalidNumber'))
  const expMonth = Math.trunc(input.expMonth)
  const expYear = Math.trunc(input.expYear)
  if (!(expMonth >= 1 && expMonth <= 12) || !(expYear >= 2000 && expYear <= 2100)) throw new Error(mainT('passwords.err.expiry'))
  if (cardExpired(expMonth, expYear, now)) throw new Error(mainT('passwords.card.expired'))
  return { number, holder: input.holder.trim().slice(0, 120), expMonth, expYear }
}

function addressView(a: StoredAddress, mine: string): AddressView {
  const { updatedAt, id, ...fields } = a
  return { ...fields, id, label: addressLabel(fields), updatedAt, mine: id === mine }
}

const ADDRESS_KEYS = Object.keys(EMPTY_ADDRESS) as (keyof AddressInput)[]
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s.,-]+/g, '')

/**
 * The saved address a new one is a copy of, so saving it fills that one in instead of adding a twin: every field
 * the two both have agrees, and they share the person (or organisation) and the street, or one is the other with
 * fields left out. An autofill offer, an import or your details saved again never leave two entries for one place.
 */
export function sameAddress(saved: readonly AddressInput[], next: AddressInput): number {
  const filled = (a: AddressInput): (keyof AddressInput)[] => ADDRESS_KEYS.filter((k) => a[k].trim() !== '')
  return saved.findIndex((x) => {
    const both = ADDRESS_KEYS.filter((k) => x[k].trim() !== '' && next[k].trim() !== '')
    if (both.length === 0 || !both.every((k) => norm(x[k]) === norm(next[k]))) return false
    const who = (a: AddressInput): string => norm(`${a.givenName}${a.familyName}`) || norm(a.organization)
    const shareWhoAndWhere = who(x) !== '' && who(x) === who(next) && norm(x.line1) !== '' && norm(x.line1) === norm(next.line1)
    const subset = filled(next).every((k) => x[k].trim() !== '') || filled(x).every((k) => next[k].trim() !== '')
    return shareWhoAndWhere || subset
  })
}

function cardView(c: StoredCard): CardView {
  return { id: c.id, brand: c.brand, last4: c.number.slice(-4), expMonth: c.expMonth, expYear: c.expYear, holder: c.holder }
}

type Listener = () => void

export class WalletStore implements Wallet {
  readonly #path: string
  readonly #cipher: VaultCipher
  #data: WalletData | null = null
  #broken = false
  readonly #listeners = new Set<Listener>()
  readonly #now: () => Date

  /** `dataDir` is Atelier's data folder: one wallet, shared by every browser profile (passwords/index.ts). */
  constructor(dataDir: string, cipher: VaultCipher, now: () => Date = () => new Date()) {
    this.#path = join(dataDir, WALLET_FILE)
    this.#cipher = cipher
    this.#now = now
  }

  available(): boolean {
    if (!this.#cipher.available()) return false
    try {
      this.#load()
      return true
    } catch {
      return false
    }
  }

  onChange(fn: Listener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  // ── addresses ──

  addresses(): AddressView[] {
    const data = this.#load()
    return data.addresses.map((a) => addressView(a, data.mine)).sort((a, b) => Number(b.mine) - Number(a.mine) || b.updatedAt - a.updatedAt)
  }

  mine(): AddressView | null {
    const data = this.#load()
    const found = data.addresses.find((a) => a.id === data.mine)
    return found ? addressView(found, data.mine) : null
  }

  setMine(id: string | null): void {
    const data = this.#load()
    if (id !== null && !data.addresses.some((a) => a.id === id)) throw new Error(mainT('passwords.err.addressGone'))
    if ((id ?? '') === data.mine) return
    this.#change((next) => {
      next.mine = id ?? ''
    })
  }

  addressForFill(id: string): Address {
    const found = this.#load().addresses.find((a) => a.id === id)
    if (!found) throw new Error(mainT('passwords.err.addressGone'))
    const { updatedAt: _updatedAt, ...address } = found
    return address
  }

  saveAddress(a: AddressInput & { id?: string; mine?: boolean }): AddressView {
    const fields = validateAddress(a)
    return this.#change((data) => {
      const now = this.#now().getTime()
      const mark = (id: string): void => {
        if (a.mine === true) data.mine = id
        else if (a.mine === false && data.mine === id) data.mine = ''
      }
      if (a.id) {
        const index = data.addresses.findIndex((x) => x.id === a.id)
        if (index < 0) throw new Error(mainT('passwords.err.addressGone'))
        const next = { ...fields, id: a.id, updatedAt: now }
        data.addresses[index] = next
        mark(a.id)
        return addressView(next, data.mine)
      }
      // A copy of a saved address fills that one in (its empty fields) instead of adding a twin.
      const index = sameAddress(data.addresses, fields)
      const same = data.addresses[index]
      if (same) {
        for (const k of ADDRESS_KEYS) if (same[k].trim() === '' && fields[k] !== '') same[k] = fields[k]
        same.updatedAt = now
        mark(same.id)
        return addressView(same, data.mine)
      }
      if (data.addresses.length >= ADDRESSES_MAX) throw new Error(mainT('passwords.err.addressesFull'))
      const next = { ...fields, id: randomUUID(), updatedAt: now }
      data.addresses.push(next)
      mark(next.id)
      return addressView(next, data.mine)
    })
  }

  removeAddress(id: string): void {
    if (!this.#load().addresses.some((a) => a.id === id)) return
    this.#change((data) => {
      data.addresses = data.addresses.filter((a) => a.id !== id)
      if (data.mine === id) data.mine = ''
    })
  }

  // ── cards ──

  cards(): CardView[] {
    return this.#load()
      .cards.map(cardView)
      .sort((a, b) => a.holder.localeCompare(b.holder) || a.last4.localeCompare(b.last4))
  }

  cardForFill(id: string): { number: string; holder: string; expMonth: number; expYear: number } {
    const found = this.#load().cards.find((c) => c.id === id)
    if (!found) throw new Error(mainT('passwords.err.cardGone'))
    return { number: found.number, holder: found.holder, expMonth: found.expMonth, expYear: found.expYear }
  }

  saveCard(c: CardInput): CardView {
    return this.#change((data) => {
      const existing = c.id ? (data.cards.find((x) => x.id === c.id) ?? null) : null
      if (c.id && !existing) throw new Error(mainT('passwords.err.cardGone'))
      const fields = validateCard(c, existing, this.#now())
      const now = this.#now().getTime()
      // Saving a number that is already there updates that card instead of adding a twin.
      const twin = data.cards.find((x) => x.number === fields.number && x.id !== existing?.id)
      if (twin && existing) throw new Error(mainT('passwords.err.cardTwin'))
      const target = existing ?? twin
      if (target) {
        Object.assign(target, fields, { brand: cardBrand(fields.number), updatedAt: now })
        return cardView(target)
      }
      if (data.cards.length >= CARDS_MAX) throw new Error(mainT('passwords.err.cardsFull'))
      const next: StoredCard = { id: randomUUID(), ...fields, brand: cardBrand(fields.number), updatedAt: now }
      data.cards.push(next)
      return cardView(next)
    })
  }

  removeCard(id: string): void {
    if (!this.#load().cards.some((c) => c.id === id)) return
    this.#change((data) => {
      data.cards = data.cards.filter((c) => c.id !== id)
    })
  }

  // ── save-card offers ──

  /** An HMAC of the digits, so strikes can be kept without keeping the number. */
  fingerprint(number: string): string {
    return createHmac('sha256', Buffer.from(this.#key(), 'base64')).update(cardDigits(number)).digest('hex')
  }

  offerAllowed(fingerprint: string, site: string): boolean {
    try {
      return (this.#load().strikes[strikeKey(fingerprint, site)] ?? 0) < STRIKES_TO_STOP
    } catch {
      return false
    }
  }

  strike(fingerprint: string, site: string): void {
    this.#change((data) => {
      const key = strikeKey(fingerprint, site)
      data.strikes[key] = Math.min(STRIKES_TO_STOP, (data.strikes[key] ?? 0) + 1)
      // Keep the table small: the oldest keys go first.
      const keys = Object.keys(data.strikes)
      for (const old of keys.slice(0, Math.max(0, keys.length - STRIKES_MAX))) delete data.strikes[old]
    })
  }

  /** Deletes every address, card and strike (Reset with secrets, ST-55). */
  wipe(): void {
    this.#broken = false
    this.#data = emptyWallet()
    if (existsSync(this.#path)) {
      if (this.#cipher.available()) this.#write(this.#data)
      else writeFileSync(this.#path, Buffer.alloc(0), { mode: 0o600 })
    }
    this.#emit()
  }

  #key(): string {
    const data = this.#load()
    if (data.hmacKey) return data.hmacKey
    // Made on first use and saved with the wallet, so fingerprints stay stable.
    const key = randomBytes(32).toString('base64')
    this.#change((next) => {
      next.hmacKey = key
    })
    return key
  }

  #change<T>(fn: (data: WalletData) => T): T {
    const current = this.#load()
    const data: WalletData = {
      addresses: current.addresses.map((a) => ({ ...a })),
      cards: current.cards.map((c) => ({ ...c })),
      strikes: { ...current.strikes },
      hmacKey: current.hmacKey,
      mine: current.mine,
    }
    const out = fn(data)
    if (this.#broken) throw new Error(mainT('passwords.err.walletBroken'))
    if (!this.#cipher.available()) throw new Error(mainT('passwords.err.walletNoKeychainSave'))
    this.#write(data)
    this.#data = data
    this.#emit()
    return out
  }

  #load(): WalletData {
    if (this.#data) return this.#data
    if (this.#broken) throw new Error(mainT('passwords.err.walletBroken'))
    if (!existsSync(this.#path) || readFileSync(this.#path).length === 0) {
      this.#data = emptyWallet()
      return this.#data
    }
    if (!this.#cipher.available()) throw new Error(mainT('passwords.err.walletNoKeychainOpen'))
    try {
      this.#data = parseWallet(JSON.parse(this.#cipher.decrypt(readFileSync(this.#path))))
    } catch {
      this.#broken = true
      throw new Error(mainT('passwords.err.walletBroken'))
    }
    return this.#data
  }

  #write(data: WalletData): void {
    mkdirSync(join(this.#path, '..'), { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.${process.pid}.tmp`
    writeFileSync(temp, this.#cipher.encrypt(JSON.stringify({ v: 1, ...data })), { mode: 0o600 })
    renameSync(temp, this.#path)
  }

  #emit(): void {
    for (const fn of this.#listeners) fn()
  }
}

function strikeKey(fingerprint: string, site: string): string {
  return `${fingerprint} ${site.trim().toLowerCase()}`
}

function emptyWallet(): WalletData {
  return { addresses: [], cards: [], strikes: {}, hmacKey: '', mine: '' }
}

function parseWallet(parsed: unknown): WalletData {
  if (!parsed || typeof parsed !== 'object') return emptyWallet()
  const v = parsed as Record<string, unknown>
  const addresses = Array.isArray(v.addresses) ? v.addresses.filter(isStoredAddress) : []
  const cards = Array.isArray(v.cards) ? v.cards.filter(isStoredCard).map((c) => ({ ...c, brand: cardBrand(c.number) })) : []
  const strikes: Record<string, number> = {}
  if (v.strikes && typeof v.strikes === 'object') {
    for (const [k, n] of Object.entries(v.strikes as Record<string, unknown>)) if (typeof n === 'number') strikes[k] = n
  }
  const mine = typeof v.mine === 'string' && addresses.some((a) => a.id === v.mine) ? v.mine : ''
  return { addresses, cards, strikes, hmacKey: typeof v.hmacKey === 'string' ? v.hmacKey : '', mine }
}

function isStoredAddress(value: unknown): value is StoredAddress {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.updatedAt === 'number' && (Object.keys(EMPTY_ADDRESS) as string[]).every((k) => typeof v[k] === 'string')
}

function isStoredCard(value: unknown): value is StoredCard {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.number === 'string' && typeof v.holder === 'string' && typeof v.expMonth === 'number' &&
    typeof v.expYear === 'number' && typeof v.updatedAt === 'number'
}
