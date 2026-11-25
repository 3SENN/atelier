/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest'
import { STILLNESS_MS } from '@shared/autofill'
import { agentFocusedGuard, guardRefusal, maskForAgent, setAgentGuardHooks, agentGuardedAt } from '../src/main/autofill/agentGuard'
import { isSecureOrigin } from '../src/main/autofill/controller'
import { addressComplete, addressFromValues, brandOf, cardFromValues, decideAddressOffer, decideCardOffer, decideLoginOffer, loginFromValues, maskedNumber } from '../src/main/autofill/offers'
import { SplitLoginMemory, TYPED_TTL_MS, USERNAME_TTL_MS } from '../src/main/autofill/splitLogin'
import { generatePassword, parseRowId } from '../src/main/autofill/rows'
import { FakeFrame, cred, flush, focus, harness, type Harness } from './fixtures/autofill/fakes'

// The per-tab autofill controller (OV-25 to OV-29, OV-31, ST-34): popup
// gating, the stillness rule, keyboard picks, split logins, save offers
// with strikes, card and address fill behind auth, and the agent's limits.

async function openLogin(h: Harness, extra: Record<string, unknown> = {}): Promise<void> {
  h.controller.onReport(h.top, focus('current-password', 'login', extra))
  await flush()
}

function shownStill(h: Harness): string {
  const id = h.controller.popupId ?? ''
  h.controller.surfaceShown(id, { x: 100, y: 156, width: 300, height: 120 })
  h.clock.now += STILLNESS_MS
  return id
}

describe('password popup gating (OV-26)', () => {
  it('offers the logins saved for the exact origin', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw-1')
    h.vault.add(cred('2', 'https://other.example', 'sam'), 'pw-2')
    await openLogin(h)
    const popup = h.presenter.shown.at(-1)
    expect(popup?.surface).toBe('autofill-login')
    const rows = popup?.props.rows as Array<{ id: string; kind: string; title: string }>
    expect(rows.map((r) => r.id)).toEqual(['l:1', 'manage'])
    expect(rows[0]?.title).toBe('robin')
    expect(h.top.last('popup')).toEqual({ type: 'popup', open: true, active: false })
  })

  it('stays away from agent-controlled tabs, filled forms and typed fields with no match', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw-1')
    h.tab.controlled = true
    await openLogin(h)
    expect(h.presenter.shown).toHaveLength(0)
    h.tab.controlled = false
    await openLogin(h, { filled: { username: true, password: true } })
    expect(h.presenter.shown).toHaveLength(0)

    const empty = harness()
    await openLogin(empty, { typed: true })
    expect(empty.presenter.shown).toHaveLength(0)
    // A username-only page with nothing saved offers nothing either.
    empty.controller.onReport(empty.top, focus('username', 'login'))
    await flush()
    expect(empty.presenter.shown).toHaveLength(0)
  })

  it('shows the empty state once per form, then not again', async () => {
    const h = harness()
    await openLogin(h)
    expect((h.presenter.shown[0]?.props.rows as unknown[]).length).toBe(1)
    h.controller.closePopup()
    await openLogin(h)
    expect(h.presenter.shown).toHaveLength(1)
  })

  it('preselects a saved username already in the page', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'alex', 1), 'a')
    h.vault.add(cred('2', 'https://shop.example', 'robin', 2), 'b')
    await openLogin(h, { username: 'Robin' })
    expect(h.presenter.shown[0]?.props.activeId).toBe('l:2')
    expect(h.top.last('popup')?.active).toBe(true)
  })

  it('offers a generated password on new-password fields, until you type', async () => {
    const h = harness('https://shop.example/signup')
    h.controller.onReport(h.top, focus('new-password', 'signup'))
    await flush()
    const rows = h.presenter.shown[0]?.props.rows as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['generated', 'manage'])
    const id = shownStill(h)
    expect(await h.controller.pick(id, 'generated')).toBe('filled')
    expect(h.top.last('fill')?.values).toEqual({ 'new-password': 'Gen-erated.Pass9' })

    const typed = harness('https://shop.example/signup')
    typed.controller.onReport(typed.top, focus('new-password', 'signup', { typed: true }))
    await flush()
    expect(typed.presenter.shown).toHaveLength(0)
  })

  it('stays hidden under a modal surface', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw')
    h.tab.modal = true
    await openLogin(h)
    expect(h.presenter.shown).toHaveLength(0)
  })

  it('shows the one-time import hint on a sign-in page with nothing saved (OV-31)', async () => {
    const h = harness()
    h.settings.importHintDismissed = false
    await openLogin(h)
    const hint = h.presenter.shown.at(-1)
    expect(hint?.surface).toBe('password-import-hint')
    hint?.settle({ instanceId: hint.id, value: 'import' })
    await flush()
    expect(h.opened).toContain('atelier://settings/passwords')
    expect(h.settings.importHintDismissed).toBe(true)
  })
})

