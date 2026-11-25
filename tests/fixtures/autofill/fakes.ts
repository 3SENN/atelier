import type { AutofillSettings, MainCommand } from '@shared/autofill'
import type { Bounds } from '@shared/ipc'
import type { AddressInput, AddressView, CardView, CredentialView } from '@shared/passwords'
import type { ToastSpec } from '@shared/dialogs'
import type { Authenticator, AppNotice, VaultApi, Wallet } from '../../../src/main/features/personalRuntime'
import { AutofillController, type ControllerDeps, type PopupRegistry, type TabPort } from '../../../src/main/autofill/controller'
import type { FrameHandle } from '../../../src/main/autofill/frames'
import type { Presenter, SurfaceHandle } from '../../../src/main/autofill/presenter'
import type { AutofillSurfaceId } from '@shared/overlay/autofill'
import type { OverlayResult } from '@shared/overlay'

// Atelier-written fakes for the autofill tests: frames, a tab, the vault,
// the wallet, the authenticator and a presenter that records surfaces.

export class FakeFrame implements FrameHandle {
  readonly sent: MainCommand[] = []
  live = true
  onSend: ((command: MainCommand) => void) | null = null
  constructor(
    readonly token: string,
    readonly origin: string,
    readonly url: string,
    readonly isMain: boolean,
    private readonly up: FakeFrame | null = null,
  ) {}
  parent(): FrameHandle | null {
    return this.up
  }
  alive(): boolean {
    return this.live
  }
  send(command: MainCommand): void {
    this.sent.push(command)
    this.onSend?.(command)
  }
  last<T extends MainCommand['type']>(type: T): Extract<MainCommand, { type: T }> | undefined {
    return [...this.sent].reverse().find((c): c is Extract<MainCommand, { type: T }> => c.type === type)
  }
}

export interface Shown {
  surface: AutofillSurfaceId
  rect: Bounds
  props: Record<string, unknown>
  id: string
  closed: boolean
  updates: unknown[]
  settle(result: OverlayResult | null): void
}

export function recordingPresenter(): Presenter & { shown: Shown[]; open: Presenter['open'] } {
  const shown: Shown[] = []
  return {
    shown,
    open(surface, rect, props, id): SurfaceHandle {
      let settle: (r: OverlayResult | null) => void = () => undefined
      const done = new Promise<OverlayResult | null>((resolve) => {
        settle = resolve
      })
      const entry: Shown = { surface, rect, props: props as unknown as Record<string, unknown>, id, closed: false, updates: [], settle: (r) => settle(r) }
      shown.push(entry)
      return {
        id,
        update: (next) => entry.updates.push(next),
        close: () => {
          entry.closed = true
          settle(null)
        },
        done,
      }
    },
  }
}

export const DEFAULT_SETTINGS: AutofillSettings = {
  offerLogins: true,
  offerSave: true,
  offerGenerated: true,
  addresses: true,
  addressAuth: true,
  cards: true,
  cardAuth: true,
  importHintDismissed: true,
  passwordsImported: false,
  yieldToPasswordExtension: true,
}

export function cred(id: string, origin: string, username: string, updatedAt = 1_700_000_000_000): CredentialView {
  return { id, origin, username, updatedAt, createdAt: updatedAt, lastUsedAt: null } as unknown as CredentialView
}

export class FakeVault {
  creds: CredentialView[] = []
  passwords = new Map<string, string>()
  never = new Set<string>()
  used: string[] = []
  saved: Array<{ url: string; username: string; password: string }> = []
  updated: Array<{ id: string; password?: string }> = []
  add(c: CredentialView, password: string): void {
    this.creds.push(c)
    this.passwords.set(c.id, password)
  }
  api(): VaultApi {
    const originOf = (url: string): string => new URL(url).origin
    return {
      list: () => this.creds,
      forUrl: (url) => this.creds.filter((c) => (c as unknown as { origin: string }).origin === originOf(url)),
      decide: (url, username, password) => {
        const found = this.creds.find((c) => (c as unknown as { origin: string }).origin === originOf(url) && c.username === username)
        if (!found) return { kind: 'new' }
        return this.passwords.get(found.id) === password ? { kind: 'same', id: found.id } : { kind: 'update', id: found.id }
      },
      save: (url, username, password) => {
        this.saved.push({ url, username, password })
        return cred(`n${this.saved.length}`, originOf(url), username)
      },
      reveal: (id) => this.passwords.get(id) ?? '',
      markUsed: (id) => {
        this.used.push(id)
      },
      update: (id, patch) => {
        this.updated.push({ id, password: patch.password })
        return this.creds.find((c) => c.id === id) as CredentialView
      },
      remove: () => undefined,
      neverSave: (origin) => {
        this.never.add(origin)
      },
      isNeverSave: (origin) => this.never.has(origin),
      allowAgain: (origin) => {
        this.never.delete(origin)
      },
      neverSaveList: () => [...this.never],
      wipe: () => undefined,
      count: () => this.creds.length,
    }
  }
}

