/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type {
  BetaBrowserStateBlockParam,
  BetaBrowserStateChange,
  BetaImageBlockParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { WebContents } from 'electron'
import { z } from 'zod'
import type { ElementDescription, FormInputResult, ResolvedElement } from '@shared/ipc'
import type { StepPage } from '@shared/browserSteps'
import { isAppRunUrl, isBlankUrl, originOf, parseAgentNavigation, parseInternalUrl } from '@shared/url'
import { isArtifactUrl } from '@shared/files'
import { isExtensionUrl } from '@shared/extensions'
import {
  click, insertText, keyDown, keyUp, mouseDown, mouseMove, mouseUp, parseKeyCombo, parseKeySequence, parseModifiers, pressKey, scroll,
  type MouseButton, type Point,
} from '../input'
import type { PageBridge } from '../pageBridge'
import type { Tab, TabManager } from '../tabs'
import { guardActionChecked, type GuardedAction, type GuardResult } from './guard' // GuardResult; DC-10: guardActionChecked
import { needsApproval } from './permissionMode' // CH-18
// Guarded fields are refused to the agent in every approval mode, and its screenshots are masked.
import { agentFocusedGuard, agentGuardedAt, editsField, guardOfDescription, guardRefusal, guardedRefusal, maskForAgent, redactGuarded, withGuard } from '../autofill/agentGuard'
import type { GuardKind } from '@shared/fields'
import { isMemberName, memberSchemas, type CoordinateTarget, type MemberInput, type MemberName, type Target } from './schemas'

export const TOOLSET = 'browser'
export const NOT_EXECUTED = 'Not executed: an earlier action in this turn failed.'
export const STOPPED = 'Not executed: the user stopped the agent.'

export type ResultBlock = BetaTextBlockParam | BetaImageBlockParam | BetaBrowserStateBlockParam

export interface ToolCall {
  id: string
  name: string
  toolset_name?: string | null
  input: unknown
}

export interface ToolHandler {
  execute(name: string, input: unknown, signal: AbortSignal): Promise<ResultBlock[] | string>
}

/** Browser toolset calls go to `browser`; plain client tools (memory) by name. */
export interface ToolHandlers {
  browser?: ToolHandler
  client?: Record<string, ToolHandler>
}

export interface ToolCallHooks {
  onStart?(call: ToolCall): void
  /** `content` is the call's result, for the trace's summary. */
  onFinish?(call: ToolCall, outcome: { ok: boolean; message?: string; content?: unknown }): void
  /** CH-16: checked before each call; once true, the rest are answered with `haltedWith` instead of run. */
  halted?(): boolean
  haltedWith?: string
}

/**
 * Runs one assistant turn's tool calls in order. Implements the toolset's
 * batch halt rule: after the first failure, every later call is answered
 * with NOT_EXECUTED. Every call gets exactly one result.
 */
export async function runToolCalls(
  calls: readonly ToolCall[],
  handlers: ToolHandlers,
  signal: AbortSignal,
  hooks: ToolCallHooks = {},
): Promise<BetaToolResultBlockParam[]> {
  const results: BetaToolResultBlockParam[] = []
  let failed = false
  for (const call of calls) {
    const isBrowser = call.toolset_name === TOOLSET
    const base = { type: 'tool_result' as const, tool_use_id: call.id, ...(isBrowser ? { toolset_name: TOOLSET } : {}) }
    const handler = isBrowser ? handlers.browser : call.toolset_name ? undefined : handlers.client?.[call.name]
    if (!handler) {
      results.push({ ...base, is_error: true, content: `Unknown tool "${call.name}".` })
      failed = true
      continue
    }
    if (signal.aborted) {
      results.push({ ...base, is_error: true, content: STOPPED })
      continue
    }
    if (hooks.halted?.()) {
      results.push({ ...base, is_error: true, content: hooks.haltedWith ?? STOPPED })
      continue
    }
    if (failed) {
      results.push({ ...base, is_error: true, content: NOT_EXECUTED })
      continue
    }
    hooks.onStart?.(call)
    try {
      const content = await handler.execute(call.name, call.input, signal)
      results.push({ ...base, content })
      hooks.onFinish?.(call, { ok: true, content })
    } catch (err) {
      const message = signal.aborted ? STOPPED : `Error: ${errorMessage(err)}`
      results.push({ ...base, is_error: true, content: message })
      failed = true
      hooks.onFinish?.(call, { ok: false, message })
    }
  }
  return results
}

/** A short, human-readable label for a tool call, shown in the agent panel. */
export function describeToolCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown, max = 48): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
    return s.length > max ? `${s.slice(0, max - 1)}…` : s
  }
  const target = (t: unknown): string => {
    const v = (t ?? {}) as Record<string, unknown>
    return v.type === 'ref' ? String(v.ref) : `(${String(v.x)}, ${String(v.y)})`
  }
  switch (name) {
    case 'navigate':
      return i.url === 'back' ? 'Go back' : i.url === 'forward' ? 'Go forward' : i.url === 'reload' ? 'Reload' : `Open ${str(i.url, 60)}`
    case 'screenshot': return 'Take a screenshot'
    case 'zoom': return 'Zoom into part of the page'
    case 'left_click': return `Click ${target(i.target)}`
    case 'right_click': return `Right-click ${target(i.target)}`
    case 'middle_click': return `Middle-click ${target(i.target)}`
    case 'double_click': return `Double-click ${target(i.target)}`
    case 'triple_click': return `Triple-click ${target(i.target)}`
    case 'hover': return `Hover over ${target(i.target)}`
    case 'mouse_move': return 'Move the pointer'
    case 'left_click_drag': return 'Drag'
    case 'left_mouse_down': return 'Press the mouse button'
    case 'left_mouse_up': return 'Release the mouse button'
    case 'scroll': return `Scroll ${str(i.scroll_direction)}`
    case 'scroll_to': return `Scroll to ${target(i.target)}`
    case 'type': return `Type "${str(i.text, 40)}"`
    case 'key': return `Press ${str(i.text)}`
    case 'hold_key': return `Hold ${str(i.text)}`
    case 'wait': return `Wait ${String(i.duration)}s`
    case 'read_page': return i.filter === 'interactive' ? 'Read interactive elements' : 'Read the page'
    case 'find': return `Find "${str(i.query, 40)}"`
    case 'get_page_text': return 'Read the page text'
    case 'form_input': return `Fill ${target(i.target)}`
    case 'new_tab': return 'Open a new tab'
    case 'list_tabs': return 'List tabs'
    case 'switch_tab': return `Switch to ${str(i.tab_id)}`
    case 'close_tab': return `Close ${str(i.tab_id)}`
    case 'memory': {
      const verbs: Record<string, string> = { view: 'Check memory', create: 'Save to memory', str_replace: 'Update memory', insert: 'Update memory', delete: 'Forget', rename: 'Reorganize memory' }
      const path = typeof i.path === 'string' ? i.path : typeof i.old_path === 'string' ? i.old_path : ''
      return `${verbs[String(i.command)] ?? 'Memory'} ${path.replace(/^\/memories\/?/, '') || ''}`.trim()
    }
    case 'web_search': return `Search the web for "${str(i.query, 40)}"`
    case 'web_fetch': return `Read ${str(i.url, 60)}`
    default: return name
  }
}

