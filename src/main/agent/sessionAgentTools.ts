/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The request, approval and grant side of one chat session, kept out of session.ts so the
// shared loop only carries small hooks: the client tools frozen at the first
// message, the request broker, approvals and site rules before each browser
// action, remembered grants, private chats, usage rows, web sources, and
// closing requests a restart interrupted. Engine-neutral: the API-key loop
// and the other engines' backends call the same methods.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import type { ActionKind, AgentRequestResponse, ApprovalMode, ApprovalScope, ChatGrant, DelegationStatus } from '@shared/agentTools'
import type { ChatSummary } from '@shared/chats'
import { CHAT_SUMMARY_LINK_DEFAULTS } from '@shared/chats'
import { isFlagOn } from '@shared/flags'
import type { AgentEvent } from '@shared/ipc'
import { PACK_TOOL_NAME_PREFIX } from '@shared/packs'
import { AUTO_APPROVAL_MS } from '@shared/agentTools'
import type { UsageKind, UsageRow } from '@shared/usage'
import type { ChatContent } from '../chats'
import { ACTING_MEMBERS, clampScope, decideApproval, memberAction, READ_MEMBERS } from './approvals'
import type { GuardResult } from './guard'
import { interruptions, RequestBroker, type RequestEvent, type WaitingKind } from './requests'
import type { SiteRulesStore } from './sitePolicy'
import { ruleOrigin } from './sitePolicy'
import { CREATOR_TOOL, clientTool, clientToolNames, runClientTool, workspaceSetup, type ClientToolContext, type ToolSetup } from './tools/registry'
import type { Delegations } from './delegation'
import type { ResultBlock } from './browserTool'

/** What the agentTools feature installs on the host for every session. */
export interface AgentToolsRuntime {
  mode(): ApprovalMode
  sites: SiteRulesStore
  recordUsage(row: UsageRow): void
  delegations: Delegations
  flags(): Record<string, string>
  /** A project's name and instructions, or null. */
  project(id: string): { name: string; instructions: string } | null
  isRunning(chatId: string): boolean
}

/** What a host gives a new chat beyond NewChatOptions. */
export interface DraftSetup {
  kind?: UsageKind
  parentChatId?: string
  routineRun?: ChatSummary['routineRun']
  /** Goes into the first user message as its own block. */
  context?: string
  title?: string
  /** A routine or other background run: no tools that wait on you. */
  background?: boolean
  capabilities?: Partial<{ webTools: boolean; memory: boolean; connectors: boolean }>
  /** A delegated child reports its waits to the parent's card. */
  onDelegationStatus?(status: DelegationStatus): void
  /** Started as a Creator chat (New app, New pack, Edit, Remix): the builder tools are on from the first message. */
  creator?: boolean
}

/** What SessionAgentTools needs from its session. */
export interface SessionAgentToolsHost {
  readonly chatId: string
  companionId(): string
  companionName(): string
  content(): ChatContent | null
  /** Logs and sends an event. */
  emit(event: AgentEvent): void
  /** The chat waits on an approval, an answer, or nothing. */
  waiting(kind: WaitingKind | null): void
  /** Saves the content without touching updatedAt. */
  persist(): void
  /** The chat's own "act without asking" (CH-17). */
  actWithoutAsking(): boolean
  confirmConsequential(): boolean
}

export interface RunOutcome {
  text: string
  stopped: boolean
  error: string | null
  waiting: boolean
}

type TurnUsage = Pick<UsageRow, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>

/** Latest plan wins, delegation and browser-steps cards upsert by id; a source already logged is skipped. Returns true when handled. */
export function foldAgentToolsEvent(log: AgentEvent[], event: AgentEvent): boolean {
  if (event.type === 'plan') {
    for (let i = log.length - 1; i >= 0; i--) if (log[i]?.type === 'plan') log.splice(i, 1)
    log.push(event)
    return true
  }
  if (event.type === 'delegation') {
    const index = log.findIndex((e) => e.type === 'delegation' && e.id === event.id)
    if (index >= 0) log[index] = event
    else log.push(event)
    return true
  }
  if (event.type === 'browser-steps') {
    const index = log.findIndex((e) => e.type === 'browser-steps' && e.id === event.id)
    if (index >= 0) log[index] = event
    else log.push(event)
    return true
  }
  if (event.type === 'source') {
    if (!log.some((e) => e.type === 'source' && e.url === event.url)) log.push(event)
    return true
  }
  return false
}