describe('picks and the stillness rule (OV-25)', () => {
  it('refuses a pick until the popup has been visible and still for 500 ms', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw-1')
    await openLogin(h)
    const id = h.controller.popupId ?? ''
    expect(await h.controller.pick(id, 'l:1')).toBe('too-soon')
    h.controller.surfaceShown(id, { x: 100, y: 156, width: 300, height: 120 })
    h.clock.now += STILLNESS_MS - 1
    expect(await h.controller.pick(id, 'l:1')).toBe('too-soon')
    h.controller.surfaceShown(id, { x: 100, y: 180, width: 300, height: 120 })
    h.clock.now += STILLNESS_MS - 1
    expect(await h.controller.pick(id, 'l:1')).toBe('too-soon')
    h.clock.now += 1
    expect(await h.controller.pick(id, 'l:1')).toBe('filled')
    expect(h.top.last('fill')).toEqual({ type: 'fill', formId: 'g1', values: { username: 'robin', email: 'robin', 'current-password': 'pw-1' } })
    expect(h.vault.used).toContain('1')
    expect(h.controller.popupId).toBeNull()
  })

  it('opens Passwords filtered to the site from the manage row, with no wait', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw')
    await openLogin(h)
    expect(await h.controller.pick(h.controller.popupId ?? '', 'manage')).toBe('filled')
    expect(h.opened).toEqual(['atelier://passwords?site=shop.example'])
  })

  it('drives the popup with the arrow keys, Return and Esc from the page', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'alex', 2), 'a')
    h.vault.add(cred('2', 'https://shop.example', 'robin', 1), 'b')
    await openLogin(h)
    const popup = h.presenter.shown[0]
    h.controller.onReport(h.top, { type: 'key', key: 'ArrowDown' })
    h.controller.onReport(h.top, { type: 'key', key: 'ArrowDown' })
    expect((popup?.updates.at(-1) as { activeId: string }).activeId).toBe('l:2')
    h.controller.onReport(h.top, { type: 'key', key: 'ArrowUp' })
    expect((popup?.updates.at(-1) as { activeId: string }).activeId).toBe('l:1')
    shownStill(h)
    h.controller.onReport(h.top, { type: 'key', key: 'Enter' })
    await flush()
    expect(h.top.last('fill')?.values['current-password']).toBe('a')

    await openLogin(h)
    expect(h.controller.popupId).not.toBeNull()
    h.controller.onReport(h.top, { type: 'key', key: 'Escape' })
    expect(h.controller.popupId).toBeNull()
  })

  it('ignores keys from another frame', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw')
    await openLogin(h)
    const other = new FakeFrame('other', 'https://ads.example', 'https://ads.example/', false, h.top)
    h.controller.onReport(other, { type: 'key', key: 'Escape' })
    expect(h.controller.popupId).not.toBeNull()
  })

  it('closes on scroll, navigation, blur and the agent taking over', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw')
    for (const close of [
      () => h.controller.onReport(h.top, { type: 'scroll' }),
      () => h.controller.onNavigated({ mainFrame: true, inPage: false }),
      () => h.controller.onReport(h.top, { type: 'blur', fieldId: 'f1' }),
      () => h.controller.onAgentControl(),
    ]) {
      await openLogin(h)
      expect(h.controller.popupId).not.toBeNull()
      close()
      expect(h.controller.popupId).toBeNull()
      expect(h.top.last('popup')?.open).toBe(false)
    }
  })

  it('refuses a pick once a modal is open or the agent controls the tab', async () => {
    const h = harness()
    h.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw')
    await openLogin(h)
    let id = shownStill(h)
    h.tab.modal = true
    expect(await h.controller.pick(id, 'l:1')).toBe('gone')
    h.tab.modal = false
    await openLogin(h)
    id = shownStill(h)
    h.tab.controlled = true
    expect(await h.controller.pick(id, 'l:1')).toBe('gone')
    expect(h.top.last('fill')).toBeUndefined()
  })
})

