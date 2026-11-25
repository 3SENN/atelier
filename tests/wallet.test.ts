/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_ADDRESS, addressLabel, cardBrand, cardExpired, cardNumberValid, luhnValid } from '../src/shared/passwords'
import { PASSWORDS_SCHEMAS } from '../src/main/passwords/schemas'
import type { VaultCipher } from '../src/main/passwords/vault'
import { STRIKES_TO_STOP, WALLET_FILE, WalletStore, validateAddress, validateCard } from '../src/main/passwords/wallet'

// The wallet (ST-43, ST-44): addresses, cards behind Luhn, no security
// codes anywhere, views that never carry the number, and offer strikes.

const cipher: VaultCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join('')),
  decrypt: (data) => Buffer.from(data.toString().split('').reverse().join(''), 'base64').toString(),
}
const NOW = new Date(2026, 9, 29)
const walletAt = (dir = mkdtempSync(join(tmpdir(), 'atelier-wallet-'))): WalletStore => new WalletStore(dir, cipher, () => NOW)
// Well-known test numbers from the card networks' documentation.
const VISA = '4242 4242 4242 4242'
const AMEX = '378282246310005'

describe('card checks', () => {
  it('checks Luhn and length', () => {
    expect(luhnValid('4242424242424242')).toBe(true)
    expect(luhnValid('4242424242424241')).toBe(false)
    expect(cardNumberValid(VISA)).toBe(true)
    expect(cardNumberValid('4242-4242-4242-4242')).toBe(true)
    expect(cardNumberValid('42424242')).toBe(false)
    expect(cardNumberValid('abcd')).toBe(false)
  })

  it('detects brands from the leading digits', () => {
    expect(cardBrand(VISA)).toBe('visa')
    expect(cardBrand('5555555555554444')).toBe('mastercard')
    expect(cardBrand('2223003122003222')).toBe('mastercard')
    expect(cardBrand(AMEX)).toBe('amex')
    expect(cardBrand('6011111111111117')).toBe('discover')
    expect(cardBrand('6221260000000000')).toBe('discover')
    expect(cardBrand('6200000000000005')).toBe('unionpay')
    expect(cardBrand('3056930009020004')).toBe('diners')
    expect(cardBrand('3566002020360505')).toBe('jcb')
    expect(cardBrand('6759649826438453')).toBe('maestro')
    expect(cardBrand('9999999999999995')).toBe('unknown')
  })

  it('knows when a card has expired', () => {
    expect(cardExpired(9, 2026, NOW)).toBe(true)
    expect(cardExpired(10, 2026, NOW)).toBe(false)
    expect(cardExpired(1, 2027, NOW)).toBe(false)
  })

  it('refuses security codes, bad numbers and past expiry', () => {
    const base = { number: VISA, holder: 'Sam Lee', expMonth: 12, expYear: 2030 }
    expect(() => validateCard({ ...base, cvc: '123' } as never, null, NOW)).toThrow(/never saves security codes/)
    expect(() => validateCard({ ...base, number: '4242424242424241' }, null, NOW)).toThrow(/doesn’t look right/)
    expect(() => validateCard({ ...base, expMonth: 1, expYear: 2026 }, null, NOW)).toThrow(/expired/)
    expect(() => validateCard({ holder: 'x', expMonth: 1, expYear: 2030 }, null, NOW)).toThrow(/card number/)
    expect(validateCard(base, null, NOW).number).toBe('4242424242424242')
  })

  it('has no schema field for a security code', () => {
    const schema = PASSWORDS_SCHEMAS.wallet.saveCard
    const card = { number: VISA, holder: 'Sam', expMonth: 1, expYear: 2030 }
    expect(schema.safeParse([card]).success).toBe(true)
    for (const key of ['cvc', 'cvv', 'csc', 'securityCode']) expect(schema.safeParse([{ ...card, [key]: '123' }]).success).toBe(false)
  })
})