export class FakeWallet {
  cardList: CardView[] = []
  addressList: AddressView[] = []
  strikes = new Map<string, number>()
  savedCards: unknown[] = []
  savedAddresses: AddressInput[] = []
  api(): Wallet {
    return {
      addresses: () => this.addressList,
      addressForFill: (id) => ({ ...(this.addressList.find((a) => a.id === id) as AddressView) }) as never,
      saveAddress: (a) => {
        this.savedAddresses.push(a)
        return { ...a, id: 'a-new' } as unknown as AddressView
      },
      removeAddress: () => undefined,
      mine: () => this.addressList.find((a) => a.mine) ?? null,
      setMine: () => undefined,
      cards: () => this.cardList,
      cardForFill: () => ({ number: '4242424242424242', holder: 'Robin Vos', expMonth: 7, expYear: 2029 }),
      saveCard: (c) => {
        this.savedCards.push(c)
        return { id: 'c-new' } as unknown as CardView
      },
      removeCard: () => undefined,
      fingerprint: (n) => `fp:${n.slice(-4)}`,
      offerAllowed: (fp, site) => (this.strikes.get(`${fp}@${site}`) ?? 0) < 3,
      strike: (fp, site) => {
        const key = `${fp}@${site}`
        this.strikes.set(key, (this.strikes.get(key) ?? 0) + 1)
      },
      wipe: () => undefined,
    }
  }
}

export interface Harness {
  controller: AutofillController
  top: FakeFrame
  tab: TabPort & { controlled: boolean; url_: string; modal: boolean; inView: boolean; certException: boolean }
  vault: FakeVault
  wallet: FakeWallet
  presenter: ReturnType<typeof recordingPresenter>
  settings: AutofillSettings
  notices: AppNotice[]
  toasts: ToastSpec[]
  opened: string[]
  authAnswers: Array<'ok' | 'cancelled' | 'unavailable'>
  authReasons: string[]
  clock: { now: number }
  frames: FakeFrame[]
}

export function harness(url = 'https://shop.example/login', overrides: Partial<ControllerDeps> = {}): Harness {
  const origin = new URL(url).origin
  const top = new FakeFrame('top', origin, url, true)
  const frames: FakeFrame[] = [top]
  const vault = new FakeVault()
  const wallet = new FakeWallet()
  const presenter = recordingPresenter()
  const settings: AutofillSettings = { ...DEFAULT_SETTINGS }
  const notices: AppNotice[] = []
  const toasts: ToastSpec[] = []
  const opened: string[] = []
  const authAnswers: Array<'ok' | 'cancelled' | 'unavailable'> = []
  const authReasons: string[] = []
  const clock = { now: 1_800_000_000_000 }
  let n = 0
  const tab = {
    id: 't1',
    windowId: 1,
    controlled: false,
    url_: url,
    modal: false,
    inView: true,
    certException: false,
    url: () => tab.url_,
    agentControlled: () => tab.controlled,
    favicon: () => 'https://shop.example/favicon.ico',
    zoom: () => 1,
    chromeZoom: () => 1,
    viewport: () => ({ width: 1200, height: 800 }),
    certificateException: () => tab.certException,
    modalOpen: () => tab.modal,
    appInView: () => tab.inView,
    topFrame: () => top,
    frames: () => frames,
  }
  const registry: PopupRegistry = { popupOpened: () => undefined, popupClosed: () => undefined, offerOpened: () => undefined, offerClosed: () => undefined }
  const auth: Authenticator = {
    authenticate: (reason) => {
      authReasons.push(reason)
      return Promise.resolve(authAnswers.shift() ?? 'ok')
    },
  }
  const controller = new AutofillController({
    tab,
    vault: () => vault.api(),
    wallet: () => wallet.api(),
    auth: () => auth,
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    presenter,
    registry,
    notify: (x) => notices.push(x),
    toast: (x) => toasts.push(x),
    openUrl: (x) => opened.push(x),
    importHint: { shouldShow: () => !settings.importHintDismissed && !settings.passwordsImported, markShown: () => undefined },
    generatePassword: () => 'Gen-erated.Pass9',
    now: () => clock.now,
    ids: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    frameTimeoutMs: 20,
    ...overrides,
  })
  return { controller, top, tab, vault, wallet, presenter, settings, notices, toasts, opened, authAnswers, authReasons, clock, frames }
}

export const fieldRect: Bounds = { x: 100, y: 120, width: 260, height: 32 }

export function focus(kind: string, formRole: string, extra: Record<string, unknown> = {}): never {
  return {
    type: 'focus',
    fieldId: 'f1',
    kind,
    rect: fieldRect,
    formId: 'g1',
    filled: { username: false, password: false },
    typed: false,
    trusted: true,
    formRole,
    ...extra,
  } as never
}

/** Lets the controller's async focus handling settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