describe('split logins (OV-28)', () => {
  it('remembers the first page username, fills the password page and offers to save both', async () => {
    const h = harness('https://shop.example/signin')
    h.controller.onReport(h.top, { type: 'submit', form: 'login', values: { email: 'robin@example.com' }, trigger: 'submit' })
    h.vault.add(cred('1', 'https://shop.example', 'robin@example.com'), 'pw-old')
    await openLogin(h)
    const popup = h.presenter.shown.at(-1)
    expect(popup?.props.activeId).toBe('l:1')
    const id = shownStill(h)
    expect(await h.controller.pick(id, 'l:1')).toBe('filled')
    expect(h.top.last('fill')?.values).toEqual({ 'current-password': 'pw-old' })

    h.controller.onReport(h.top, { type: 'submit', form: 'login', values: { 'current-password': 'pw-new' }, trigger: 'enter' })
    h.controller.onNavigated({ mainFrame: true, inPage: false })
    const offer = h.presenter.shown.at(-1)
    expect(offer?.surface).toBe('save-login')
    expect(offer?.props.mode).toBe('update')
    expect((offer?.props.fields as Array<{ key: string; value: string }>)[0]?.value).toBe('robin@example.com')
  })

  it('keeps typed credentials per URL for 60 s, and first-page usernames for 10 min', () => {
    const clock = { now: 0 }
    const mem = new SplitLoginMemory(() => clock.now)
    mem.rememberTyped({ url: 'https://a.example/login', origin: 'https://a.example', username: 'u', password: 'p' })
    mem.rememberUsername('https://a.example', 'robin')
    clock.now = TYPED_TTL_MS
    expect(mem.typed('https://a.example/login')?.username).toBe('u')
    expect(mem.latest('https://a.example')?.password).toBe('p')
    clock.now = TYPED_TTL_MS + 1
    expect(mem.typed('https://a.example/login')).toBeNull()
    expect(mem.username('https://a.example')).toBe('robin')
    clock.now = USERNAME_TTL_MS + 1
    expect(mem.username('https://a.example')).toBeNull()
    mem.rememberUsername('https://a.example', 'sam')
    mem.clear()
    expect(mem.username('https://a.example')).toBeNull()
  })
})

describe('save offers (OV-27, ST-34)', () => {
  function submitLogin(h: Harness, username = 'robin', password = 'pw-1'): void {
    h.controller.onReport(h.top, { type: 'submit', form: 'login', values: { username, 'current-password': password }, trigger: 'submit' })
    h.controller.onNavigated({ mainFrame: true, inPage: false })
  }

  it('offers to save after submit and navigation, then saves with a toast', async () => {
    const h = harness()
    submitLogin(h)
    const offer = h.presenter.shown.at(-1)
    expect(offer?.surface).toBe('save-login')
    expect(offer?.rect.x).toBeGreaterThan(600)
    await h.controller.respondOffer(offer?.id ?? '', 'save', { username: ' robin2 ', password: 'edited' })
    expect(h.vault.saved).toEqual([{ url: 'https://shop.example/login', username: 'robin2', password: 'edited' }])
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'success' })
    expect(h.notices).toHaveLength(0)
  })

  it('sends a passwords notification when Atelier is not in view', async () => {
    const h = harness()
    h.tab.inView = false
    submitLogin(h)
    expect(h.notices[0]).toMatchObject({ category: 'passwords' })
    await h.controller.respondOffer(h.controller.offerId ?? '', 'save')
    expect(h.notices.at(-1)).toMatchObject({ category: 'passwords', target: 'atelier://passwords?site=shop.example' })
  })

  it('never offers on agent tabs, never-save sites or with offers off, and marks an unchanged login used', () => {
    const agent = harness()
    agent.tab.controlled = true
    submitLogin(agent)
    expect(agent.presenter.shown).toHaveLength(0)

    const never = harness()
    never.vault.never.add('https://shop.example')
    submitLogin(never)
    expect(never.presenter.shown).toHaveLength(0)

    const off = harness()
    off.settings.offerSave = false
    submitLogin(off)
    expect(off.presenter.shown).toHaveLength(0)

    const same = harness()
    same.vault.add(cred('1', 'https://shop.example', 'robin'), 'pw-1')
    submitLogin(same)
    expect(same.presenter.shown).toHaveLength(0)
    expect(same.vault.used).toEqual(['1'])
  })

  it('is withdrawn when the agent takes over, and "never" adds the site to the list', async () => {
    const h = harness()
    submitLogin(h)
    expect(h.controller.offerId).not.toBeNull()
    h.controller.onAgentControl()
    expect(h.controller.offerId).toBeNull()
    expect(h.presenter.shown.at(-1)?.closed).toBe(true)

    submitLogin(h)
    await h.controller.respondOffer(h.controller.offerId ?? '', 'never')
    expect(h.vault.never.has('https://shop.example')).toBe(true)
  })

  it('treats Esc on the card as a dismissal', async () => {
    const h = harness()
    submitLogin(h)
    const offer = h.presenter.shown.at(-1)
    offer?.settle({ instanceId: offer.id, dismissed: 'escape' })
    await flush()
    expect(h.controller.offerId).toBeNull()
    expect(h.vault.saved).toHaveLength(0)
  })

  it('decides login offers', () => {
    const base = { settings: { offerSave: true }, agentControlled: false, neverSave: false, username: 'u', password: 'p' }
    expect(decideLoginOffer({ ...base, decision: { kind: 'new' } })).toEqual({ mode: 'save' })
    expect(decideLoginOffer({ ...base, decision: { kind: 'update', id: 'x' } })).toEqual({ mode: 'update', id: 'x' })
    expect(decideLoginOffer({ ...base, decision: { kind: 'same', id: 'x' } })).toEqual({ mode: 'used', id: 'x' })
    expect(decideLoginOffer({ ...base, agentControlled: true, decision: { kind: 'new' } })).toBeNull()
    expect(decideLoginOffer({ ...base, password: '', decision: { kind: 'new' } })).toBeNull()
    expect(decideLoginOffer({ ...base, decision: null })).toBeNull()
    expect(loginFromValues({ 'current-password': 'p' }, 'first-page')).toEqual({ username: 'first-page', password: 'p' })
    expect(loginFromValues({}, null)).toBeNull()
  })
})