// ---- executor ----

const MAX_EDGE = 1456
const MAX_PIXELS = 1_150_000
const NAVIGATION_TIMEOUT_MS = 30_000

export interface ExecutorDeps {
  tabs: TabManager
  bridge: PageBridge
  confirmConsequentialActions: () => boolean
  requestApproval: (description: string, origin: string, signal: AbortSignal) => Promise<boolean>
  onTabTouched: (tabId: string) => void
  /** Download events since the last report, delivered in browser_state. */
  stateChanges?: { pending(): boolean; take(): BetaBrowserStateChange[] }
  // The session supplies them; without them the executor asks as before
  /** Before each member: refuses a blocked site, and asks before the first action on a site that asks. */
  gate?(member: string, url: string | null, label: string, signal: AbortSignal): Promise<void>
  /** Before an acting member: asks, counts down or lets it run (approval mode, guard, saved rules). Throws when declined. */
  approve?(request: { member: string; guard: GuardResult | null; url: string; label: string }, signal: AbortSignal): Promise<void>
  // PDF tabs are read from their bytes; see pdfTab.ts
  pdf?: () => import('./pdfTab').PdfTabReader | null
  /** DC-04: a private chat sends nothing to a decision model, even in a normal window. */
  isPrivate?: () => boolean
}

