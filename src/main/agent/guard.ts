/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ALWAYS_ASK, type ActionKind } from '@shared/agentTools'
import { clickKind } from '../decisions/uses' // DC-10
import type { ElementDescription } from '@shared/ipc'

// Executor-side check for consequential actions (purchases, messages,
// deletions, account changes), as the browser toolset's security guidance
// asks. Classification is by the target's accessible name, so it errs toward
// asking.

const CLICKABLE_ROLES = new Set(['button', 'link', 'clickable', 'menuitem', 'option', 'checkbox', 'switch', 'radio', 'tab'])

export type GuardedAction =
  | { kind: 'click'; element: ElementDescription | null }
  | { kind: 'enter'; element: ElementDescription | null }

/** Returns a description of why the action needs approval, or null. */
export function consequentialReason(action: GuardedAction): string | null {
  return guardAction(action)?.reason ?? null
}

// ST-12, CH-39: what kind of action it is, and whether it always asks
/** Why an action needs approval, what kind it is, and whether it asks in every mode with scope 'once' only. */
export interface GuardResult {
  reason: string
  action: ActionKind
  alwaysAsk: boolean
}

// Checked in order: the first kind whose words match the target's name wins.
const KIND_NAMES: ReadonlyArray<[ActionKind, RegExp]> = [
  ['security', words(['(?:change|reset|update|set|remove) (?:your |my |the )?password', 'two[- ]factor', '2fa', 'two[- ]step', 'authenticator', 'passkey', 'security (?:key|settings?|questions?)', 'recovery (?:codes?|email|phone|key)', 'sign out (?:of )?(?:all|every\\w*)', 'revoke (?:access|sessions?|tokens?)'])],
  ['payment', words(['pay', 'pay now', 'transfer', 'withdraw', 'send money'])],
  ['purchase', words(['buy', 'purchase', 'place (?:your )?order', 'check ?out', 'order now', 'complete (?:order|purchase)', 'subscribe', 'donate', 'book', 'reserve', 'upgrade', 'downgrade'])],
  ['account', words(['cancel (?:my |your )?(?:subscription|account|order|membership|plan)', 'sign up', 'create (?:an )?account', 'register', 'deactivate', 'close (?:my )?account', 'unsubscribe', 'delete (?:my |your )?account'])],
  ['delete', words(['delete', 'remove', 'discard'])],
  ['message', words(['send', 'reply'])],
  ['post', words(['post', 'publish', 'tweet'])],
  ['submit', words(['submit', 'confirm', 'agree', 'accept'])],
  ['other', words(['merge', 'deploy'])],
]

function words(patterns: string[]): RegExp {
  return new RegExp(patterns.map((p) => `\\b${p}\\b`).join('|'), 'i')
}

function kindOf(name: string): ActionKind | null {
  for (const [kind, pattern] of KIND_NAMES) if (pattern.test(name)) return kind
  return null
}

/** Whether a text (a control's label, a task's goal) has the words of a kind of action, by the same list as the guard. */
export function namesActionKind(text: string, kind: ActionKind): boolean {
  return KIND_NAMES.some(([k, pattern]) => k === kind && pattern.test(text))
}

function result(reason: string, action: ActionKind): GuardResult {
  return { reason, action, alwaysAsk: ALWAYS_ASK.has(action) }
}

/**
 * Classifies a click or an Enter press: why it needs approval, its kind
 * (purchase, message, delete…), and whether it always asks. Payment and
 * account-security actions always ask; password fields stay blocked outright.
 */
export function guardAction(action: GuardedAction): GuardResult | null {
  const el = action.element
  if (!el) return null
  if (action.kind === 'click') {
    const submitsPayment = el.formHasPaymentFields && (el.inputType === 'submit' || el.role === 'button')
    if (submitsPayment) return result(`submit a payment form (${quote(el.name || el.formSubmitName || 'submit')})`, 'payment')
    if (!CLICKABLE_ROLES.has(el.role)) return null
    const kind = kindOf(el.name)
    return kind ? result(`click ${el.role} ${quote(el.name)}`, kind) : null
  }
  // Enter in a textarea or contenteditable inserts a newline; it does not submit.
  if (!el.inForm || el.tag === 'textarea' || (el.role === 'textbox' && el.tag !== 'input')) return null
  if (el.formHasPaymentFields) return result('submit a payment form by pressing Enter', 'payment')
  const kind = el.formSubmitName ? kindOf(el.formSubmitName) : null
  return kind ? result(`submit the form (${quote(el.formSubmitName ?? '')}) by pressing Enter`, kind === 'other' ? 'submit' : kind) : null
}

/**
 * DC-10: guardAction, plus a decision model's second opinion when the English
 * keyword list found nothing (another language, an unusual label). It can
 * only add a stop, never take one away, so page text cannot talk its way past
 * the guard. Off, unsure or slow, it is exactly guardAction.
 */
export async function guardActionChecked(action: GuardedAction, page: { title: string; url: string }, isPrivate: boolean): Promise<GuardResult | null> {
  const found = guardAction(action)
  const el = action.element
  if (found || !el) return found
  let name: string
  if (action.kind === 'click') {
    if (!CLICKABLE_ROLES.has(el.role)) return null
    name = el.name
  } else {
    if (!el.inForm || el.tag === 'textarea' || (el.role === 'textbox' && el.tag !== 'input')) return null
    name = el.formSubmitName ?? ''
  }
  const kind = await clickKind({ name, role: el.role, page: page.title, url: page.url }, isPrivate)
  if (!kind) return null
  return result(action.kind === 'click' ? `click ${el.role} ${quote(name)}` : `submit the form (${quote(name)}) by pressing Enter`, kind)
}

function quote(text: string): string {
  return `"${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`
}