/** The prompt viewer's tool list: server tools by name, the browser toolset as "browser", connectors by server name. */
export function toolNames(tools: readonly unknown[]): string[] {
  return tools.map((raw) => {
    const tool = raw as { type?: string; name?: string; mcp_server_name?: string }
    if (tool.name) return tool.name
    if (tool.mcp_server_name) return `${tool.mcp_server_name} (connector)`
    return tool.type?.startsWith('browser_toolset') ? 'browser' : (tool.type ?? 'tool')
  })
}

/** Which skill a `/skill` message expanded (SK-04), for the user-message event. */
export function skillRef(skill: { id: string; name: string; builtin?: unknown }): { id: string; name: string; builtin: boolean } {
  return { id: skill.id, name: skill.name, builtin: skill.builtin === true }
}

/** Web sources in an API reply: search results, fetched pages and citations. */
export function sourcesOf(content: readonly unknown[]): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = []
  const add = (url: unknown, title: unknown): void => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || out.some((s) => s.url === url)) return
    out.push({ url: url.slice(0, 2048), title: (typeof title === 'string' && title.trim() ? title.trim() : url).slice(0, 300) })
  }
  for (const raw of content) {
    const block = raw as { type?: string; content?: unknown; citations?: unknown }
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content as Array<{ type?: string; url?: unknown; title?: unknown }>) if (r.type === 'web_search_result') add(r.url, r.title)
    } else if (block.type === 'web_fetch_tool_result') {
      const result = block.content as { type?: string; url?: unknown; content?: { title?: unknown } } | undefined
      if (result?.type === 'web_fetch_result') add(result.url, result.content?.title)
    } else if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations as Array<{ type?: string; url?: unknown; title?: unknown }>) if (c.type === 'web_search_result_location') add(c.url, c.title)
    }
  }
  return out.slice(0, 50)
}

