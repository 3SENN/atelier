/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Bounds } from '@shared/ipc'
import type { AddressInput, AddressView, CardInput, CardView, CredentialView } from '@shared/passwords'
import type { MeetingRecorder } from '@shared/meetingCapture'
import type { MeetingResolver, MeetingStore, MeetingSummarizer } from '@shared/meetings'
import type { SpeechBroker } from '@shared/speech'
import type { QuickModel } from '../agent/quick'
import type { FloatManager } from '../float/manager'

// The voice, passwords and meetings part of the app context: the floats,
// QuickModel, notifications and getting-started signals, and `personal`, the runtime
// slots each of these feature modules fills in FEATURES order (speech,
// passwords, autofill, meetingsLibrary, meetingCapture, voice). Until a slot
// is filled it throws "Not available yet", so a feature can code against the
// interface before the feature that owns it has set it up.

/** The vault as other features use it. PasswordVault implements it. */
export interface VaultApi {
  list(): CredentialView[]
  forUrl(url: string): CredentialView[]
  decide(url: string, username: string, password: string): { kind: 'new' } | { kind: 'update'; id: string } | { kind: 'same'; id: string } | null
  save(url: string, username: string, password: string): CredentialView
  /** Main only; never over IPC, never logged. */
  reveal(id: string): string
  markUsed(id: string): void
  update(id: string, patch: { username?: string; password?: string }): CredentialView
  remove(id: string): void
  neverSave(origin: string): void
  isNeverSave(origin: string): boolean
  allowAgain(origin: string): void
  neverSaveList(): string[]
  wipe(): void
  count(): number
}

export type Address = AddressInput & { id: string }

/** The wallet. Card numbers stay in main; the CVC is never in any type. */
export interface Wallet {
  addresses(): AddressView[]
  addressForFill(id: string): Address
  saveAddress(a: AddressInput & { id?: string; mine?: boolean }): AddressView
  removeAddress(id: string): void
  /** Your own address (Settings › You), or null when none is marked as yours. */
  mine(): AddressView | null
  setMine(id: string | null): void
  cards(): CardView[]
  /** Main only, never over IPC. */
  cardForFill(id: string): { number: string; holder: string; expMonth: number; expYear: number }
  saveCard(c: CardInput): CardView
  removeCard(id: string): void
  /** An HMAC of the number, for offer strikes. */
  fingerprint(number: string): string
  offerAllowed(fingerprint: string, site: string): boolean
  /** Three strikes stop the offers for that card on that site. */
  strike(fingerprint: string, site: string): void
  wipe(): void
}

export interface Authenticator {
  /** Touch ID, then the helper's device-owner check, then (off macOS) an Atelier confirm dialog; 'ok' in smoke. */
  authenticate(reason: string): Promise<'ok' | 'cancelled' | 'unavailable'>
}

/** Guarded fields are painted over before any capture leaves main. */
export interface CaptureMasker {
  capture(tabId: string, opts?: { maxEdge?: number }): Promise<Electron.NativeImage>
  guardedRects(tabId: string): Promise<Bounds[]>
}

export interface PersonalRuntime {
  broker: SpeechBroker
  vault: VaultApi
  wallet: Wallet
  auth: Authenticator
  masker: CaptureMasker
  meetings: { store: MeetingStore; summarizer: MeetingSummarizer; resolver: MeetingResolver }
  recorder: MeetingRecorder
}

export interface AppNotice {
  category: 'meetings' | 'passwords'
  title: string
  body?: string
  /** An atelier:// address to open when the notification is clicked. */
  target?: string
}

/** Getting-started signals (ON-13); 'artifact-built' is the first artifact, 'web-searched' a new tab's first web search (NT-01). */
export type GettingStartedSignal = 'transcription-ready' | 'meeting-transcribed' | 'artifact-built' | 'web-searched'

/** The fields this part adds to AppContext. */
export interface PersonalAppContext {
  float: FloatManager
  quick: QuickModel
  notify(n: AppNotice): void
  signal(id: GettingStartedSignal): void
  /** ATELIER_SMOKE: fake helper, Authenticator 'ok', no globalShortcut, short meeting-card delay. */
  smoke: boolean
  personal: PersonalRuntime
}

/** A stand-in whose every method throws "Not available yet: <what>.<method>". */
export function notAvailableYet<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      return () => {
        throw new Error(`Not available yet: ${what}.${String(prop)}`)
      }
    },
  })
}

/** Runtime slots before the feature modules fill them. */
export function emptyPersonalRuntime(): PersonalRuntime {
  return {
    broker: notAvailableYet<SpeechBroker>('speech broker'),
    vault: notAvailableYet<VaultApi>('password vault'),
    wallet: notAvailableYet<Wallet>('wallet'),
    auth: notAvailableYet<Authenticator>('authenticator'),
    masker: notAvailableYet<CaptureMasker>('capture masker'),
    meetings: {
      store: notAvailableYet<MeetingStore>('meeting store'),
      summarizer: notAvailableYet<MeetingSummarizer>('meeting summarizer'),
      resolver: notAvailableYet<MeetingResolver>('meeting resolver'),
    },
    recorder: notAvailableYet<MeetingRecorder>('meeting recorder'),
  }
}

export interface PersonalContextDeps {
  float: FloatManager
  quick: QuickModel
  /** The app's notifications.notify. */
  notify(n: { category: AppNotice['category']; title: string; body?: string; target: { url?: string } }): void
  /** The getting-started automatic items. */
  onSignal(id: GettingStartedSignal): void
  smoke: boolean
}

/** These fields of AppContext; `personal` starts empty and the feature modules fill it. */
export function createPersonalContext(deps: PersonalContextDeps): PersonalAppContext {
  const fired = new Set<GettingStartedSignal>()
  return {
    float: deps.float,
    quick: deps.quick,
    notify: (n) => deps.notify({ category: n.category, title: n.title, body: n.body, target: n.target ? { url: n.target } : {} }),
    // Each signal fires once per launch; the getting-started store keeps it for good.
    signal: (id) => {
      if (fired.has(id)) return
      fired.add(id)
      deps.onSignal(id)
    },
    smoke: deps.smoke,
    personal: emptyPersonalRuntime(),
  }
}