describe('addresses', () => {
  it('validates and labels addresses', () => {
    expect(() => validateAddress(EMPTY_ADDRESS)).toThrow(/at least/)
    expect(() => validateAddress({ ...EMPTY_ADDRESS, givenName: 'Sam', email: 'nope' })).toThrow(/email/)
    expect(() => validateAddress({ ...EMPTY_ADDRESS, givenName: 'Sam', country: 'Netherlands' })).toThrow(/country/)
    const a = validateAddress({ ...EMPTY_ADDRESS, givenName: ' Sam ', familyName: 'Lee', line1: '1 Main St', country: 'nl' })
    expect(a.givenName).toBe('Sam')
    expect(a.country).toBe('NL')
    expect(addressLabel(a)).toBe('Sam Lee, 1 Main St')
    expect(addressLabel({ ...EMPTY_ADDRESS, email: 'sam@example.invalid' })).toBe('sam@example.invalid')
  })

  it('lists, edits, dedupes and removes', () => {
    const wallet = walletAt()
    const saved = wallet.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Sam', line1: '1 Main St', city: 'Utrecht' })
    expect(saved.label).toBe('Sam, 1 Main St')
    expect(wallet.saveAddress({ ...EMPTY_ADDRESS, givenName: 'sam', line1: '1 main st', city: 'utrecht' }).id).toBe(saved.id)
    const edited = wallet.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Sam', line1: '2 Main St', id: saved.id })
    expect(edited.line1).toBe('2 Main St')
    expect(wallet.addresses()).toHaveLength(1)
    expect(wallet.addressForFill(saved.id).line1).toBe('2 Main St')
    wallet.removeAddress(saved.id)
    expect(wallet.addresses()).toEqual([])
    expect(() => wallet.saveAddress({ ...EMPTY_ADDRESS, givenName: 'x', id: saved.id })).toThrow(/no longer exists/)
  })
})

describe('your own address', () => {
  const robin = { ...EMPTY_ADDRESS, givenName: 'Robin', familyName: 'Vos', line1: 'Kade 1', city: 'Gent', postalCode: '9000', country: 'BE' }

  it('marks one address as yours, lists it first and clears it when removed', () => {
    const w = walletAt()
    const mine = w.saveAddress({ ...robin, mine: true })
    const other = w.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Sam', familyName: 'Lee', line1: 'Main St 1' })
    expect(w.mine()?.id).toBe(mine.id)
    expect(w.addresses().map((a) => [a.id, a.mine])).toEqual([[mine.id, true], [other.id, false]])
    w.setMine(other.id)
    expect(w.mine()?.id).toBe(other.id)
    expect(() => w.setMine('00000000-0000-4000-8000-000000000000')).toThrow()
    w.removeAddress(other.id)
    expect(w.mine()).toBeNull()
    w.setMine(mine.id)
    w.saveAddress({ ...robin, id: mine.id, mine: false })
    expect(w.mine()).toBeNull()
  })

  it('keeps which address is yours across reopening, and reads older wallets without it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-wallet-'))
    const mine = walletAt(dir).saveAddress({ ...robin, mine: true })
    expect(walletAt(dir).mine()?.id).toBe(mine.id)
    walletAt(dir).wipe()
    expect(walletAt(dir).mine()).toBeNull()
  })

  it('fills in a saved address instead of adding a near-copy', () => {
    const w = walletAt()
    const first = w.saveAddress({ ...robin, mine: true })
    // The same place with an email and phone added, spelled a little differently: one entry, filled in.
    const again = w.saveAddress({ ...robin, line1: 'kade 1', postalCode: '9000 ', email: 'robin@example.com', tel: '+32 470 12 34 56' })
    expect(again.id).toBe(first.id)
    expect(w.addresses()).toHaveLength(1)
    expect(w.mine()).toMatchObject({ email: 'robin@example.com', tel: '+32 470 12 34 56', mine: true })
    // Only part of it (what a shop's form had): still the same entry, nothing lost.
    expect(w.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Robin', familyName: 'Vos', postalCode: '9000' }).id).toBe(first.id)
    expect(w.mine()?.line1).toBe('Kade 1')
    // A new address that is a copy of yours, saved without saying it is yours, leaves yours marked.
    expect(w.saveAddress({ ...robin, email: 'robin@example.com', mine: false }).id).toBe(first.id)
    expect(w.mine()?.id).toBe(first.id)
    // Someone else at the same address, or the same person elsewhere, is a new entry.
    expect(w.saveAddress({ ...robin, givenName: 'Kim' }).id).not.toBe(first.id)
    expect(w.saveAddress({ ...robin, line1: 'Dok 7', postalCode: '9000', city: 'Gent' }).id).not.toBe(first.id)
    expect(w.addresses()).toHaveLength(3)
  })

  it('never merges on a name alone, and keeps hyphenated house numbers apart', () => {
    const w = walletAt()
    const sam = w.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Sam', mine: true })
    // A friend's checkout address with the same first name is someone else, not your details.
    const friend = w.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Sam', familyName: 'Peters', line1: '5 Other St', city: 'Gent' })
    expect(friend.id).not.toBe(sam.id)
    expect(w.mine()?.line1).toBe('')
    const a = w.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Kim', line1: 'Kerkstraat 1-3' })
    expect(w.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Kim', line1: 'Kerkstraat 13' }).id).not.toBe(a.id)
  })
})