const CLICK_MEMBERS: ReadonlySet<string> = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'])
const ACTING: ReadonlySet<string> = new Set(['left_click_drag', 'left_mouse_down', 'left_mouse_up', 'hover', 'mouse_move', 'type', 'key', 'hold_key', 'form_input', 'navigate'])
const NO_PAGE: ReadonlySet<string> = new Set(['new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'wait'])

function clickMember(button: MouseButton, count: number): string {
  if (button === 'right') return 'right_click'
  if (button === 'middle') return 'middle_click'
  return count >= 3 ? 'triple_click' : count === 2 ? 'double_click' : 'left_click'
}

function pressesEnter(text: string): boolean {
  try {
    return parseKeySequence(text).some((s) => s.key === 'Enter' && s.modifiers.length === 0)
  } catch {
    return false
  }
}

interface Viewport {
  width: number
  height: number
  /** Screenshot pixels per DIP. Model coordinates are divided by this. */
  scale: number
}

interface TabState {
  key: string
  tabIds: Set<string>
}

/** Executes browser_toolset_20260801 member calls against Atelier tabs. */
export class BrowserToolExecutor implements ToolHandler {
  readonly #deps: ExecutorDeps
  /**
   * The agent's own tab, where calls that name none run: the one it last
   * opened or switched to, else the first it used. It never follows the
   * person to another tab, so the agent doesn't act on what they're using.
   */
  #currentId: string | null = null

  constructor(deps: ExecutorDeps) {
    this.#deps = deps
  }

  /** The agent's own tab while it is open; null before it has used one. */
  currentTab(): Tab | null {
    return this.#currentId ? (this.#deps.tabs.find(this.#currentId) ?? null) : null
  }

  async execute(name: string, rawInput: unknown, signal: AbortSignal): Promise<ResultBlock[]> {
    if (!isMemberName(name)) throw new Error(`${name} is not enabled in ${BRAND_NAME}.`)
    const parsed = memberSchemas[name].safeParse(rawInput)
    if (!parsed.success) throw new Error(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`)
    await this.#beforeStep(name, parsed.data, signal)
    return this.#dispatch(name, parsed.data, signal)
  }

  /**
   * Site rules for every member, then Ask for everything for acting members.
   * Clicks and Enter ask in #confirm instead, where the guard knows the target.
   */
  async #beforeStep(name: MemberName, input: unknown, signal: AbortSignal): Promise<void> {
    if (!this.#deps.gate && !this.#deps.approve) return
    const url = this.#stepUrl(name, input)
    const label = describeToolCall(name, input)
    await this.#deps.gate?.(name, url, label, signal)
    const askedLater = CLICK_MEMBERS.has(name) || (name === 'key' && pressesEnter((input as { text: string }).text))
    if (this.#deps.approve && url && ACTING.has(name) && !askedLater) await this.#deps.approve({ member: name, guard: null, url, label }, signal)
  }

  /** The page a member reads or acts on: a navigation's destination, otherwise its tab's address. */
  #stepUrl(name: MemberName, input: unknown): string | null {
    if (NO_PAGE.has(name)) return null
    const i = input as { url?: string; tab_id?: string | null }
    if (name === 'navigate' && typeof i.url === 'string') {
      const nav = parseAgentNavigation(i.url)
      if (nav.kind !== 'history') return nav.url
    }
    try {
      return this.#lookup(i.tab_id).view.webContents.getURL()
    } catch {
      return null
    }
  }

  #dispatch(name: MemberName, input: unknown, signal: AbortSignal): Promise<ResultBlock[]> {
    const as = <N extends MemberName>(_n: N): MemberInput<N> => input as MemberInput<N>
    switch (name) {
      case 'navigate': return this.#navigate(as('navigate'), signal)
      case 'screenshot': return this.#screenshot(as('screenshot'))
      case 'zoom': return this.#zoom(as('zoom'))
      case 'left_click': return this.#click(as('left_click'), 'left', 1, 'Clicked', signal)
      case 'right_click': return this.#click(as('right_click'), 'right', 1, 'Right-clicked', signal)
      case 'middle_click': return this.#click(as('middle_click'), 'middle', 1, 'Middle-clicked', signal)
      case 'double_click': return this.#click(as('double_click'), 'left', 2, 'Double-clicked', signal)
      case 'triple_click': return this.#click(as('triple_click'), 'left', 3, 'Triple-clicked', signal)
      case 'hover': return this.#hover(as('hover'))
      case 'mouse_move': return this.#hover(as('mouse_move'))
      case 'left_click_drag': return this.#drag(as('left_click_drag'), signal)
      case 'left_mouse_down': return this.#mouseButton(as('left_mouse_down'), 'down')
      case 'left_mouse_up': return this.#mouseButton(as('left_mouse_up'), 'up')
      case 'scroll': return this.#scroll(as('scroll'), signal)
      case 'scroll_to': return this.#scrollTo(as('scroll_to'))
      case 'type': return this.#type(as('type'), signal)
      case 'key': return this.#key(as('key'), signal)
      case 'hold_key': return this.#holdKey(as('hold_key'), signal)
      case 'wait': return this.#wait(as('wait'), signal)
      case 'read_page': return this.#readPage(as('read_page'))
      case 'find': return this.#find(as('find'))
      case 'get_page_text': return this.#pageText(as('get_page_text'))
      case 'form_input': return this.#formInput(as('form_input'))
      case 'new_tab': return this.#newTab()
      case 'list_tabs': return Promise.resolve([this.#browserState()])
      case 'switch_tab': return this.#switchTab(as('switch_tab'))
      case 'close_tab': return this.#closeTab(as('close_tab'))
    }
  }

  // ---- tabs and state ----

  #tab(tabId: string | null | undefined): Tab {
    const tab = this.#lookup(tabId)
    this.#deps.onTabTouched(tab.id)
    if (!this.currentTab()) this.#currentId = tab.id
    return tab
  }

  /** Looks a tab up without claiming it for this chat: the named one, else the agent's own, else the person's. */
  #lookup(tabId: string | null | undefined): Tab {
    const { tabs } = this.#deps
    const tab = tabId ? tabs.find(tabId) : (this.currentTab() ?? tabs.active())
    if (!tab) throw new Error(tabId ? `No tab with id ${tabId}. Use list_tabs to see open tabs.` : 'There is no active tab.')
    return tab
  }

  /**
   * Opens the tab a navigation that targeted an Atelier page runs in. The chrome
   * draws those tabs (often the chat the agent is answering in), so loading a
   * site there would replace the page under the user. While the person has
   * the chat open, it keeps its place beside the new tab in split view;
   * otherwise the tab opens in the background. Either way the person can
   * leave: the agent keeps working in its tab without bringing it back.
   */
  #openBeside(source: Tab): Tab {
    const { tabs } = this.#deps
    const chatOpen = parseInternalUrl(source.internalUrl ?? '')?.page === 'chat' && tabs.paneBounds(source.id) !== null
    const splitFree = chatOpen && !tabs.split()
    const tab = tabs.create('about:blank', { activate: false, afterId: source.id })
    if (splitFree) tabs.openSplitWith(source.id, tab.id)
    this.#deps.onTabTouched(tab.id)
    this.#currentId = tab.id
    return tab
  }

  /**
   * Pointer, keyboard and capture actions need a page that is painting: input
   * sent before the first frame is dropped, and capture fails. The agent's tab
   * paints whether or not it is showing (TabManager keeps it rendering out of
   * sight), so it is never brought forward and the person keeps their tab.
   */
  async #visibleTab(tabId: string | null | undefined): Promise<Tab> {
    const tab = this.#tab(tabId)
    if (isBlank(tab)) throw new Error(BLANK)
    // Reader view or a site warning is drawn over the page instead of it.
    if (this.#deps.tabs.isChromeDrawn(tab)) throw new Error(COVERED)
    // No webContents.focus(): it can pull the window to the front and steal
    // focus from the user's other apps. CDP focus emulation covers it.
    const wc = tab.view.webContents
    try {
      await this.#deps.bridge.request(wc, { op: 'frame' }, 5_000)
    } catch {
      throw new Error('The page is not rendering yet. Wait a moment and try again.')
    }
    return tab
  }

  #browserState(tabChanges: BetaBrowserStateChange[] = []): BetaBrowserStateBlockParam {
    const { tabs } = this.#deps
    const changes = [...tabChanges, ...(this.#deps.stateChanges?.take() ?? [])].slice(0, 200)
    // "active" is the tab calls without a tab_id act on: the agent's own, which needn't be the one showing.
    const activeId = this.currentTab()?.id ?? tabs.activeId()
    const entries = tabs.all().slice(0, 100).map((tab) => {
      const info = tabs.info(tab)
      return {
        tab_id: tab.id,
        title: clip(info.title),
        url: clip(info.url || 'about:blank'),
        ...(tab.id === activeId ? { active: true } : {}),
      }
    })
    return { type: 'browser_state', tabs: entries, ...(changes.length > 0 ? { state_changes: changes } : {}) }
  }

  #state(tab: Tab): TabState {
    const wc = tab.view.webContents
    return { key: `${wc.getURL()}\n${wc.getTitle()}`, tabIds: new Set(this.#deps.tabs.all().map((t) => t.id)) }
  }

  /** Lets the page react, then reports URL, title, or tab changes. */
  async #settle(tab: Tab, before: TabState, signal: AbortSignal): Promise<ResultBlock[]> {
    await sleep(150, signal)
    const wc = tab.view.webContents
    if (!wc.isDestroyed() && wc.isLoading()) await waitForStop(wc, 5_000, signal)
    if (wc.isDestroyed()) return [this.#browserState()]
    const after = this.#state(tab)
    const opened = [...after.tabIds].filter((id) => !before.tabIds.has(id))
    // A link from the agent's tab that opened a tab takes the agent along (it opens out of sight).
    const last = opened[opened.length - 1]
    if (last && this.#currentId === tab.id) this.#currentId = last
    if (after.key === before.key && opened.length === 0 && !this.#deps.stateChanges?.pending()) return []
    return [this.#browserState(opened.map((id) => ({ type: 'tab_opened' as const, tab_id: id })))]
  }

  // ---- geometry ----

  /** The tab's own page area: its split pane when showing, the full page area while it works out of sight. */
  #viewport(tab: Tab): Viewport {
    const { width, height } = tab.view.getBounds()
    if (width <= 0 || height <= 0) throw new Error('The page area is not visible yet.')
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
    return { width, height, scale }
  }

  /**
   * Maps a model coordinate (screenshot pixels) to CSS pixels in the page,
   * which is what CDP input expects: screenshot px / scale = DIP, and
   * DIP / page zoom = CSS px.
   */
  #toCss(tab: Tab, target: CoordinateTarget): Point {
    const { width, height, scale } = this.#viewport(tab)
    const shotWidth = Math.round(width * scale)
    const shotHeight = Math.round(height * scale)
    if (target.x < 0 || target.y < 0 || target.x >= shotWidth || target.y >= shotHeight) {
      throw new Error(`Coordinate (${target.x}, ${target.y}) is outside the viewport (${shotWidth}x${shotHeight}).`)
    }
    const zoom = tab.view.webContents.getZoomFactor()
    return { x: target.x / scale / zoom, y: target.y / scale / zoom }
  }

  async #locate(tab: Tab, target: Target): Promise<{ point: Point; element: ElementDescription | null; label: string }> {
    const wc = tab.view.webContents
    if (target.type === 'ref') {
      const resolved = await this.#deps.bridge.request<ResolvedElement>(wc, { op: 'resolveRef', ref: target.ref, scrollIntoView: true })
      const name = resolved.name ? ` ${JSON.stringify(truncate(resolved.name, 60))}` : ''
      return { point: { x: resolved.x, y: resolved.y }, element: withGuard(resolved), label: `${target.ref} (${resolved.role}${name})` }
    }
    const point = this.#toCss(tab, target)
    const element = await this.#deps.bridge
      .request<ElementDescription | null>(wc, { op: 'describePoint', x: point.x, y: point.y })
      .catch(() => null)
    return { point, element: withGuard(element), label: `(${target.x}, ${target.y})` }
  }

  async #confirm(action: GuardedAction, tab: Tab, signal: AbortSignal, step?: { member: string; label: string }): Promise<void> {
    // DC-10: the keyword guard, with a decision model's second opinion when one is on (it only adds stops).
    const wc = tab.view.webContents
    const isPrivate = (this.#deps.isPrivate?.() ?? false) || (wc.session ? !wc.session.isPersistent() : false)
    const guard = await guardActionChecked(action, { title: wc.getTitle(), url: wc.getURL() }, isPrivate)
    // The session decides by the approval mode, saved rules and the countdown.
    if (this.#deps.approve) {
      return this.#deps.approve({ member: step?.member ?? (action.kind === 'enter' ? 'key' : 'left_click'), guard, url: wc.getURL(), label: step?.label ?? guard?.reason ?? '' }, signal)
    }
    // CH-18: the chat's mode decides; always-ask actions ask in both modes.
    const reason = needsApproval(this.#deps.confirmConsequentialActions(), guard) ? (guard?.reason ?? null) : null
    if (!reason) return
    const origin = originOf(tab.view.webContents.getURL())
    const allowed = await this.#deps.requestApproval(`wants to ${reason} on ${origin}`, origin, signal)
    if (!allowed) {
      throw new Error(`The user declined the action (${reason}). Do not attempt it another way; ask the user how to proceed.`)
    }
  }

  // ---- members ----

  async #navigate(input: MemberInput<'navigate'>, signal: AbortSignal): Promise<ResultBlock[]> {
    const nav = parseAgentNavigation(input.url)
    const target = this.#lookup(input.tab_id)
    // An artifact tab (sandbox session) is treated like an Atelier page: navigation opens beside it.
    const atelierPage = target.internalUrl !== null || target.sandbox !== undefined
    if (atelierPage && nav.kind === 'history') throw new Error(ATELIER_PAGE_HISTORY)
    const opened = atelierPage ? this.#openBeside(target) : null
    const tab = opened ?? this.#tab(target.id)
    const wc = tab.view.webContents
    const before = this.#state(tab)
    if (nav.kind === 'history') {
      if (nav.action === 'back') {
        if (!wc.navigationHistory.canGoBack()) throw new Error('There is no previous page in this tab.')
        wc.navigationHistory.goBack()
      } else if (nav.action === 'forward') {
        if (!wc.navigationHistory.canGoForward()) throw new Error('There is no next page in this tab.')
        wc.navigationHistory.goForward()
      } else {
        wc.reload()
      }
      await sleep(100, signal)
      await waitForStop(wc, NAVIGATION_TIMEOUT_MS, signal)
    } else {
      await loadWithTimeout(wc, nav.url, NAVIGATION_TIMEOUT_MS, signal)
    }
    const verb = nav.kind === 'history' ? { back: 'Went back to', forward: 'Went forward to', reload: 'Reloaded' }[nav.action] : 'Navigated to'
    const where = opened ? ` in a new tab (${tab.id}), since ${target.id} shows a built-in ${BRAND_NAME} page` : ''
    const blocks: ResultBlock[] = [{ type: 'text', text: `${verb} ${wc.getURL()}${where}` }]
    if (opened) blocks.push(this.#browserState([{ type: 'tab_opened', tab_id: tab.id }]))
    else if (this.#state(tab).key !== before.key) blocks.push(this.#browserState())
    return blocks
  }

  async #screenshot(input: MemberInput<'screenshot'>): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const { width, height, scale } = this.#viewport(tab)
    const image = await maskForAgent(tab.id, await capture(tab.view.webContents))
    const sized = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
    return [imageBlock(sized.toPNG())]
  }

  async #zoom(input: MemberInput<'zoom'>): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = input.region
    if (!(x1 > x0 && y1 > y0)) throw new Error('region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.')
    const { width, height, scale } = this.#viewport(tab)
    const left = Math.max(0, Math.floor(x0 / scale))
    const top = Math.max(0, Math.floor(y0 / scale))
    const rect = {
      x: left,
      y: top,
      width: Math.max(1, Math.min(width, Math.ceil(x1 / scale)) - left),
      height: Math.max(1, Math.min(height, Math.ceil(y1 / scale)) - top),
    }
    const image = await maskForAgent(tab.id, await capture(tab.view.webContents, rect), rect)
    const size = image.getSize()
    const factor = Math.min(4, 1024 / Math.max(size.width, size.height))
    const out = factor > 1 ? image.resize({ width: Math.round(size.width * factor), height: Math.round(size.height * factor), quality: 'best' }) : image
    return [imageBlock(out.toPNG())]
  }

  async #click(input: MemberInput<'left_click'>, button: MouseButton, count: number, verb: string, signal: AbortSignal): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const before = this.#state(tab)
    const modifiers = parseModifiers(input.modifiers)
    const { point, element, label } = await this.#locate(tab, input.target)
    await this.#confirm({ kind: 'click', element }, tab, signal, { member: clickMember(button, count), label: `${verb.replace(/ed$/, '')} ${label}` })
    await click(tab.view.webContents, point, button, count, modifiers)
    const extra = await this.#settle(tab, before, signal)
    return [{ type: 'text', text: `${verb} ${label}` }, ...extra]
  }

  async #hover(input: MemberInput<'hover'>): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const { point, label } = await this.#locate(tab, input.target)
    await mouseMove(tab.view.webContents, point)
    return [{ type: 'text', text: `Moved the pointer to ${label}` }]
  }

  async #drag(input: MemberInput<'left_click_drag'>, signal: AbortSignal): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const wc = tab.view.webContents
    const from = this.#toCss(tab, input.from)
    const to = this.#toCss(tab, input.target)
    await mouseMove(wc, from)
    await mouseDown(wc, from)
    const steps = 8
    for (let step = 1; step <= steps; step++) {
      await sleep(16, signal)
      await mouseMove(wc, { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps }, 'left')
    }
    await mouseUp(wc, to)
    return [{ type: 'text', text: `Dragged from (${input.from.x}, ${input.from.y}) to (${input.target.x}, ${input.target.y})` }]
  }

  async #mouseButton(input: MemberInput<'left_mouse_down'>, direction: 'down' | 'up'): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const point = this.#toCss(tab, input.target)
    const wc = tab.view.webContents
    await mouseMove(wc, point, direction === 'up' ? 'left' : null)
    if (direction === 'down') await mouseDown(wc, point)
    else await mouseUp(wc, point)
    return [{ type: 'text', text: `Mouse button ${direction} at (${input.target.x}, ${input.target.y})` }]
  }

  async #scroll(input: MemberInput<'scroll'>, signal: AbortSignal): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const amount = input.scroll_amount ?? 3
    await scroll(tab.view.webContents, this.#toCss(tab, input.target), input.scroll_direction, amount)
    await sleep(250, signal)
    return [{ type: 'text', text: `Scrolled ${input.scroll_direction} by ${amount}` }]
  }

  async #scrollTo(input: MemberInput<'scroll_to'>): Promise<ResultBlock[]> {
    const tab = this.#tab(input.tab_id)
    const resolved = await this.#deps.bridge.request<ResolvedElement>(tab.view.webContents, { op: 'resolveRef', ref: input.target.ref, scrollIntoView: true })
    return [{ type: 'text', text: `Scrolled ${input.target.ref} (${resolved.role}) into view` }]
  }

  async #type(input: MemberInput<'type'>, signal: AbortSignal): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const wc = tab.view.webContents
    const focus = await this.#deps.bridge.request<ElementDescription | null>(wc, { op: 'describeFocus' })
    await this.#refuseGuardedFocus(tab, focus)
    if (focus?.isPassword) throw new Error(`The focused field is a password field. ${BRAND_NAME} does not let the agent enter passwords; ask the user to type it.`)
    if (focus?.isPaymentField) throw new Error('The focused field takes payment card details. Ask the user to fill it in.')
    const before = this.#state(tab)
    await insertText(wc, input.text)
    const extra = await this.#settle(tab, before, signal)
    const into = focus ? ` into ${focus.role}${focus.name ? ` ${JSON.stringify(truncate(focus.name, 60))}` : ''}` : ''
    return [{ type: 'text', text: `Typed ${input.text.length} characters${into}` }, ...extra]
  }

  async #key(input: MemberInput<'key'>, signal: AbortSignal): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const wc = tab.view.webContents
    const strokes = parseKeySequence(input.text)
    const repeat = input.repeat ?? 1
    // Keys that would change a guarded field's value are refused.
    if (strokes.some(editsField)) await this.#refuseGuardedFocus(tab, await this.#deps.bridge.request<ElementDescription | null>(wc, { op: 'describeFocus' }).catch(() => null))
    if (strokes.some((s) => s.key === 'Enter' && s.modifiers.length === 0)) {
      const focus = await this.#deps.bridge.request<ElementDescription | null>(wc, { op: 'describeFocus' }).catch(() => null)
      await this.#confirm({ kind: 'enter', element: focus }, tab, signal, { member: 'key', label: `Press ${input.text}` })
    }
    const before = this.#state(tab)
    for (let i = 0; i < repeat; i++) {
      for (const stroke of strokes) {
        await pressKey(wc, stroke)
        await sleep(15, signal)
      }
    }
    const extra = await this.#settle(tab, before, signal)
    return [{ type: 'text', text: `Pressed ${input.text}${repeat > 1 ? ` ${repeat} times` : ''}` }, ...extra]
  }

  async #holdKey(input: MemberInput<'hold_key'>, signal: AbortSignal): Promise<ResultBlock[]> {
    const tab = await this.#visibleTab(input.tab_id)
    const stroke = parseKeyCombo(input.text)
    if (editsField(stroke)) await this.#refuseGuardedFocus(tab, await this.#deps.bridge.request<ElementDescription | null>(tab.view.webContents, { op: 'describeFocus' }).catch(() => null))
    await keyDown(tab.view.webContents, stroke)
    try {
      await sleep(input.duration * 1000, signal)
    } finally {
      await keyUp(tab.view.webContents, stroke)
    }
    return [{ type: 'text', text: `Held ${input.text} for ${input.duration} seconds` }]
  }

  async #wait(input: MemberInput<'wait'>, signal: AbortSignal): Promise<ResultBlock[]> {
    if (input.tab_id) this.#tab(input.tab_id)
    await sleep(input.duration * 1000, signal)
    return [{ type: 'text', text: `Waited ${input.duration} seconds` }]
  }

  /** The PDF reader when this tab shows a PDF, else null (the page bridge reads it as usual). */
  async #pdfOf(tab: Tab): Promise<import('./pdfTab').PdfTabReader | null> {
    const reader = this.#deps.pdf?.() ?? null
    return reader && (await reader.isPdf(tab)) ? reader : null
  }

  /** The page as atelier-step reads it (agent/tools/browserSteps.ts): the named tab, else the agent's own, else the person's. A blank tab or a PDF has none. */
  async stepPage(tabId?: string | null): Promise<{ tabId: string; title: string; url: string; page: StepPage | null }> {
    const tab = this.#tab(tabId)
    const wc = tab.view.webContents
    if (isBlank(tab) || (await this.#pdfOf(tab))) return { tabId: tab.id, title: wc.getTitle(), url: wc.getURL(), page: null }
    const page = await this.#deps.bridge.request<StepPage>(wc, { op: 'stepPage' })
    return { tabId: tab.id, title: wc.getTitle(), url: wc.getURL(), page }
  }

  async #readPage(input: MemberInput<'read_page'>): Promise<ResultBlock[]> {
    const tab = this.#tab(input.tab_id)
    if (isBlank(tab)) return [{ type: 'text', text: BLANK }]
    const pdf = await this.#pdfOf(tab)
    if (pdf) return [{ type: 'text', text: await pdf.pageText(tab) }]
    const text = await this.#deps.bridge.request<string>(tab.view.webContents, {
      op: 'readPage',
      filter: input.filter ?? null,
      depth: input.depth ?? 15,
      ref: input.ref ?? null,
    })
    return [{ type: 'text', text: await redactGuarded(text, (ref) => this.#guardOfRef(tab, ref)) }]
  }

  async #find(input: MemberInput<'find'>): Promise<ResultBlock[]> {
    const tab = this.#tab(input.tab_id)
    if (isBlank(tab)) return [{ type: 'text', text: BLANK }]
    const pdf = await this.#pdfOf(tab)
    if (pdf) return [{ type: 'text', text: await pdf.find(tab, input.query) }]
    const text = await this.#deps.bridge.request<string>(tab.view.webContents, { op: 'find', query: input.query })
    return [{ type: 'text', text: await redactGuarded(text, (ref) => this.#guardOfRef(tab, ref)) }]
  }

  async #pageText(input: MemberInput<'get_page_text'>): Promise<ResultBlock[]> {
    const tab = this.#tab(input.tab_id)
    if (isBlank(tab)) return [{ type: 'text', text: BLANK }]
    const pdf = await this.#pdfOf(tab)
    if (pdf) return [{ type: 'text', text: await pdf.pageText(tab) }]
    const text = await this.#deps.bridge.request<string>(tab.view.webContents, { op: 'getText' })
    return [{ type: 'text', text }]
  }

  async #formInput(input: MemberInput<'form_input'>): Promise<ResultBlock[]> {
    const tab = this.#tab(input.tab_id)
    const wc = tab.view.webContents
    // A guarded target is refused before anything is written, whatever the approval mode.
    const target = await this.#deps.bridge.request<ResolvedElement>(wc, { op: 'resolveRef', ref: input.target.ref, scrollIntoView: true }).catch(() => null)
    const targetGuard = target ? await this.#guardOfResolved(tab, target) : null
    if (targetGuard) throw new Error(targetGuard === true ? guardedRefusal() : guardRefusal(targetGuard, 'target'))
    const result = await this.#deps.bridge.request<FormInputResult>(wc, { op: 'formInput', ref: input.target.ref, value: input.value })
    if (result.needsInsertText) await insertText(wc, String(input.value))
    const { role, name } = result.description
    const label = `${input.target.ref} (${role}${name ? ` ${JSON.stringify(truncate(name, 60))}` : ''})`
    return [{ type: 'text', text: `Set ${label} to ${JSON.stringify(input.value)}` }]
  }

  // Password, card, CVC and one-time-code fields, in frames too
  /** Throws when the focused field, in the page or any of its frames, is guarded. */
  async #refuseGuardedFocus(tab: Tab, focus: ElementDescription | null): Promise<void> {
    const guard = guardOfDescription(focus) ?? (await agentFocusedGuard(tab.id))
    if (guard) throw new Error(guardRefusal(guard))
  }

  /** A resolved element's guard: its own attributes, else whether it sits on a guarded field's rect. */
  async #guardOfResolved(tab: Tab, el: ResolvedElement): Promise<GuardKind | true | null> {
    const own = guardOfDescription(el)
    if (own) return own
    const zoom = tab.view.webContents.getZoomFactor() || 1
    return (await agentGuardedAt(tab.id, { x: el.x * zoom, y: el.y * zoom })) ? true : null
  }

  async #guardOfRef(tab: Tab, ref: string): Promise<GuardKind | true | null> {
    const el = await this.#deps.bridge.request<ResolvedElement>(tab.view.webContents, { op: 'resolveRef', ref, scrollIntoView: false }).catch(() => null)
    return el ? this.#guardOfResolved(tab, el) : null
  }

  /** Opens in the background as the agent's own tab; the person's tab stays in front. */
  #newTab(): Promise<ResultBlock[]> {
    const tab = this.#deps.tabs.create('about:blank', { activate: false })
    this.#deps.onTabTouched(tab.id)
    this.#currentId = tab.id
    return Promise.resolve([this.#browserState([{ type: 'tab_opened', tab_id: tab.id }])])
  }

  /** Moves the agent to the tab; what the person sees doesn't change. */
  #switchTab(input: MemberInput<'switch_tab'>): Promise<ResultBlock[]> {
    const tab = this.#tab(input.tab_id)
    this.#currentId = tab.id
    return Promise.resolve([this.#browserState()])
  }

  #closeTab(input: MemberInput<'close_tab'>): Promise<ResultBlock[]> {
    // Atelier pages (a chat, Settings) belong to the user; the agent's chat may live in one.
    if (this.#lookup(input.tab_id).internalUrl !== null || this.#lookup(input.tab_id).sandbox !== undefined) throw new Error(`${input.tab_id} shows a built-in ${BRAND_NAME} page, which only the user can close.`)
    this.#tab(input.tab_id)
    this.#deps.tabs.close(input.tab_id, { keepOne: false })
    return Promise.resolve([this.#browserState()])
  }
}

// ---- helpers ----

/** Captures the view, retrying briefly while the compositor warms up. */
async function capture(wc: WebContents, rect?: Electron.Rectangle): Promise<Electron.NativeImage> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const image = rect ? await wc.capturePage(rect) : await wc.capturePage()
      if (!image.isEmpty()) return image
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
  }
  throw new Error(`Could not capture the page${lastError ? ` (${errorMessage(lastError)})` : ''}. Try again.`)
}

function imageBlock(png: Buffer): BetaImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }
}

const BLANK = `The tab is blank or shows a built-in ${BRAND_NAME} page (not a website). Open a website with navigate: on a built-in page it opens in a new tab, or use new_tab first.`
const ATELIER_PAGE_HISTORY = `That tab shows a built-in ${BRAND_NAME} page, which has no web history. Use navigate with an address; it opens in a new tab.`
const COVERED = `${BRAND_NAME} shows reader view or a site warning over this page, so it cannot be seen or clicked. Ask the user to close it, or use another tab.`

function isBlank(tab: Tab): boolean {
  // An agent-built app (atelier-app://) counts as an Atelier page; the agent never acts there.
  // So does an artifact tab (atelier-artifact://, or any tab in a sandbox session).
  // And an extension's own page (chrome-extension://), which only you drive.
  const url = tab.view.webContents.getURL()
  return tab.internalUrl !== null || isBlankUrl(url) || isAppRunUrl(url) || tab.sandbox !== undefined || isArtifactUrl(url) || isExtensionUrl(url)
}

function clip(text: string): string {
  // browser_state fields allow no control characters or U+2028/U+2029.
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : char
  }
  return out.slice(0, 4096)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Stopped.')
}

/** Resolves when the page stops loading, or after timeoutMs regardless. */
function waitForStop(wc: WebContents, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      wc.removeListener('did-stop-loading', onStop)
      signal.removeEventListener('abort', onAbort)
    }
    const onStop = (): void => {
      cleanup()
      resolve()
    }
    const onAbort = (): void => {
      cleanup()
      reject(abortError(signal))
    }
    const timer = setTimeout(onStop, timeoutMs)
    wc.once('did-stop-loading', onStop)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function loadWithTimeout(wc: WebContents, url: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const load = wc.loadURL(url).catch((err: unknown) => {
    const code = (err as { code?: string }).code
    // ERR_ABORTED means a redirect or another navigation replaced this one.
    if (code === 'ERR_ABORTED') return
    throw new Error(`Failed to load ${url}: ${code ?? errorMessage(err)}`)
  })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([load, timeout, aborted])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
