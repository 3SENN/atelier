/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { BrowserStepsCard, StepPageItem } from '../src/shared/browserSteps'
import type { StepAnswer } from '../src/main/decisions/device/step'
import type { StepInput } from '../src/main/decisions/device/stepFormat'
import { createBrowserStepsTool, offPath, optionFor, type StepModel } from '../src/main/agent/tools/browserSteps'
import type { ClientToolContext } from '../src/main/agent/tools/registry'
import type { ChatBrowser } from '../src/main/agent/session'

// browser_steps (docs/decisions.md › Browser tasks): atelier-step's answers turned into the chat's own browser steps,
// and every way it hands the task back.

type Page = { title: string; url: string; items: StepPageItem[] }

function answer(n: number, a: Partial<{ op: Partial<StepAnswer['op']>; click: Record<number, number>; type: Record<number, number>; values: Record<number, number[]> }>): StepAnswer {
  const fill = (m: Record<number, number> | undefined): Array<number | null> => Array.from({ length: n }, (_, i) => m?.[i] ?? null)
  return {
    op: { click: 0, type: 0, done: 0, blocked: 0, ...a.op },
    click: fill(a.click),
    type: fill(a.type),
    values: Array.from({ length: n }, (_, i) => a.values?.[i] ?? null),
    tokens: 100,
    ms: 80,
  }
}

function harness(pages: Page[], answers: Array<(page: Page) => StepAnswer>, onStep?: (name: string, input: { target: { ref: string }; value?: unknown }, state: { page: number }) => void) {
  const state = { page: 0 }
  const steps: Array<{ name: string; ref: string; value?: unknown }> = []
  const inputs: StepInput[] = []
  const events: BrowserStepsCard[] = []
  let call = 0
  const browser: Pick<ChatBrowser, 'step' | 'page'> = {
    page: async () => {
      const p = pages[Math.min(state.page, pages.length - 1)]!
      return { tabId: 't1', title: p.title, url: p.url, page: { items: p.items.map((i) => ({ ...i })), truncated: false } }
    },
    step: async (name, raw) => {
      const input = raw as { target: { ref: string }; value?: unknown }
      steps.push({ name, ref: input.target.ref, ...(input.value !== undefined ? { value: input.value } : {}) })
      const p = pages[state.page]!
      const item = p.items.find((i) => i.ref === input.target.ref)
      if (name === 'form_input' && item) item.value = String(input.value)
      onStep?.(name, input, state)
      return [{ type: 'text', text: 'ok' }]
    },
  }
  const model: StepModel = {
    stepAvailable: () => true,
    step: async (input) => {
      inputs.push(input)
      const page = pages[Math.min(state.page, pages.length - 1)]!
      const next = answers[Math.min(call++, answers.length - 1)]!
      return next(page)
    },
  }
  const tool = createBrowserStepsTool({ browser: () => browser, steps: () => model, sleep: async () => undefined })
  const ctx: ClientToolContext = {
    chatId: 'c1',
    companionId: 'co',
    isPrivate: false,
    isRoutine: false,
    signal: new AbortController().signal,
    emit: (e) => events.push(e as BrowserStepsCard),
    ask: async () => {
      throw new Error('no asks here')
    },
  }
  const run = (input: unknown) => tool.run(tool.parse.parse(input), ctx)
  return { tool, run, steps, inputs, events, state }
}

const checkout = (): Page => ({
  title: 'Checkout',
  url: 'https://shop.test/checkout',
  items: [
    { ref: 'r1', role: 'field', label: 'Search', value: '', group: 'header-1' },
    { ref: '', role: 'text', label: 'Your details', group: '' },
    { ref: 'r2', role: 'field', label: 'Full name', value: '', group: 'form-2' },
    { ref: 'r3', role: 'field', label: 'Postcode', value: '', group: 'form-2' },
    { ref: 'r4', role: 'select', label: 'Country', value: '', options: ['Belgium', 'Netherlands'], group: 'form-2' },
    { ref: 'r5', role: 'field', label: 'Card number', value: '', group: 'form-2', guarded: true },
    { ref: 'r6', role: 'button', label: 'Continue to payment', group: 'form-2' },
  ],
})
const form = checkout()
const payment: Page = { title: 'Payment', url: 'https://shop.test/pay', items: [{ ref: 'p1', role: 'text', label: 'Pay €89.00', group: '' }, { ref: 'p2', role: 'button', label: 'Pay now', group: 'main-1' }] }
const values = [
  { name: 'name', value: 'Robin Vos' },
  { name: 'postcode', value: '3512 AB' },
  { name: 'country', value: 'Netherlands' },
]