function sentence(label: string): string {
  return label ? label[0]?.toLowerCase() + label.slice(1) : label
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

export class SessionAgentTools {
  readonly broker: RequestBroker
  readonly draft: DraftSetup
  readonly isPrivate: boolean
  readonly #host: SessionAgentToolsHost
  readonly #runtime: () => AgentToolsRuntime | undefined
  /** Origins this chat may act on although their rule says ask ("for this chat"). */
  readonly #siteChat = new Set<string>()
  readonly #recorded = new Set<string>()
  #lastError: string | null = null
  #outcome: RunOutcome | null = null

  constructor(host: SessionAgentToolsHost, runtime: () => AgentToolsRuntime | undefined, draft: DraftSetup, isPrivate: boolean) {
    this.#host = host
    this.#runtime = runtime
    this.draft = draft
    this.isPrivate = isPrivate
    this.broker = new RequestBroker({
      emit: (event) => host.emit(event),
      waiting: (kind) => {
        host.waiting(kind)
        draft.onDelegationStatus?.(kind === 'approval' ? 'needs-attention' : kind === 'input' ? 'needs-input' : 'working')
      },
    })
  }

  get isChild(): boolean {
    return this.draft.parentChatId !== undefined
  }

  get kind(): UsageKind {
    return this.draft.kind ?? (this.isChild ? 'subtask' : 'chat')
  }

  // ---- setup ----

  /** The client tools a new chat freezes at its first message. */
  clientTools(base: { companionId: string; browser: boolean; memory: boolean; routine: boolean }, creator = this.draft.creator === true): string[] {
    const flags = this.#runtime()?.flags() ?? {}
    const partial: Omit<ToolSetup, 'workspace'> = { ...base, routine: base.routine || this.draft.background === true, private: this.isPrivate, flags, child: this.isChild, creator }
    const setup: ToolSetup = { ...partial, workspace: workspaceSetup(partial, (id) => isFlagOn(flags, id)) }
    // The Helper chats experiment turns delegation off.
    return clientToolNames(setup).filter((name) => name !== 'delegate_task' || isFlagOn(flags, 'delegation'))
  }

  /** A capability the host overrode for a background run, or the setting. */
  capability(name: 'webTools' | 'memory' | 'connectors', setting: boolean): boolean {
    const value = this.draft.capabilities?.[name] ?? setting
    return name === 'memory' && this.isPrivate ? false : value
  }

  /** The SessionAgentTools summary fields for this chat's record. */
  summaryFields(): Pick<ChatSummary, keyof typeof CHAT_SUMMARY_LINK_DEFAULTS> {
    return {
      ...CHAT_SUMMARY_LINK_DEFAULTS,
      private: this.isPrivate,
      parentChatId: this.draft.parentChatId ?? null,
      delegationStatus: this.isChild ? 'working' : null,
      routineRun: this.draft.routineRun ?? null,
    }
  }

  /** The extra block of the first user message, if any. */
  contextBlock(): { type: 'text'; text: string } | null {
    const context = this.draft.context?.trim()
    return context ? { type: 'text', text: `<context>\n${context.replace(/<\/?context>/gi, '')}\n</context>` } : null
  }

  project(projectId: string | undefined): { name: string; instructions: string } | undefined {
    return projectId ? (this.#runtime()?.project(projectId) ?? undefined) : undefined
  }

  // ---- usage ----

  /** One ledger row per model turn; a turn whose details are sent twice counts once. */
  recordTurn(turnId: string, model: string, usage: TurnUsage, engine: UsageRow['engine']): void {
    if (this.#recorded.has(turnId)) return
    this.#recorded.add(turnId)
    this.#runtime()?.recordUsage({
      at: Date.now(),
      // Private chats are counted without a chat, so nothing ties the tokens to it.
      chatId: this.isPrivate ? null : this.#host.chatId,
      companionId: this.#host.companionId(),
      model,
      engine,
      kind: this.kind,
      ...usage,
    })
  }

  // ---- client tools ----

  /** Set when tools joined during a turn on an engine that takes new tools only in a new process. */
  #relaunch = false

  /**
   * Tools that joined since the chat froze its list (docs/apps.md › Creator
   * mode). At a turn's start: only the tools of a pack the person installed
   * or turned on since (pk_…), so a chat that gained no pack is left exactly
   * as it was. When creator_mode runs (`change.creator`): the builder tools
   * too. They join at the end of the list (the next request misses the
   * prompt cache once); every other tool stays as frozen.
   */
  joinTools(base: { companionId: string; browser: boolean; memory: boolean; routine: boolean }, change: { creator?: boolean } = {}): string[] {
    const content = this.#host.content()
    if (!content || this.isPrivate) return []
    const caps = content.capabilities
    const have = new Set(caps.clientTools ?? [])
    const creator = change.creator === true || have.has(CREATOR_TOOL)
    const joined = this.clientTools(base, creator).filter((name) => !have.has(name) && clientTool(name)?.group === 'packs' && (change.creator === true || name.startsWith(PACK_TOOL_NAME_PREFIX)))
    if (joined.length === 0) return []
    caps.clientTools = [...(caps.clientTools ?? []), ...joined]
    this.#host.persist()
    return joined
  }

  /** Whether the chat should go straight on in a fresh process, because tools joined mid-turn (an engine that takes new tools only at launch); asking clears it. */
  takeRelaunch(): boolean {
    const relaunch = this.#relaunch
    this.#relaunch = false
    return relaunch
  }

  isClientTool(name: string): boolean {
    return (this.#host.content()?.capabilities.clientTools ?? []).includes(name) && clientTool(name) !== undefined
  }

  clientContext(signal: AbortSignal): ClientToolContext {
    return {
      chatId: this.#host.chatId,
      companionId: this.#host.companionId(),
      isPrivate: this.isPrivate,
      isRoutine: this.draft.background === true,
      signal,
      emit: (event) => this.#host.emit(event),
      // A tool can't ask with a resolution; the broker logs those itself.
      ask: <R extends AgentRequestResponse>(event: Parameters<ClientToolContext['ask']>[0]) =>
        event.type === 'request-resolved' ? Promise.reject(new Error('A tool can’t resolve a request itself.')) : this.broker.ask<R>(event as RequestEvent, signal),
    }
  }

  /** Runs a frozen client tool; an error result throws, so the batch halt rule applies. Pictures follow the text as image blocks. */
  async executeClient(name: string, input: unknown, signal: AbortSignal): Promise<ResultBlock[] | string> {
    const result = await runClientTool(name, input, this.clientContext(signal))
    if (result.isError) throw new Error(result.content)
    const caps = this.#host.content()?.capabilities
    if (result.setup && caps) {
      const joined = this.joinTools({ companionId: this.#host.companionId(), browser: caps.browser, memory: caps.memory, routine: this.draft.background === true }, result.setup)
      if (joined.length > 0 && (caps.engine ?? 'api-key') !== 'api-key') this.#relaunch = true
    }
    if (!result.images || result.images.length === 0) return result.content
    return [{ type: 'text', text: result.content }, ...result.images.map((i): ResultBlock => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))]
  }

  /** runToolCalls handlers for the chat's frozen client tools. */
  clientHandlers(): Record<string, { execute(name: string, input: unknown, signal: AbortSignal): Promise<ResultBlock[] | string> }> {
    const names = (this.#host.content()?.capabilities.clientTools ?? []).filter((name) => clientTool(name) !== undefined)
    return Object.fromEntries(names.map((name) => [name, { execute: (n: string, input: unknown, signal: AbortSignal) => this.executeClient(n, input, signal) }]))
  }

  // ---- requests ----

  respond(requestId: string, response: AgentRequestResponse): boolean {
    return this.broker.respond(requestId, response)
  }

  stop(): void {
    this.broker.stopAll()
  }

  /** After a restart: closes requests nothing waits on any more, and saves the log. */
  closeInterrupted(): void {
    const content = this.#host.content()
    if (!content) return
    const runtime = this.#runtime()
    const extra = interruptions(content.log, (id) => runtime?.isRunning(id) ?? false)
    if (extra.length === 0) return
    for (const event of extra) {
      if (!foldAgentToolsEvent(content.log, event)) content.log.push(event)
    }
    this.#host.persist()
  }

  // ---- site rules and approvals ----

  /**
   * Before a browser member runs. `never` refuses reading and acting on the
   * site; `ask` asks before the first acting call of this chat there. Rules
   * are read afresh each time, so a change in Settings applies at once.
   */
  async gate(member: string, url: string | null, label: string, signal: AbortSignal): Promise<void> {
    const runtime = this.#runtime()
    const origin = url ? ruleOrigin(url) : null
    if (!runtime || !origin) return
    const access = runtime.sites.access(origin)
    if (access === 'never') {
      throw new Error(`The user has blocked ${BRAND_NAME}'s agent on ${hostOf(origin)} (Settings › Agent permissions). Tell them, and don't try to reach this site another way.`)
    }
    if (access !== 'ask' || READ_MEMBERS.has(member) || !ACTING_MEMBERS.has(member) || this.#siteChat.has(origin)) return
    const response = await this.broker.ask<Extract<AgentRequestResponse, { kind: 'site-access' }>>(
      { type: 'site-access', requestId: randomUUID(), origin, action: sentence(label) },
      signal,
    )
    switch (response.choice) {
      case 'once':
        return
      case 'chat':
        this.#siteChat.add(origin)
        return
      case 'site':
        runtime.sites.set(origin, 'allow')
        return
      case 'block':
        runtime.sites.set(origin, 'never')
        throw new Error(`The user blocked ${BRAND_NAME}'s agent on ${hostOf(origin)}. Don't try to reach this site another way; ask the user how to go on.`)
    }
  }

  /** A saved rule that allows this kind of action here, from this chat or for the site. */
  savedRule(origin: string, action: ActionKind): 'chat' | 'site' | null {
    if ((this.#host.content()?.grants ?? []).some((g) => g.origin === origin && g.action === action)) return 'chat'
    return this.#runtime()?.sites.allows(origin, action) ? 'site' : null
  }

  /**
   * Before an acting member: asks, counts down, or lets it run, by the
   * approval mode, the guard and saved rules. Throws when you decline or stop it.
   */
  async approve(request: { member: string; guard: GuardResult | null; url: string; label: string }, signal: AbortSignal): Promise<void> {
    const origin = ruleOrigin(request.url) ?? request.url
    const decision = decideApproval({
      mode: this.#runtime()?.mode() ?? 'standard',
      member: request.member,
      guard: request.guard,
      savedRule: this.savedRule(origin, request.guard?.action ?? memberAction(request.member)),
      confirmConsequential: this.#host.confirmConsequential(),
      chatDontAsk: this.#host.actWithoutAsking(),
    })
    const reason = request.guard?.reason ?? sentence(request.label)
    if (decision.kind === 'run') return
    if (decision.kind === 'countdown') {
      const response = await this.broker.ask<Extract<AgentRequestResponse, { kind: 'auto-approval' }>>(
        { type: 'auto-approval', approvalId: randomUUID(), description: `${this.#host.companionName()} will ${reason} on ${hostOf(origin)}.`, origin, rule: decision.rule, runsAt: Date.now() + AUTO_APPROVAL_MS },
        signal,
        { timeoutMs: AUTO_APPROVAL_MS, onTimeout: { kind: 'auto-approval', action: 'run-now' } },
      )
      if (response.action === 'stop') throw new Error('You stopped this action.')
      return
    }
    const allowed = await this.requestApproval(`wants to ${reason} on ${hostOf(origin)}`, origin, signal, decision.action, decision.scopes)
    if (!allowed) throw new Error(`The user declined the action (${reason}). Do not attempt it another way; ask the user how to proceed.`)
  }

  /** The approval card, with its action and scopes; a broader scope is remembered. Resolves false on deny or stop. */
  async requestApproval(description: string, origin: string, signal: AbortSignal, action: ActionKind = 'other', scopes: ApprovalScope[] = ['once']): Promise<boolean> {
    const approvalId = randomUUID()
    try {
      const response = await this.broker.ask<Extract<AgentRequestResponse, { kind: 'approval' }>>(
        { type: 'approval', approvalId, description: `${this.#host.companionName()} ${description}.`, origin, action, scopes },
        signal,
        // Older surfaces still read approval-resolved.
        { resolved: (_outcome, response) => [{ type: 'approval-resolved', approvalId, allowed: response?.kind === 'approval' && response.allowed }] },
      )
      if (!response.allowed) return false
      const scope = clampScope(response.scope, scopes)
      const key = ruleOrigin(origin)
      if (key && scope === 'chat') this.#grant({ origin: key, action, at: Date.now() })
      if (key && scope === 'site') this.#runtime()?.sites.allowAction(key, action)
      return true
    } catch {
      return false
    }
  }

  #grant(grant: ChatGrant): void {
    const content = this.#host.content()
    if (!content) return
    const grants = content.grants ?? []
    if (!grants.some((g) => g.origin === grant.origin && g.action === grant.action)) grants.push(grant)
    content.grants = grants
    this.#host.persist()
    if (!this.isPrivate) this.#runtime()?.sites.setChatGrants(this.#host.chatId, grants.length)
  }

  /** Saved permissions › chats: forget this chat's remembered approvals. */
  revokeGrants(): void {
    const content = this.#host.content()
    if (content && (content.grants?.length ?? 0) > 0) {
      content.grants = []
      this.#host.persist()
    }
    this.#siteChat.clear()
  }

  /** Whether an event goes into the log: a source already logged is dropped, and an error is kept for delegation. */
  accepts(event: AgentEvent): boolean {
    if (event.type === 'error') this.#lastError = event.message
    if (event.type === 'source') return !(this.#host.content()?.log ?? []).some((e) => e.type === 'source' && e.url === event.url)
    return true
  }

  // ---- run results ----

  failed(message: string): void {
    this.#lastError = message
  }

  runEnded(outcome: Omit<RunOutcome, 'error'> & { error: boolean }): void {
    this.#outcome = { ...outcome, error: outcome.error ? (this.#lastError ?? 'The run failed.') : null }
    this.#lastError = null
  }

  /** How the last run ended, for delegation. */
  get outcome(): RunOutcome | null {
    return this.#outcome
  }
}
