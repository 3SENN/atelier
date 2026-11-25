/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_ADDRESS, type AddressInput } from '../src/shared/passwords'
import { chromiumAddresses, firefoxAddresses, firefoxProfileAddresses, saveImportedAddresses, toAddressInput } from '../src/main/importAddresses'
import { profileReader, runImport, type ImportSinks } from '../src/main/importBrowsers'
import type { VaultCipher } from '../src/main/passwords/vault'
import { WalletStore } from '../src/main/passwords/wallet'

// Saved addresses from another browser (ST-46): Chromium's Web Data in its
// three schemas and Firefox's autofill-profiles.json, into the wallet. Fixtures
// are built here; a card sits beside the addresses in each and must never be read.

const cipher: VaultCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join('')),
  decrypt: (data) => Buffer.from(data.toString().split('').reverse().join(''), 'base64').toString(),
}
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-addr-'))
const walletAt = (dir = tempDir(), c: VaultCipher = cipher): WalletStore => new WalletStore(dir, c)
const CARD = '4242424242424242'
const CARD_HOLDER = 'Card Holder Only'

/** The newer Chromium schemas: one table per record kind plus type tokens, with a card and a stray card token beside them. */
function newerWebData(file: string): void {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE local_addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR, label VARCHAR);
    CREATE TABLE local_addresses_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type));
    CREATE TABLE contact_info (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR, label VARCHAR);
    CREATE TABLE contact_info_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type));
    CREATE TABLE credit_cards (guid VARCHAR PRIMARY KEY, name_on_card VARCHAR, card_number_encrypted BLOB, expiration_month INTEGER, expiration_year INTEGER);
    CREATE TABLE masked_credit_cards (id VARCHAR, name_on_card VARCHAR, last_four VARCHAR);
  `)
  db.prepare('INSERT INTO local_addresses (guid, use_count) VALUES (?, ?)').run('g-sam', 5)
  const token = db.prepare('INSERT INTO local_addresses_type_tokens (guid, type, value) VALUES (?, ?, ?)')
  for (const [type, value] of [
    [3, 'Sam'],
    [5, 'Lee'],
    [7, 'Sam Lee'],
    [60, 'Lee & Co'],
    [77, '1 Main St\nFlat 2\nBack door\nRing twice'],
    [30, 'ignored when the street is there'],
    [33, 'Springfield'],
    [34, 'IL'],
    [35, '62701'],
    [36, 'us'],
    [9, 'sam@example.com'],
    [14, '+1 217 555 0100'],
    // A card token can't be in an address table, but if one were it still wouldn't be read.
    [52, CARD],
    [51, CARD_HOLDER],
  ] as const)
    token.run('g-sam', type, value)
  db.prepare('INSERT INTO contact_info (guid, use_count) VALUES (?, ?)').run('g-acct', 1)
  const acct = db.prepare('INSERT INTO contact_info_type_tokens (guid, type, value) VALUES (?, ?, ?)')
  for (const [type, value] of [
    [7, 'Alex Kim'],
    [30, 'Keizersgracht 1'],
    [31, '3e verdieping'],
    [33, 'Amsterdam'],
    [35, '1015 CJ'],
    [36, 'NL'],
  ] as const)
    acct.run('g-acct', type, value)
  db.prepare('INSERT INTO credit_cards (guid, name_on_card, card_number_encrypted, expiration_month, expiration_year) VALUES (?, ?, ?, ?, ?)').run('c1', CARD_HOLDER, Buffer.from(CARD), 12, 2030)
  db.prepare('INSERT INTO masked_credit_cards (id, name_on_card, last_four) VALUES (?, ?, ?)').run('m1', CARD_HOLDER, '4242')
  db.close()
}

/** The newest schema: one addresses table for every record type, with a leftover local table from before the merge. */
function newestWebData(file: string): void {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, record_type INTEGER, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR, label VARCHAR, initial_creator_id INTEGER, last_modifier_id INTEGER);
    CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type));
    CREATE TABLE local_addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE local_addresses_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR);
  `)
  db.prepare('INSERT INTO addresses (guid, record_type) VALUES (?, ?)').run('g-new', 0)
  const token = db.prepare('INSERT INTO address_type_tokens (guid, type, value) VALUES (?, ?, ?)')
  for (const [type, value] of [
    [3, 'Robin'],
    [5, 'Jansen'],
    [77, 'Dorpsstraat 5'],
    [33, 'Utrecht'],
    [36, 'NL'],
  ] as const)
    token.run('g-new', type, value)
  // The same guid in the old table, with an older street: the newest copy wins.
  db.prepare('INSERT INTO local_addresses (guid) VALUES (?)').run('g-new')
  db.prepare('INSERT INTO local_addresses_type_tokens (guid, type, value) VALUES (?, ?, ?)').run('g-new', 77, 'Old street 9')
  db.close()
}