describe('browser_steps', () => {
  it('fills only the form’s own empty fields, clicks on, and ends at done for the companion to check', async () => {
    const h = harness(
      [checkout(), payment],
      [
        // Type: Full name first; the search box (another region) and the card field (guarded) are never filled.
        () => answer(7, { op: { type: 0.9 }, type: { 2: 0.8, 3: 0.1, 0: 0.1 }, values: { 0: [0.1, 0.1, 0.7, 0.1], 2: [0, 0.9, 0.05, 0.05], 3: [0, 0.05, 0.9, 0.05], 4: [0, 0.05, 0.05, 0.9], 5: [0, 0.05, 0.9, 0.05] } }),
        () => answer(7, { op: { click: 0.9 }, click: { 6: 0.95 } }),
        () => answer(2, { op: { done: 0.95 } }),
      ],
      (name, input, state) => {
        if (name === 'left_click' && input.target.ref === 'r6') state.page = 1
      },
    )
    const out = await h.run({ goal: 'Fill in the checkout and stop on the payment page', values })
    expect(h.steps).toEqual([
      { name: 'form_input', ref: 'r2', value: 'Robin Vos' },
      { name: 'form_input', ref: 'r3', value: '3512 AB' },
      { name: 'form_input', ref: 'r4', value: 'Netherlands' },
      { name: 'left_click', ref: 'r6' },
    ])
    expect(out.isError).toBeFalsy()
    expect(out.content).toMatch(/atelier-step took 4 steps/)
    expect(out.content).toMatch(/Check it yourself/)
    expect(h.events.at(-1)).toMatchObject({ status: 'done', goal: 'Fill in the checkout and stop on the payment page' })
    expect(h.events.at(-1)?.steps).toHaveLength(4)
    // What was done goes into the next step's input, as in training.
    expect(h.inputs[1]?.before).toEqual(['typed into Full name', 'typed into Postcode', 'typed into Country'])
    expect(h.inputs[0]?.page).toBe('Checkout (/checkout)')
  })

  it('hands back when it isn’t sure, and names why', async () => {
    const h = harness([form], [() => answer(7, { op: { click: 0.4, type: 0.35 } })])
    const out = await h.run({ goal: 'Do the thing', values })
    expect(h.steps).toEqual([])
    expect(out.content).toMatch(/Handed back to you: atelier-step isn't sure what to do next/)
    expect(h.events.at(-1)?.status).toBe('handed-back')
  })

  it('hands back when the person declines a click, without trying another way', async () => {
    const h = harness([form], [() => answer(7, { op: { click: 0.9 }, click: { 6: 0.95 } })])
    const browser = h.tool
    expect(browser).toBeTruthy()
    const declining = createBrowserStepsTool({
      browser: () => ({
        page: async () => ({ tabId: 't1', title: form.title, url: form.url, page: { items: form.items, truncated: false } }),
        step: async () => {
          throw new Error('The user declined the action (payment). Do not attempt it another way; ask the user how to proceed.')
        },
      }),
      steps: () => ({ stepAvailable: () => true, step: async () => answer(7, { op: { click: 0.9 }, click: { 6: 0.95 } }) }),
      sleep: async () => undefined,
    })
    const events: BrowserStepsCard[] = []
    const out = await declining.run(declining.parse.parse({ goal: 'Pay', values: [] }), {
      chatId: 'c1', companionId: 'co', isPrivate: false, isRoutine: false, signal: new AbortController().signal, emit: (e) => events.push(e as BrowserStepsCard), ask: async () => ({}) as never,
    })
    expect(out.content).toMatch(/the person declined clicking “Continue to payment”; don't try it another way/)
    expect(events.at(-1)?.status).toBe('handed-back')
  })

  it('asks the companion before a second add to the cart, and stops going in circles', async () => {
    const product: Page = { title: 'Tent', url: 'https://shop.test/tent', items: [{ ref: 'a1', role: 'button', label: 'Add to cart', group: 'main-1' }, { ref: 'a2', role: 'link', label: 'Home', group: 'nav-1' }] }
    const h = harness([product], [() => answer(2, { op: { click: 0.9 }, click: { 0: 0.9, 1: 0.1 } })], (_name, _input, state) => {
      // The page changes a little each time, so it isn't read as stuck.
      product.items[1]!.label = `Home ${state.page++}`
    })
    const out = await h.run({ goal: 'Add the tent to the cart' })
    expect(h.steps).toHaveLength(1)
    expect(out.content).toMatch(/second item to the cart/)

    const loop: Page = { title: 'List', url: 'https://shop.test/list', items: [{ ref: 'l1', role: 'link', label: 'Next', group: 'main-1' }, { ref: '', role: 'text', label: 'Page 1', group: '' }] }
    let page = 1
    const h2 = harness([loop], [() => answer(2, { op: { click: 0.9 }, click: { 0: 0.95 } })], () => {
      loop.items[1]!.label = `Page ${++page}`
    })
    const out2 = await h2.run({ goal: 'Find the tent' })
    expect(h2.steps.length).toBe(1)
    expect(out2.content).toMatch(/going in circles/)
  })

  it('hands back when a value it was given fits no field, or a page stops changing', async () => {
    const h = harness([checkout()], [() => answer(7, { op: { type: 0.9 }, type: { 2: 0.9 }, values: { 2: [0.9, 0.05, 0.03, 0.02] } })])
    const out = await h.run({ goal: 'Fill it in', values })
    expect(out.content).toMatch(/none of the values it was given fits “Full name”/)

    const still: Page = { title: 'Still', url: 'https://shop.test/still', items: [{ ref: 's1', role: 'button', label: 'Go', group: 'main-1' }, { ref: 's2', role: 'button', label: 'Other', group: 'main-1' }] }
    let i = 0
    const h2 = harness([still], [() => answer(2, { op: { click: 0.9 }, click: { [i++ % 2]: 0.95 } })])
    const out2 = await h2.run({ goal: 'Go on' })
    expect(out2.content).toMatch(/stopped changing|going in circles/)
  })

  it('reports blocked pages, a missing model, and turns itself off where it can’t run', async () => {
    const h = harness([form], [() => answer(7, { op: { blocked: 0.9 } })])
    const out = await h.run({ goal: 'Sign in' })
    expect(out.content).toMatch(/can’t go further from this page/)
    expect(h.events.at(-1)?.status).toBe('blocked')

    const missing = createBrowserStepsTool({ browser: () => null, steps: () => null })
    const setup = { companionId: 'co', browser: true, memory: true, routine: false, private: false, flags: {}, workspace: { folders: false, tables: false, apps: false, calendar: false, activity: false } }
    expect(missing.enabled(setup)).toBe(false)
    expect(h.tool.enabled(setup)).toBe(true)
    expect(h.tool.enabled({ ...setup, routine: true })).toBe(false)
    expect(h.tool.enabled({ ...setup, browser: false })).toBe(false)
    const notInstalled = createBrowserStepsTool({ browser: () => ({ page: async () => ({ tabId: 't', title: '', url: '', page: null }), step: async () => [] }), steps: () => ({ stepAvailable: () => false, step: async () => answer(0, {}) }) })
    const res = await notInstalled.run(notInstalled.parse.parse({ goal: 'Order it' }), { chatId: 'c', companionId: 'co', isPrivate: false, isRoutine: false, signal: new AbortController().signal, emit: () => undefined, ask: async () => ({}) as never })
    expect(res.isError).toBeFalsy()
    expect(res.content).toMatch(/not installed/)
  })

  it('hands a delete click the goal doesn’t ask for back to the companion, in any language, and takes it when asked', async () => {
    const cart = (): Page => ({ title: 'Cart', url: 'https://shop.test/cart', items: [{ ref: 'c1', role: 'button', label: 'Remove', group: 'main-1' }, { ref: 'c2', role: 'link', label: 'Checkout', group: 'main-1' }] })
    const h = harness([cart()], [() => answer(2, { op: { click: 0.9 }, click: { 0: 0.9, 1: 0.1 } })])
    const out = await h.run({ goal: 'Go to checkout and fill in the delivery details' })
    expect(h.steps).toEqual([])
    expect(out.content).toMatch(/reached for “Remove” \(a delete click the goal doesn’t ask for\)/)
    const nl: Page = { title: 'Winkelwagen', url: 'https://shop.test/wagen', items: [{ ref: 'n1', role: 'button', label: 'Verwijderen', group: 'main-1' }, { ref: 'n2', role: 'link', label: 'Afrekenen', group: 'main-1' }] }
    const h2 = harness([nl], [() => answer(2, { op: { click: 0.9 }, click: { 0: 0.9, 1: 0.1 } })])
    expect((await h2.run({ goal: 'Ga naar afrekenen' })).content).toMatch(/reached for “Verwijderen”/)
    const h3 = harness([cart()], [() => answer(2, { op: { click: 0.9 }, click: { 0: 0.9, 1: 0.1 } }), () => answer(2, { op: { done: 0.9 } })])
    await h3.run({ goal: 'Remove the tent from the cart' })
    expect(h3.steps).toEqual([{ name: 'left_click', ref: 'c1' }])
  })

  it('matches options by whole words, never by a few letters inside a word', () => {
    const sizes = ['Small', 'Medium', 'Large']
    expect(optionFor(sizes, 'M')).toBeNull()
    expect(optionFor(sizes, 'medium')).toBe('Medium')
    expect(optionFor(['EU 42', 'EU 43', 'EU 44'], '43')).toBe('EU 43')
    expect(optionFor(['Netherlands', 'Belgium'], 'The Netherlands')).toBe('Netherlands')
    expect(optionFor(['4', '43', '430'], '43')).toBe('43')
    expect(optionFor(['Afval niet opgehaald', 'Losliggende stoeptegel'], 'our green bin was not emptied')).toBeNull()
  })

  it('leaves consequential clicks to the companion unless the goal asks for them, and paying always', () => {
    expect(offPath('Pay now', 'Pay for the order')).toBe('payment')
    expect(offPath('Betalen', 'Bestel het en betaal')).toBe('payment')
    expect(offPath('Checkout', 'Add the tent to the cart and open the cart')).toBe('purchase')
    expect(offPath('Checkout', 'Open the cart and go to checkout')).toBeNull()
    expect(offPath('Send', 'Fill in the form, stop before sending')).toBe('message')
    expect(offPath('Sign up', 'Get through the sign-up')).toBeNull()
    expect(offPath('Register', 'Finish the registration form')).toBeNull()
    expect(offPath('Register', 'Find the opening hours')).toBe('account')
    expect(offPath('Accept all', 'Find the opening hours')).toBeNull()
    expect(offPath('Add to cart', 'Find a tent')).toBeNull()
  })

  it('isn’t sure of a field when the model’s weight is on one it may not fill', async () => {
    const login: Page = {
      title: 'Sign in',
      url: 'https://shop.test/login',
      items: [
        { ref: 's1', role: 'field', label: 'Search', value: '', group: 'header-1' },
        { ref: 's2', role: 'field', label: 'Password', value: '', group: 'form-2', guarded: true },
      ],
    }
    const h = harness([login], [() => answer(2, { op: { type: 0.9 }, type: { 0: 0.03, 1: 0.97 }, values: { 0: [0.05, 0.95] } })])
    const out = await h.run({ goal: 'Sign in', values: [{ name: 'search', value: 'tent' }] })
    expect(h.steps).toEqual([])
    expect(out.content).toMatch(/isn’t sure which field/)
  })

  it('keeps context only where training had it: repeated labels and prices', async () => {
    const list: Page = {
      title: 'Orders',
      url: 'https://shop.test/orders',
      items: [
        { ref: 'o1', role: 'link', label: 'View order', context: '#1043 · placed 14 Oct · View order', group: 'main-1' },
        { ref: 'o2', role: 'link', label: 'View order', context: '#1044 · placed 2 Nov · View order', group: 'main-1' },
        { ref: 'o3', role: 'link', label: 'Trailhut 2', context: 'Trailhut 2 €189.00', group: 'main-1' },
        { ref: 'o4', role: 'link', label: 'Help', context: 'Help Contact', group: 'footer-1' },
      ],
    }
    const h = harness([list], [() => answer(4, { op: { done: 0.9 } })])
    await h.run({ goal: 'Open the order from 2 November' })
    expect(h.inputs[0]?.elements.map((e) => ('context' in e ? (e.context ?? null) : null))).toEqual(['#1043 · placed 14 Oct · View order', '#1044 · placed 2 Nov · View order', 'Trailhut 2 €189.00', null])
  })
})