describe('cards and addresses (OV-29)', () => {
  const card = { id: 'k1', brand: 'visa' as const, last4: '4242', expMonth: 7, expYear: 2029, holder: 'Robin Vos' }

  it('fills cards only on secure pages without a certificate exception', async () => {
    const insecure = harness('http://shop.example/pay')
    insecure.wallet.cardList = [card]
    insecure.controller.onReport(insecure.top, focus('cc-number', 'card'))
    await flush()
    expect(insecure.presenter.shown).toHaveLength(0)

    const exception = harness('https://shop.example/pay')
    exception.wallet.cardList = [card]
    exception.tab.certException = true
    exception.controller.onReport(exception.top, focus('cc-number', 'card'))
    await flush()
    expect(exception.presenter.shown).toHaveLength(0)

    expect(isSecureOrigin('http://localhost:5173')).toBe(true)
    expect(isSecureOrigin('http://127.0.0.1:8080')).toBe(true)
    expect(isSecureOrigin('http://shop.example')).toBe(false)
  })

  it('asks for auth before each card pick, then fills number, name and expiry', async () => {
    const h = harness('https://shop.example/pay')
    h.wallet.cardList = [card]
    h.controller.onReport(h.top, focus('cc-number', 'card'))
    await flush()
    const popup = h.presenter.shown[0]
    expect(popup?.surface).toBe('autofill-card')
    expect((popup?.props.rows as Array<{ title: string }>)[0]?.title).toBe('Visa •••• 4242')
    const id = shownStill(h)
    h.authAnswers.push('cancelled')
    expect(await h.controller.pick(id, 'c:k1')).toBe('auth-cancelled')
    expect(h.top.last('fill')).toBeUndefined()
    expect(await h.controller.pick(id, 'c:k1')).toBe('filled')
    expect(h.authReasons).toHaveLength(2)
    expect(h.top.last('fill')?.values).toEqual({ 'cc-number': '4242424242424242', 'cc-name': 'Robin Vos', 'cc-exp': '07/29', 'cc-exp-month': '07', 'cc-exp-year': '2029' })
  })

  it('names the frame site and the embedding site in a cross-site card frame', async () => {
    const h = harness('https://shop.example/checkout')
    h.wallet.cardList = [card]
    const pay = new FakeFrame('pay', 'https://pay.example', 'https://pay.example/card', false, h.top)
    h.frames.push(pay)
    pay.onSend = (c) => {
      if (c.type === 'probe-parent') queueMicrotask(() => h.controller.onReport(h.top, { type: 'probe', nonce: c.nonce, childRect: { x: 40, y: 300, width: 400, height: 200 } }))
    }
    h.controller.onReport(pay, focus('cc-number', 'card'))
    for (let i = 0; i < 4; i++) await flush()
    const popup = h.presenter.shown[0]
    expect(popup?.props).toMatchObject({ siteLabel: 'pay.example', embeddingSite: 'shop.example' })
    expect(popup?.props.anchorRect).toEqual({ x: 140, y: 420, width: 260, height: 32 })
  })

  it('offers to save a card after a secure checkout, and stops after three strikes', async () => {
    const h = harness('https://shop.example/pay')
    const submit = (): void => {
      h.controller.onReport(h.top, { type: 'submit', form: 'card', values: { 'cc-number': '4242 4242 4242 4242', 'cc-exp': '07/29', 'cc-name': 'Robin Vos', 'cc-csc': '123' }, trigger: 'submit' })
      h.controller.onNavigated({ mainFrame: true, inPage: false })
    }
    for (let i = 0; i < 3; i++) {
      submit()
      const offer = h.presenter.shown.at(-1)
      expect(offer?.surface).toBe('save-card')
      const fields = offer?.props.fields as Array<{ key: string; value: string }>
      expect(fields.map((f) => f.value)).toEqual(['Robin Vos', '•••• 4242', '07/29'])
      expect(JSON.stringify(offer?.props)).not.toContain('123')
      await h.controller.respondOffer(offer?.id ?? '', 'dismiss')
    }
    const before = h.presenter.shown.length
    submit()
    expect(h.presenter.shown).toHaveLength(before)
  })

  it('fills addresses after auth and offers to save a complete one', async () => {
    const h = harness('https://shop.example/address')
    h.wallet.addressList = [{ id: 'a1', label: 'Robin Vos, Kade 1', updatedAt: 0, givenName: 'Robin', additionalName: '', familyName: 'Vos', organization: '', line1: 'Kade 1', line2: '', line3: '', city: 'Gent', region: '', postalCode: '9000', country: 'BE', email: '', tel: '', mine: false }]
    h.controller.onReport(h.top, focus('address-line1', 'address'))
    await flush()
    const popup = h.presenter.shown[0]
    expect(popup?.surface).toBe('autofill-address')
    expect((popup?.props.rows as Array<{ title: string; subtitle: string }>)[0]).toMatchObject({ title: 'Robin Vos', subtitle: 'Kade 1, Gent' })
    const id = shownStill(h)
    expect(await h.controller.pick(id, 'a:a1')).toBe('filled')
    expect(h.authReasons).toHaveLength(1)
    expect(h.top.last('fill')?.values['address-line1']).toBe('Kade 1')

    h.controller.onReport(h.top, { type: 'submit', form: 'address', values: { name: 'Sam de Wit', 'address-line1': 'Dok 9', 'postal-code': '1000' }, trigger: 'submit' })
    h.controller.onNavigated({ mainFrame: true, inPage: false })
    const offer = h.presenter.shown.at(-1)
    expect(offer?.surface).toBe('save-address')
    await h.controller.respondOffer(offer?.id ?? '', 'save')
    expect(h.wallet.savedAddresses[0]).toMatchObject({ givenName: 'Sam de', familyName: 'Wit', line1: 'Dok 9' })
  })

  it('decides card and address offers', () => {
    const submitted = cardFromValues({ 'cc-number': '4242424242424242', 'cc-exp-month': '07', 'cc-exp-year': '2029' })
    expect(submitted).toEqual({ number: '4242424242424242', holder: '', expMonth: 7, expYear: 2029 })
    expect(cardFromValues({ 'cc-number': '4242424242424241', 'cc-exp': '07/29' })).toBeNull()
    const base = { settings: { cards: true }, agentControlled: false, secure: true, certificateException: false, card: submitted, saved: [], offerAllowed: true }
    expect(decideCardOffer(base)).toBe(true)
    expect(decideCardOffer({ ...base, secure: false })).toBe(false)
    expect(decideCardOffer({ ...base, certificateException: true })).toBe(false)
    expect(decideCardOffer({ ...base, offerAllowed: false })).toBe(false)
    expect(decideCardOffer({ ...base, agentControlled: true })).toBe(false)
    expect(decideCardOffer({ ...base, saved: [card] })).toBe(false)
    expect(maskedNumber('4242 4242 4242 4242')).toBe('•••• 4242')
    expect(brandOf('5555555555554444')).toBe('mastercard')
    expect(brandOf('378282246310005')).toBe('amex')

    const partial = addressFromValues({ 'given-name': 'Robin', 'postal-code': '9000' })
    expect(addressComplete(partial)).toBe(false)
    expect(decideAddressOffer({ settings: { addresses: true }, agentControlled: false, address: partial, saved: [] })).toBe(false)
    const full = addressFromValues({ 'given-name': 'Robin', 'address-line1': 'Kade 1', 'address-level2': 'Gent', country: 'be' })
    expect(full.country).toBe('BE')
    expect(decideAddressOffer({ settings: { addresses: true }, agentControlled: false, address: full, saved: [] })).toBe(true)
    expect(decideAddressOffer({ settings: { addresses: true }, agentControlled: true, address: full, saved: [] })).toBe(false)
  })
})