/** The old Chromium schema: autofill_profiles with names, emails and phones per guid. */
function legacyWebData(file: string): void {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE autofill_profiles (guid VARCHAR PRIMARY KEY, company_name VARCHAR, street_address VARCHAR, dependent_locality VARCHAR, city VARCHAR, state VARCHAR, zipcode VARCHAR, sorting_code VARCHAR, country_code VARCHAR, date_modified INTEGER NOT NULL DEFAULT 0, origin VARCHAR DEFAULT '', language_code VARCHAR, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE autofill_profile_names (guid VARCHAR, first_name VARCHAR, middle_name VARCHAR, last_name VARCHAR, full_name VARCHAR);
    CREATE TABLE autofill_profile_emails (guid VARCHAR, email VARCHAR);
    CREATE TABLE autofill_profile_phones (guid VARCHAR, number VARCHAR);
    CREATE TABLE credit_cards (guid VARCHAR PRIMARY KEY, name_on_card VARCHAR, card_number_encrypted BLOB);
  `)
  const profile = db.prepare('INSERT INTO autofill_profiles (guid, company_name, street_address, city, state, zipcode, country_code, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  profile.run('p1', 'Acme', '10 Downing St', 'London', '', 'SW1A 2AA', 'GB', 3)
  // A country written out in full is dropped, not guessed; a phone the wallet can't take is left out.
  profile.run('p2', '', '5 Rue de Rivoli', 'Paris', '', '75001', 'France', 1)
  profile.run('p3', '', '', '', '', '', '', 0)
  db.prepare('INSERT INTO autofill_profile_names (guid, first_name, middle_name, last_name, full_name) VALUES (?, ?, ?, ?, ?)').run('p1', 'Pat', 'Q', 'Smith', 'Pat Q Smith')
  db.prepare('INSERT INTO autofill_profile_names (guid, first_name, middle_name, last_name, full_name) VALUES (?, ?, ?, ?, ?)').run('p1', 'Second', '', 'Name', '')
  db.prepare('INSERT INTO autofill_profile_emails (guid, email) VALUES (?, ?)').run('p1', 'pat@example.org')
  db.prepare('INSERT INTO autofill_profile_phones (guid, number) VALUES (?, ?)').run('p1', '020 7946 0000')
  db.prepare('INSERT INTO autofill_profile_names (guid, first_name, middle_name, last_name, full_name) VALUES (?, ?, ?, ?, ?)').run('p2', 'Claude', '', 'Martin', '')
  db.prepare('INSERT INTO autofill_profile_phones (guid, number) VALUES (?, ?)').run('p2', 'call me maybe')
  db.prepare('INSERT INTO credit_cards (guid, name_on_card, card_number_encrypted) VALUES (?, ?, ?)').run('c1', CARD_HOLDER, Buffer.from(CARD))
  db.close()
}

const FIREFOX_JSON = {
  version: 1,
  addresses: [
    {
      guid: 'f1',
      'given-name': 'Jo',
      'additional-name': '',
      'family-name': 'Doe',
      name: 'Jo Doe',
      organization: 'Doe BV',
      'street-address': 'Hoofdstraat 12\nachterom',
      'address-level2': 'Gent',
      'address-level1': 'Oost-Vlaanderen',
      'postal-code': '9000',
      country: 'BE',
      tel: '+32470123456',
      email: 'jo@example.be',
    },
    { guid: 'f2', timeLastModified: 1, deleted: true },
  ],
  creditCards: [{ guid: 'cc1', 'cc-name': CARD_HOLDER, 'cc-number': CARD, 'cc-exp-month': 12, 'cc-exp-year': 2030 }],
}

/** Every SQL statement prepared while `fn` runs. */
function preparedSql<T>(fn: () => T): { result: T; sql: string[] } {
  const sql: string[] = []
  const original = DatabaseSync.prototype.prepare
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, statement: string) {
    sql.push(statement)
    return original.call(this, statement)
  })
  try {
    return { result: fn(), sql }
  } finally {
    spy.mockRestore()
  }
}

const address = (over: Partial<AddressInput>): AddressInput => ({ ...EMPTY_ADDRESS, ...over })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reading saved addresses (ST-46)', () => {
  it('reads the newer Chromium tables, local and account, with street lines and names split out', () => {
    const file = join(tempDir(), 'Web Data')
    newerWebData(file)
    const { result, sql } = preparedSql(() => chromiumAddresses(file))
    expect(result).toEqual([
      address({ givenName: 'Sam', familyName: 'Lee', organization: 'Lee & Co', line1: '1 Main St', line2: 'Flat 2', line3: 'Back door, Ring twice', city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US', email: 'sam@example.com', tel: '+1 217 555 0100' }),
      // Only a full name: it goes in as given rather than being split by a guess.
      address({ givenName: 'Alex Kim', line1: 'Keizersgracht 1', line2: '3e verdieping', city: 'Amsterdam', postalCode: '1015 CJ', country: 'NL' }),
    ])
    // Card tables are never touched, and the token query asks for address types only.
    expect(sql.some((s) => /credit|card|masked|payments|iban|server_/i.test(s))).toBe(false)
    expect(sql.find((s) => s.includes('type_tokens'))).not.toMatch(/\b5[1-9]\b/)
    expect(JSON.stringify(result)).not.toContain(CARD)
    expect(JSON.stringify(result)).not.toContain(CARD_HOLDER)
  })

  it('reads the newest single addresses table and lets it win over a leftover copy', () => {
    const file = join(tempDir(), 'Web Data')
    newestWebData(file)
    expect(chromiumAddresses(file)).toEqual([address({ givenName: 'Robin', familyName: 'Jansen', line1: 'Dorpsstraat 5', city: 'Utrecht', country: 'NL' })])
  })

  it('reads the old autofill_profiles tables, keeping the first name, email and phone per profile', () => {
    const file = join(tempDir(), 'Web Data')
    legacyWebData(file)
    const { result, sql } = preparedSql(() => chromiumAddresses(file))
    expect(result[0]).toEqual(address({ givenName: 'Pat', additionalName: 'Q', familyName: 'Smith', organization: 'Acme', line1: '10 Downing St', city: 'London', postalCode: 'SW1A 2AA', country: 'GB', email: 'pat@example.org', tel: '020 7946 0000' }))
    expect(result[1]).toMatchObject({ givenName: 'Claude', familyName: 'Martin', line1: '5 Rue de Rivoli', country: '', tel: 'call me maybe' })
    expect(result).toHaveLength(3)
    expect(sql.some((s) => /credit|card/i.test(s))).toBe(false)
  })

  it('reads a Web Data file with no address tables as empty', () => {
    const file = join(tempDir(), 'Web Data')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE keywords (short_name VARCHAR, url VARCHAR)')
    db.close()
    expect(chromiumAddresses(file)).toEqual([])
  })

  it('reads Firefox addresses, skips deleted ones and never looks at credit cards', () => {
    const json = { ...FIREFOX_JSON }
    Object.defineProperty(json, 'creditCards', {
      get: () => {
        throw new Error('credit cards were read')
      },
      enumerable: true,
    })
    expect(firefoxAddresses(json)).toEqual([
      address({ givenName: 'Jo', familyName: 'Doe', organization: 'Doe BV', line1: 'Hoofdstraat 12', line2: 'achterom', city: 'Gent', region: 'Oost-Vlaanderen', postalCode: '9000', country: 'BE', tel: '+32470123456', email: 'jo@example.be' }),
    ])
    expect(firefoxAddresses({ creditCards: [] })).toEqual([])
    expect(firefoxAddresses(null)).toEqual([])
    const dir = tempDir()
    writeFileSync(join(dir, 'autofill-profiles.json'), JSON.stringify(FIREFOX_JSON))
    expect(firefoxProfileAddresses(dir)).toHaveLength(1)
    expect(firefoxProfileAddresses(tempDir())).toEqual([])
  })

  it('trims every field to the wallet’s limit and keeps only real ISO country codes', () => {
    const long = 'x'.repeat(500)
    const out = toAddressInput({ city: long, country: 'Nederland' })
    expect(out.city).toHaveLength(200)
    expect(out.country).toBe('')
    expect(toAddressInput({ country: ' de ' }).country).toBe('DE')
  })
})

describe('saving imported addresses into the wallet (ST-46)', () => {
  it('adds new ones once: a second import, or one already saved, adds nothing', () => {
    const chromeFile = join(tempDir(), 'Web Data')
    newerWebData(chromeFile)
    const legacyFile = join(tempDir(), 'Web Data')
    legacyWebData(legacyFile)
    const wallet = walletAt()
    // Already saved by hand, with fewer fields: the import fills it in, it doesn't add a twin.
    wallet.saveAddress(address({ givenName: 'Sam', familyName: 'Lee', line1: '1 Main St', city: 'Springfield' }))
    const items = [...chromiumAddresses(chromeFile), ...chromiumAddresses(legacyFile), ...firefoxAddresses(FIREFOX_JSON)]
    const first = saveImportedAddresses(wallet, items)
    // Sam (already there), Alex, Pat, Claude (phone left out), Jo; the empty legacy profile is refused.
    expect(first).toEqual({ added: 4, already: 1, skipped: 1, full: 0 })
    const saved = wallet.addresses()
    expect(saved).toHaveLength(5)
    expect(saved.find((a) => a.givenName === 'Sam')).toMatchObject({ organization: 'Lee & Co', email: 'sam@example.com', country: 'US', line2: 'Flat 2' })
    expect(saved.find((a) => a.givenName === 'Claude')).toMatchObject({ tel: '', country: '', city: 'Paris' })
    const again = saveImportedAddresses(wallet, items)
    expect(again).toEqual({ added: 0, already: 5, skipped: 1, full: 0 })
    expect(wallet.addresses()).toHaveLength(5)
    // Cards stay out of it entirely.
    expect(wallet.cards()).toEqual([])
    expect(JSON.stringify(wallet.addresses())).not.toContain(CARD)
  })

  it('respects the wallet’s limit: full when nothing new fits, copies still merged', () => {
    const wallet = walletAt()
    for (let i = 0; i < 200; i++) wallet.saveAddress(address({ givenName: `Person ${i}`, line1: `${i} Long Road` }))
    expect(() => saveImportedAddresses(wallet, [address({ givenName: 'Newcomer', line1: '1 New St' })])).toThrow(/as many addresses/)
    // A copy of a saved one is still merged on the way; the new one is what didn't fit.
    expect(() => saveImportedAddresses(wallet, [address({ givenName: 'Person 3', line1: '3 Long Road', city: 'Leeds' }), address({ givenName: 'Late', line1: '2 New St' })])).toThrow(/as many addresses/)
    expect(wallet.addresses().find((a) => a.givenName === 'Person 3')?.city).toBe('Leeds')
    expect(wallet.addresses()).toHaveLength(200)
    // Some new ones in, some not: the count says what came over.
    wallet.removeAddress(wallet.addresses()[0]?.id ?? '')
    expect(saveImportedAddresses(wallet, [address({ givenName: 'First', line1: '1 New St' }), address({ givenName: 'Second', line1: '2 New St' })])).toEqual({ added: 1, already: 0, skipped: 0, full: 1 })
  })

  it('imports addresses end to end from a Chrome profile, and a wallet without a keychain fails that type alone', async () => {
    const home = tempDir()
    const profile = join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'Example', url: 'https://example.com/' }] } } }))
    newerWebData(join(profile, 'Web Data'))
    const reader = profileReader('darwin', home, {}, 'chrome', 'Default')
    const sinks = (wallet: WalletStore): ImportSinks => ({
      bookmarks: (items) => items.length,
      history: (items) => items.length,
      tabs: (items) => items.length,
      searchEngines: (items) => items.length,
      addresses: (items) => saveImportedAddresses(wallet, items).added,
      cookies: (items) => items.length,
    })
    const request = { browserId: 'chrome', profileId: 'Default', types: ['bookmarks' as const, 'addresses' as const] }
    const wallet = walletAt()
    expect(await runImport(reader, sinks(wallet), request, () => undefined)).toMatchObject({ outcome: 'success', counts: { bookmarks: 1, addresses: 2 }, failed: [] })
    expect((await runImport(reader, sinks(wallet), request, () => undefined)).counts.addresses).toBe(0)

    // No keychain: an existing wallet can't be opened, and a new one can't be saved; bookmarks still come over.
    const noKeychain: VaultCipher = { ...cipher, available: () => false }
    const lockedDir = tempDir()
    walletAt(lockedDir).saveAddress(address({ givenName: 'Kept' }))
    for (const locked of [walletAt(lockedDir, noKeychain), walletAt(tempDir(), noKeychain)]) {
      const summary = await runImport(reader, sinks(locked), request, () => undefined)
      expect(summary.outcome).toBe('partial')
      expect(summary.counts.bookmarks).toBe(1)
      expect(summary.failed.map((f) => f.type)).toEqual(['addresses'])
      expect(summary.failed[0]?.message).toMatch(/keychain/i)
    }
  })
})