describe('cards', () => {
  it('stores the number encrypted and never shows it in views', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-wallet-'))
    const wallet = walletAt(dir)
    const view = wallet.saveCard({ number: VISA, holder: 'Sam Lee', expMonth: 12, expYear: 2030 })
    expect(view).toEqual({ id: view.id, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, holder: 'Sam Lee' })
    expect(JSON.stringify(wallet.cards())).not.toContain('42424242')
    expect(wallet.cardForFill(view.id).number).toBe('4242424242424242')
    const file = join(dir, WALLET_FILE)
    expect(readFileSync(file).toString()).not.toContain('4242424242424242')
    // Windows has no POSIX permission bits to check.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    // A fresh store reads it back.
    expect(walletAt(dir).cards()).toHaveLength(1)
  })

  it('keeps the saved number when an edit leaves it out, and refuses a twin', () => {
    const wallet = walletAt()
    const visa = wallet.saveCard({ number: VISA, holder: 'Sam', expMonth: 12, expYear: 2030 })
    const edited = wallet.saveCard({ id: visa.id, holder: 'Sam Lee', expMonth: 1, expYear: 2031 })
    expect(edited).toMatchObject({ last4: '4242', holder: 'Sam Lee', expMonth: 1, expYear: 2031 })
    // Saving the same number again updates the existing card.
    expect(wallet.saveCard({ number: VISA, holder: 'S', expMonth: 2, expYear: 2032 }).id).toBe(visa.id)
    const amex = wallet.saveCard({ number: AMEX, holder: 'Sam', expMonth: 5, expYear: 2029 })
    expect(amex.brand).toBe('amex')
    expect(() => wallet.saveCard({ id: amex.id, number: VISA, holder: 'Sam', expMonth: 5, expYear: 2029 })).toThrow(/already saved/)
    wallet.removeCard(amex.id)
    expect(wallet.cards().map((c) => c.last4)).toEqual(['4242'])
  })

  it('stops offers after three strikes per card and site', () => {
    const wallet = walletAt()
    const fp = wallet.fingerprint(VISA)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(fp).toBe(wallet.fingerprint('4242424242424242'))
    expect(fp).not.toContain('4242')
    for (let i = 0; i < STRIKES_TO_STOP - 1; i++) wallet.strike(fp, 'shop.example.com')
    expect(wallet.offerAllowed(fp, 'shop.example.com')).toBe(true)
    wallet.strike(fp, 'SHOP.example.com')
    expect(wallet.offerAllowed(fp, 'shop.example.com')).toBe(false)
    expect(wallet.offerAllowed(fp, 'other.example.com')).toBe(true)
  })

  it('keeps fingerprints stable across reopening, and wipes everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-wallet-'))
    const first = walletAt(dir).fingerprint(VISA)
    expect(walletAt(dir).fingerprint(VISA)).toBe(first)
    const wallet = walletAt(dir)
    wallet.saveCard({ number: VISA, holder: 'Sam', expMonth: 12, expYear: 2030 })
    wallet.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Sam' })
    let changes = 0
    wallet.onChange(() => changes++)
    wallet.wipe()
    expect(changes).toBe(1)
    expect(wallet.cards()).toEqual([])
    expect(walletAt(dir).addresses()).toEqual([])
  })

  it('shows an unavailable state when the keychain is gone, never a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-wallet-'))
    walletAt(dir).saveCard({ number: VISA, holder: 'Sam', expMonth: 12, expYear: 2030 })
    const locked = new WalletStore(dir, { ...cipher, available: () => false }, () => NOW)
    expect(locked.available()).toBe(false)
    expect(locked.offerAllowed('x', 'y')).toBe(false)
    expect(() => locked.cards()).toThrow(/keychain/)
    const broken = new WalletStore(dir, { ...cipher, decrypt: () => 'not json' }, () => NOW)
    expect(broken.available()).toBe(false)
    expect(() => broken.saveAddress({ ...EMPTY_ADDRESS, givenName: 'Sam' })).toThrow(/can’t open/)
  })
})