describe('rows', () => {
  it('parses only Atelier row ids', () => {
    expect(parseRowId('l:abc')).toEqual({ kind: 'login', recordId: 'abc' })
    expect(parseRowId('c:1')).toEqual({ kind: 'card', recordId: '1' })
    expect(parseRowId('x:1')).toBeNull()
    expect(parseRowId('manage')).toBeNull()
  })

  it('generates strong passwords with every class and no look-alikes', () => {
    for (let i = 0; i < 20; i++) {
      const pw = generatePassword(20)
      expect(pw).toHaveLength(20)
      expect(pw).toMatch(/[a-z]/)
      expect(pw).toMatch(/[A-Z]/)
      expect(pw).toMatch(/[2-9]/)
      expect(pw).not.toMatch(/[lIO01]/)
    }
  })
})

describe('agent guarding (CH-18/ST-12)', () => {
  afterEach(() => setAgentGuardHooks(null))

  it('refuses in plain words, the same in every approval mode', () => {
    expect(guardRefusal('password')).toMatch(/a password.*any approval mode/)
    expect(guardRefusal('card', 'target')).toMatch(/^That field holds card details/)
    expect(guardRefusal('otp')).toContain('a one-time code')
  })

  it('reads the focused guard from any frame through the controller', async () => {
    const h = harness()
    const pay = new FakeFrame('pay', 'https://pay.example', 'https://pay.example/card', false, h.top)
    h.frames.push(pay)
    h.top.onSend = (c) => {
      if (c.type === 'report-guarded') queueMicrotask(() => h.controller.onReport(h.top, { type: 'guarded', rects: [], focused: null }))
    }
    pay.onSend = (c) => {
      if (c.type === 'report-guarded') queueMicrotask(() => h.controller.onReport(pay, { type: 'guarded', rects: [{ x: 0, y: 0, width: 100, height: 30 }], focused: 'cvc' }))
      if (c.type === 'probe-parent') queueMicrotask(() => h.controller.onReport(h.top, { type: 'probe', nonce: c.nonce, childRect: { x: 50, y: 400, width: 300, height: 100 } }))
    }
    expect(await h.controller.focusedGuard()).toBe('cvc')
    const area = await h.controller.guardedRects()
    expect(area).toEqual({ rects: [{ x: 50, y: 400, width: 100, height: 30 }], unresolved: false })

    setAgentGuardHooks({
      focusedGuard: () => h.controller.focusedGuard(),
      mask: (_id, image) => Promise.resolve(image),
      guardedRects: async () => (await h.controller.guardedRects()).rects,
    })
    expect(await agentFocusedGuard('t1')).toBe('cvc')
    expect(await agentGuardedAt('t1', { x: 60, y: 410 })).toBe(true)
    expect(await agentGuardedAt('t1', { x: 10, y: 10 })).toBe(false)
  })

  it('marks the whole capture unresolved when a frame with guarded fields cannot be placed', async () => {
    const h = harness()
    const lost = new FakeFrame('lost', 'https://pay.example', 'https://pay.example/card', false, h.top)
    h.frames.splice(0, 1, lost)
    lost.onSend = (c) => {
      if (c.type === 'report-guarded') queueMicrotask(() => h.controller.onReport(lost, { type: 'guarded', rects: [{ x: 0, y: 0, width: 10, height: 10 }] }))
    }
    expect(await h.controller.guardedRects()).toEqual({ rects: [], unresolved: true })
  })

  it('passes captures through and knows no guard before autofill starts', async () => {
    const image = { marker: true } as unknown as Electron.NativeImage
    expect(await maskForAgent('t1', image)).toBe(image)
    expect(await agentFocusedGuard('t1')).toBeNull()
    expect(await agentGuardedAt('t1', { x: 0, y: 0 })).toBe(false)
  })

})
