/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import type { BetaBrowserStateChange } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { SHARED_OWNER, type ChatAgentEvent, type ChatSummary, type ChatView, type FeedbackRating, type NewChatOptions, type MessageAttachmentInput, type QueuedMessage } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { Routine } from '@shared/services'
import { CHAT_TITLE_MAX, chatMarkdown } from '../chats'
import type { AgentBackend } from '../engines/backend'
import { AgentSession, type ChatBrowser, type SendResult, type SessionDeps, type SessionHooks } from './session'
import type { MessageSource } from '@shared/chats'
import type { ChatPreview, TabUsed } from '@shared/services/chat'
import { network } from '../network'
import { newestPage, olderPage } from './paging'
import { chatPreview } from './preview'
import { TabNotes } from './runControl'
import type { AgentRequestResponse, DelegationStatus, SystemPromptView } from '@shared/agentTools'
import type { ChatStatus } from '@shared/chats'
import type { UsageKind } from '@shared/usage'
import type { ChildOutcome, ChildRun, DelegationHost } from './delegation'
import type { AgentHostApi, BackgroundRunInput, CompleteInput, StartChatOptions } from './hostApi'
import { answers, requestIdOf, unresolved } from './requests'
import { toolNames, type AgentToolsRuntime, type DraftSetup } from './sessionAgentTools'
import { buildTools } from './session'
import Anthropic from '@anthropic-ai/sdk'
import type { FilesApi } from './content'
import type { AttachmentRef } from '@shared/attachments'
import type { ApprovalResponse } from './localTools'
import type { RichChatDeps } from './sessionRichChat'
import { noticeView } from '../migrations/notice'
import { ChatMigrationError } from '../migrations/runner'

// Keeps one AgentSession per chat, so several chats run at once. Events go
// out tagged with their chat and a global sequence number; a surface loads a
// chat's view (log plus `seq`) and then applies only newer live events.
// Each running chat owns the tabs it touches, and two chats never drive the
// same tab. Routine runs are background sessions without browser control.

/** Idle saved sessions kept loaded; older ones are dropped and reloaded from disk on demand. */
const LOADED_LIMIT = 16
const DRAFT_LIMIT = 50
/** Owner value for tabs an MCP client outside Atelier (Claude Code, say) drives (ST-60). Chat ids are UUIDs, so it never clashes. */
const OUTSIDE = 'outside'

/** What agentControl.ts hears from the host (OV-21, OV-22). */
export type ControlSignal =
  | { kind: 'claim'; chatId: string; tabId: string }
  | { kind: 'release'; chatId: string; tabId: string }
  | { kind: 'event'; chatId: string; event: AgentEvent }

export interface HostDeps extends SessionDeps {
  emit(event: ChatAgentEvent): void
  onTabOwners(owners: Record<string, string>): void
  onQueue(chatId: string, queued: QueuedMessage[]): void
  /** The online state (SS-06); defaults to main's network module. */
  online?: { isOnline(): boolean; onChange(fn: (online: boolean) => void): () => void }
  /** When a routine runs next, for routine chats' previews. */
  routineNextRun?(routineId: string): number | null
}

export class AgentHost implements AgentHostApi {
  readonly #deps: HostDeps
  readonly #sessions = new Map<string, AgentSession>()
  /** Tab id to the chat that controls it. */
  readonly #owners = new Map<string, string>()
  /** Each surface (per window, when the report says which) to the chat it shows. */
  readonly #viewers = new Map<string, { surface: string; chatId: string; windowId?: number }>()
  /** Tabs each chat has acted on since start-up, for the "tabs this chat used" list. */
  readonly #used = new Map<string, Set<string>>()
  readonly #pendingChanges = new Map<string, BetaBrowserStateChange[]>()
  #seq = 0

  constructor(deps: HostDeps) {
    this.#deps = deps
  }

  // Engine-neutral, for requests, delegation and private chats
  #quick: QuickText | null = null
  #open: ((chatId: string, where: 'page' | 'panel') => void) | null = null

  /** The agentTools feature installs approvals, site rules, usage and delegation, the quick model for complete(), and how to open a chat. */
  installAgentTools(runtime: AgentToolsRuntime, extras: { quick?: QuickText; open?(chatId: string, where: 'page' | 'panel'): void } = {}): void {
    this.#deps.agentTools = runtime
    this.#quick = extras.quick ?? null
    this.#open = extras.open ?? null
  }

  /** A background chat without browser control (routines, tidy, imports); resolves when its run ends. */
  async runBackground(input: BackgroundRunInput): Promise<{ ok: boolean; chatId: string | null; status: ChatStatus }> {
    if (input.appendTo) {
      // A routine's `append` destination: the run goes into that chat, which must be saved and yours to write.
      if (this.#sessions.get(input.appendTo)?.agentTools.isPrivate) throw new Error('A routine can’t add to a private chat.')
      const summary = this.#deps.chats.summary(input.appendTo)
      if (!summary) throw new Error('That chat no longer exists.')
      this.#writable(input.appendTo)
      const session = this.#session(input.appendTo)
      const result = await session.send(input.prompt)
      return { ok: result.ok, chatId: session.id, status: this.#deps.chats.summary(session.id)?.status ?? (result.ok ? 'finished' : 'error') }
    }
    // A companion that was removed since the run was set up falls back to the active one.
    const companion = this.#deps.companions.find(input.companionId)
    const d: DraftSetup = { kind: input.kind, background: true, ...(input.routineRun ? { routineRun: input.routineRun } : {}), ...(input.capabilities ? { capabilities: input.capabilities } : {}) }
    const session = this.#draft(companion ? { companionId: companion.id } : {}, input.routineId ?? null, false, d)
    if (input.title?.trim()) session.renameDraft(input.title.trim().slice(0, CHAT_TITLE_MAX))
    const result = await session.send(input.prompt)
    const chatId = session.draft ? null : session.id
    return { ok: result.ok, chatId, status: (chatId ? this.#deps.chats.summary(chatId)?.status : undefined) ?? (result.ok ? 'finished' : 'error') }
  }

  /** One model call outside any chat, on the person's own engine, recorded under `kind`. */
  async complete(input: CompleteInput): Promise<string> {
    if (!this.#quick) throw new Error(`${BRAND_NAME} can’t reach a model right now. Check Settings › Model and key.`)
    const who = (input.companionId ? this.#deps.companions.find(input.companionId) : undefined) ?? this.#deps.companions.active()
    return this.#quick.text({
      system: input.system,
      prompt: input.prompt,
      model: who.model ?? this.#deps.settings.get().model,
      ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
      companionId: who.id,
      kind: input.kind,
    })
  }

  /** Starts a chat with its first message; `context` goes into that message as its own block. */
  startChat(text: string, options: StartChatOptions = {}): string {
    if (!text.trim()) throw new Error('Type a message to start a chat.')
    const { context, open, creator, ...chat } = options
    const session = this.#draft(chat, null, true, { ...(context?.trim() ? { context } : {}), ...(creator ? { creator: true } : {}) })
    void this.#track(session.send(text))
    if (open && open !== 'none') this.#open?.(session.id, open)
    return session.id
  }

  /** Adds an event to a chat's log from outside a run (a card's outcome, a delegation's status). */
  appendEvent(chatId: string, event: AgentEvent): void {
    this.#session(chatId).appendEvent(event)
  }

  /** Every decision goes through here. Unknown or already-answered requests are ignored. */
  respond(chatId: string, requestId: string, response: AgentRequestResponse): void {
    let session = this.#sessions.get(chatId)
    if (!session) {
      if (!this.#deps.chats.summary(chatId)) return
      session = this.#session(chatId)
    }
    if (session.agentTools.respond(requestId, response)) return
    // A proposal card stays open after its run ended; saving or dismissing it later still logs the outcome.
    const content = session.content()
    if (content && response.kind === 'proposal' && unresolved(content.log).some((e) => requestIdOf(e) === requestId && answers(e, response))) {
      session.appendEvent({ type: 'request-resolved', requestId, outcome: response.action })
    }
  }

  /** A chat's frozen prompt, or what the companion's next chat would get. */
  systemPromptView(target: { chatId: string } | { companionId: string }): SystemPromptView {
    let session: AgentSession
    if ('chatId' in target) {
      session = this.#session(target.chatId)
    } else {
      if (!this.#deps.companions.find(target.companionId)) throw new Error('That companion no longer exists.')
      // A throwaway draft, never registered or saved.
      session = new AgentSession(this.#deps, QUIET_HOOKS, { kind: 'draft', id: randomUUID(), options: { companionId: target.companionId }, routineId: null, browser: true })
    }
    const frozen = session.content() !== null
    const { system, capabilities } = session.previewPrompt()
    return { system, tools: toolNames(buildTools(capabilities, this.#deps.connectors.resolve(capabilities.connectorIds))), frozen }
  }

  /** chats.continue: a stopped or interrupted sub-task picks up again; anything else is CH-14's Continue. */
  continueChat(id: string): void {
    this.#writable(id)
    const session = this.#session(id)
    const summary = session.draft ? session.draftSummary() : this.#deps.chats.summary(id)
    const parentChatId = summary?.parentChatId ?? null
    const halted = summary?.delegationStatus === 'stopped' || summary?.delegationStatus === 'interrupted'
    if (parentChatId && halted && !session.running && !session.canContinue()) {
      this.#resumeChild(session, parentChatId)
      return
    }
    this.continue(id)
  }

  /** chats.discard: drops a private chat (and its sub-tasks); nothing of it was ever saved. */
  discardPrivate(id: string): void {
    const session = this.#sessions.get(id)
    if (!session) return
    if (!session.agentTools.isPrivate) throw new Error('Only private chats can be discarded. Delete this chat instead.')
    const children = [...this.#sessions.values()].filter((s) => s.agentTools.draft.parentChatId === id).map((s) => s.id)
    this.discard([id, ...children])
  }

  /** CH-30: 'content' for a private chat with something in it, 'empty' for one without, null for any other chat. */
  privateState(id: string): 'content' | 'empty' | null {
    const session = this.#sessions.get(id)
    if (!session?.agentTools.isPrivate) return null
    return session.content() !== null || session.running || session.queued().length > 0 ? 'content' : 'empty'
  }

  /** CH-30: what each surface shows now, as [surface, chatId] ('panel', 'page:<tabId>', …), with the window it is in when known. */
  viewing(): Array<[surface: string, chatId: string, windowId?: number]> {
    return [...this.#viewers.values()].map((v): [string, string, number?] => (v.windowId === undefined ? [v.surface, v.chatId] : [v.surface, v.chatId, v.windowId]))
  }

  /** Saved permissions: forget a chat's remembered approvals. */
  revokeChat(chatId: string): void {
    const session = this.#sessions.get(chatId) ?? (this.#deps.chats.summary(chatId) ? this.#session(chatId) : undefined)
    session?.agentTools.revokeGrants()
    this.#deps.agentTools?.sites.setChatGrants(chatId, 0)
  }

  /** What delegation needs from the host. */
  /** A loaded chat's browser, for a client tool that drives it (browser_steps); null when the chat isn't loaded. */
  browserFor(chatId: string): ChatBrowser | null {
    return this.#sessions.get(chatId)?.chatBrowser() ?? null
  }

  delegationHost(): DelegationHost {
    return {
      startChild: (parentChatId, task, onStatus) => this.#startChild(parentChatId, task, onStatus),
      stop: (chatId) => {
        this.stop(chatId)
      },
    }
  }

  #startChild(parentChatId: string, task: { title: string; instructions: string }, onStatus: (status: DelegationStatus) => void): ChildRun {
    const parent = this.#sessions.get(parentChatId)
    if (!parent) throw new Error('The chat that asked for this sub-task is gone.')
    const setup = parent.setup()
    let childId = ''
    const d: DraftSetup = {
      parentChatId,
      kind: 'subtask',
      context: childContext(task.title),
      onDelegationStatus: (status) => {
        onStatus(status)
        this.#childStatus(childId, status)
      },
    }
    // Same companion, model, effort and engine; browser control only when the parent has it, and never the parent's tabs (claims refuse them while it runs).
    const child = this.#draft({ companionId: setup.companionId, model: setup.model, effort: setup.effort, engine: setup.engine, ...(setup.private ? { private: true } : {}) }, null, setup.browser, d)
    childId = child.id
    child.renameDraft(task.title.slice(0, CHAT_TITLE_MAX))
    const done = child.send(task.instructions).then(
      () => this.#childDone(child),
      (err: unknown): ChildOutcome => {
        this.#childStatus(child.id, 'needs-attention')
        return { status: 'needs-attention', text: '', error: err instanceof Error ? err.message : String(err) }
      },
    )
    return { childChatId: child.id, done }
  }

  #childDone(child: AgentSession): ChildOutcome {
    const outcome = childOutcome(child)
    this.#childStatus(child.id, outcome.status)
    return outcome
  }

  #childStatus(childId: string, status: DelegationStatus): void {
    if (childId && this.#deps.chats.summary(childId)) this.#deps.chats.update([childId], { delegationStatus: status })
  }

  /** A child resumed by chats.continue: its card in the parent follows it, though the parent no longer waits. */
  #resumeChild(child: AgentSession, parentChatId: string): void {
    let card: Extract<AgentEvent, { type: 'delegation' }> | undefined
    try {
      card = this.#session(parentChatId).content()?.log.findLast((e): e is Extract<AgentEvent, { type: 'delegation' }> => e.type === 'delegation' && e.childChatId === child.id)
    } catch {
      card = undefined
    }
    const report = (status: DelegationStatus): void => {
      this.#childStatus(child.id, status)
      if (card) this.appendEvent(parentChatId, { ...card, status })
    }
    report('working')
    void child.send(CHILD_CONTINUE).then(
      () => report(childOutcome(child).status),
      () => report('needs-attention'),
    )
  }

  /** CH-31: an imported transcript is read-only. */
  #writable(id: string): void {
    if (this.#deps.chats.summary(id)?.imported) throw new Error('This is an imported conversation. Continue it in a new chat.')
  }

  /** A draft chat: it has an id and choices, and is saved at its first message. */
  create(options: NewChatOptions = {}): ChatSummary {
    return this.#draft(options, null, true).draftSummary()
  }

  configure(id: string, options: NewChatOptions): ChatSummary {
    const session = this.#session(id)
    if (options.companionId && !this.#deps.companions.find(options.companionId)) throw new Error('That companion no longer exists.')
    session.configure(options)
    return session.draftSummary()
  }

  /** Starts a run in the background; progress arrives as events. */
  send(id: string, text: string, attachments?: MessageAttachmentInput[]): { queued: boolean } {
    this.#writable(id) // CH-31
    const session = this.#session(id)
    const queued = session.running
    // The session turns images and meetings into content blocks and resolves refs.
    void this.#track(session.send(text, attachments))
    return { queued }
  }

  /** Creates a chat and sends its first message. */
  start(text: string, options: NewChatOptions = {}, attachments?: MessageAttachmentInput[]): string {
    if (!text.trim()) throw new Error('Type a message to start a chat.')
    const session = this.#draft(options, null, true)
    // See send.
    void this.#track(session.send(text, attachments))
    return session.id
  }

  stop(id: string): string[] {
    return this.#sessions.get(id)?.stop() ?? []
  }

  /** On quit: stops every run so steps end with results rather than mid-call. */
  stopAll(): void {
    for (const session of this.#sessions.values()) if (session.running) session.stop()
  }

  approve(id: string, approvalId: string, allowed: boolean): void {
    this.#sessions.get(id)?.approve(approvalId, allowed)
  }

  view(id: string): ChatView {
    // (SS-09: a damaged chat file, or one a newer Atelier
    // saved, opens read-only with a notice. Its session never loads, so send
    // and every other call that changes the chat refuse with the same message.)
    let session: AgentSession
    try {
      session = this.#session(id)
    } catch (err) {
      const saved = err instanceof ChatMigrationError ? this.#deps.chats.summary(id) : undefined
      if (saved) return noticeView({ summary: saved, error: err as ChatMigrationError, seq: this.#seq, effort: this.#deps.settings.get().effort })
      throw err
    }
    const summary = session.draft ? session.draftSummary() : this.#deps.chats.summary(id)
    if (!summary) throw new Error('This chat no longer exists.')
    const snapshot = session.snapshot()
    // CH-13: a long chat loads its newest page; chats.older pages back from logStart.
    const page = newestPage(snapshot.log)
    return {
      summary,
      setup: session.setup(),
      ...snapshot,
      log: page.events,
      logStart: page.start,
      seq: this.#seq,
      tabIds: this.#tabsOf(id),
      usedTabIds: [...(this.#used.get(id) ?? [])].filter((tabId) => this.#deps.tabs.find(tabId)),
    }
  }

  rename(id: string, title: string): ChatSummary {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, CHAT_TITLE_MAX)
    if (!clean) throw new Error('Give the chat a name.')
    const draft = this.#sessions.get(id)
    if (draft?.draft) {
      draft.renameDraft(clean)
      return draft.draftSummary()
    }
    const [updated] = this.#deps.chats.update([id], { title: clean })
    const summary = updated ?? this.#deps.chats.summary(id)
    if (!summary) throw new Error('This chat no longer exists.')
    return summary
  }

  /** The backends of the engines besides the API key. */
  #otherBackends(): AgentBackend[] {
    return Object.values((this.#deps.backends ?? {}) as Partial<Record<string, AgentBackend>>).filter((b): b is AgentBackend => b !== undefined)
  }

  /** Chats were deleted for good: the other engines let go of what they kept for them. */
  chatsRemoved(ids: readonly string[]): void {
    for (const backend of this.#otherBackends()) for (const id of ids) backend.removed?.(id)
  }

  /** Stops and forgets chats; the caller deletes their files. */
  discard(ids: readonly string[]): void {
    for (const id of ids) {
      this.#used.delete(id)
      const session = this.#sessions.get(id)
      if (!session) continue
      session.stop()
      this.#release(id)
      this.#sessions.delete(id)
    }
    // Other engines keep their own processes per chat.
    for (const backend of this.#otherBackends()) for (const id of ids) backend.discard(id)
  }

  /** CH-09: `attachments` replaces the message's attachments; leaving it out keeps them. */
  editAndResend(id: string, userMessageId: string, text: string, attachments?: MessageAttachmentInput[]): void {
    if (!text.trim()) throw new Error('Type a message to send.')
    this.#writable(id) // CH-31
    const session = this.#session(id)
    session.checkAttachments(attachments) // Refuse an unfinished attachment before anything is cut
    if (attachments === undefined) session.keepAttachmentsOf(userMessageId)
    session.cutAt(userMessageId)
    void this.#track(session.send(text, attachments))
  }

  retry(id: string, turnId?: string): void {
    this.#writable(id) // CH-31
    const session = this.#session(id)
    const target = session.retryTarget(turnId)
    session.keepAttachmentsOf(target.userMessageId) // A retry resends the same attachments
    session.cutAt(target.userMessageId)
    void this.#track(session.send(target.text))
  }

  feedback(id: string, turnId: string, rating: FeedbackRating | null, note?: string): ReturnType<AgentSession['setFeedback']> {
    return this.#session(id).setFeedback(turnId, rating, note)
  }

  details(id: string, turnId: string): ReturnType<AgentSession['details']> {
    return this.#session(id).details(turnId)
  }

  editQueued(id: string, queuedId: string, text: string | null): QueuedMessage[] {
    return this.#session(id).editQueued(queuedId, text)
  }

  /** The chat as Markdown, for export. */
  markdown(id: string): { title: string; text: string } {
    const summary = this.#deps.chats.summary(id)
    if (!summary) throw new Error('Send a message before exporting this chat.')
    const log = this.#sessions.get(id)?.content()?.log ?? this.#deps.chats.load(id).log
    const name = this.#deps.companions.find(summary.companionId)?.name ?? 'Companion'
    return { title: summary.title, text: chatMarkdown(summary, log, name) }
  }

  // CH-36: the export dialog names the companion in its headings
  /** A companion's display name, or null for a removed one. */
  companionName(companionId: string): string | null {
    return this.#deps.companions.find(companionId)?.name ?? null
  }

  /**
   * A surface reports the chat it shows (null when it stops). Showing a chat
   * marks it read. `windowId` is the window the report came from (CH-30: each
   * window has its own side panel, so main knows which panel shows which chat).
   */
  setViewing(surface: string, chatId: string | null, windowId?: number): void {
    const key = windowId === undefined ? surface : `${windowId}:${surface}`
    const before = this.#viewers.get(key)?.chatId
    if (chatId === null) this.#viewers.delete(key)
    else this.#viewers.set(key, windowId === undefined ? { surface, chatId } : { surface, chatId, windowId })
    if (chatId && chatId !== before) this.#deps.chats.update([chatId], { unread: false })
  }

  /** A window's chrome reloaded (its surfaces report again as they mount) or the window closed; with no window, every surface. */
  clearViewing(windowId?: number): void {
    if (windowId === undefined) {
      this.#viewers.clear()
      return
    }
    for (const [key, v] of this.#viewers) if (v.windowId === windowId) this.#viewers.delete(key)
  }

  isViewed(id: string): boolean {
    for (const v of this.#viewers.values()) if (v.chatId === id) return true
    return false
  }

  tabOwners(): Record<string, string> {
    return Object.fromEntries([...this.#owners].filter(([, owner]) => owner !== OUTSIDE))
  }

  /**
   * ST-60: a Claude Code session outside Atelier takes a tab. The tab shows the
   * agent marker (with no chat to open). Throws while one of your chats works in it.
   */
  claimOutside(tabId: string): void {
    const owner = this.#owners.get(tabId)
    if (owner === OUTSIDE) return
    if (owner && this.#sessions.get(owner)?.running) {
      throw new Error(`One of the user’s ${BRAND_NAME} chats is working in this tab. Use a different tab, or wait until it finishes.`)
    }
    this.#owners.set(tabId, OUTSIDE)
    this.#deps.tabs.setAgentControlled(tabId, true, null)
    this.#deps.onTabOwners(this.tabOwners())
  }

  /** Lets go of every tab the outside session holds. */
  releaseOutside(): void {
    this.#release(OUTSIDE)
  }

  isRunning(id: string): boolean {
    return this.#sessions.get(id)?.running ?? false
  }

  /** Download events reach every running chat that controls tabs, in its next browser_state. */
  stateChange(change: BetaBrowserStateChange): void {
    for (const session of this.#sessions.values()) {
      if (!session.running || !session.browser) continue
      const queue = this.#pendingChanges.get(session.id) ?? []
      queue.push(change)
      this.#pendingChanges.set(session.id, queue)
    }
  }

  /** Runs a routine as a background chat of its companion (shared routines run as the active one). On runBackground. */
  async runRoutine(routine: Pick<Routine, 'id' | 'prompt' | 'owner'>): Promise<{ ok: boolean; chatId: string | null }> {
    const owner = routine.owner !== SHARED_OWNER ? this.#deps.companions.find(routine.owner) : undefined
    const result = await this.runBackground({ companionId: owner?.id ?? this.#deps.companions.active().id, prompt: routine.prompt, kind: 'routine', routineId: routine.id })
    return { ok: result.ok, chatId: result.chatId }
  }

  // The agent at work: notes for the next result, pause and resume
  /** Text the agent sees with its next result on this tab (denied permission requests, OV-12). */
  noteForNextResult(tabId: string, text: string): void {
    this.#notes.add(tabId, text)
  }

  /** Pauses the chat's run at the next safe point (the shield's Pause). */
  pause(chatId: string): void {
    this.#sessions.get(chatId)?.pause()
  }

  resume(chatId: string): void {
    this.#sessions.get(chatId)?.resume()
  }

  // Chats additions: CH-13 to CH-18, CH-33, SS-05, SS-06
  readonly #notes = new TabNotes()
  readonly #saveListeners = new Set<(chatId: string, error: string | null) => void>()

  isPaused(chatId: string): boolean {
    return this.#sessions.get(chatId)?.paused ?? false
  }

  /** SS-05: a chat's save failed, or worked again (null). */
  onSaveState(listener: (chatId: string, error: string | null) => void): () => void {
    this.#saveListeners.add(listener)
    return () => this.#saveListeners.delete(listener)
  }

  preview(id: string): ChatPreview {
    const session = this.#sessions.get(id)
    const summary = session?.draft ? session.draftSummary() : this.#deps.chats.summary(id)
    if (!summary) throw new Error('This chat no longer exists.')
    const log = session?.content()?.log ?? (summary.draft ? [] : this.#deps.chats.load(id).log)
    return chatPreview({
      summary,
      log,
      status: session?.status ?? 'idle',
      nextRunAt: summary.routineId ? (this.#deps.routineNextRun?.(summary.routineId) ?? null) : null,
    })
  }

  /** CH-14: Continue after the step limit, in the same chat. */
  continue(id: string): void {
    void this.#track(this.#session(id).continue())
  }

  /** CH-16: ⌘↩ while working stops at the next safe point and sends `text`; idle, it sends. */
  interrupt(id: string, text: string, source?: MessageSource): void {
    if (!text.trim()) throw new Error('Type a message to send.')
    void this.#track(this.#session(id).interrupt(text, source))
  }

  /** CH-15: a queued message goes out now (interrupting a run). */
  sendNow(id: string, queuedId: string): void {
    void this.#track(this.#session(id).sendNow(queuedId))
  }

  retryQueued(id: string, queuedId: string): void {
    void this.#track(this.#session(id).retryQueued(queuedId))
  }

  /** CH-18: ask first, or act without asking, for this chat. */
  setActWithoutAsking(id: string, on: boolean): ChatSummary {
    const session = this.#session(id)
    return session.setActWithoutAsking(on) ?? session.draftSummary()
  }

  /** NS-01: no notifications for this chat. Drafts have nothing to notify about yet. */
  setMuted(id: string, muted: boolean): ChatSummary | null {
    const [updated] = this.#deps.chats.update([id], { muted })
    return updated ?? this.#deps.chats.summary(id) ?? null
  }

  /** CH-33: the open tabs this chat acted on since Atelier started. */
  tabsUsed(id: string): TabUsed[] {
    return [...(this.#used.get(id) ?? [])].flatMap((tabId) => {
      const tab = this.#deps.tabs.find(tabId)
      if (!tab) return []
      const info = this.#deps.tabs.info(tab)
      return [{ tabId, title: info.title, url: info.url }]
    })
  }

  /** Closes this chat's used tabs (all, or the ones named); never a tab another running chat holds. */
  closeTabsUsed(id: string, tabIds?: readonly string[]): number {
    const used = this.#used.get(id) ?? new Set<string>()
    const wanted = (tabIds ?? [...used]).filter((tabId) => used.has(tabId))
    const closable = wanted.filter((tabId) => {
      const owner = this.#owners.get(tabId)
      return !owner || owner === id || !this.#sessions.get(owner)?.running
    })
    if (this.isRunning(id) && closable.some((tabId) => this.#owners.get(tabId) === id)) throw new Error('Stop the chat before closing the tabs it is working in.')
    for (const tabId of closable) used.delete(tabId)
    return closable.length > 0 ? this.#deps.tabs.closeMany(closable) : 0
  }

  /** CH-13: the page of log events before index `before` (a view's logStart). */
  older(id: string, before: number, limit: number): { events: AgentEvent[]; hasOlder: boolean } {
    const session = this.#session(id)
    const page = olderPage(session.content()?.log ?? [], before, limit)
    return { events: page.events, hasOlder: page.hasOlder }
  }

  /** SS-05: tries the failed save again. */
  retrySave(id: string): boolean {
    return this.#session(id).retrySave()
  }

  #online(): NonNullable<HostDeps['online']> {
    return this.#deps.online ?? network
  }

  #watchingOnline = false

  /** SS-06: once a chat has seen the connection drop, messages that waited for it go out when it returns. */
  #isOnline(): boolean {
    const online = this.#online().isOnline()
    if (!online && !this.#watchingOnline) {
      this.#watchingOnline = true
      this.#online().onChange((back) => {
        if (!back) return
        for (const session of this.#sessions.values()) void this.#track(session.online())
      })
    }
    return online
  }

  #saveState(chatId: string, error: string | null): void {
    for (const listener of this.#saveListeners) {
      try {
        listener(chatId, error)
      } catch (err) {
        console.warn('Chat save listener failed:', err)
      }
    }
  }

  // OV-21, OV-22: agentControl.ts follows claims, releases and each chat's events
  readonly #controlListeners = new Set<(signal: ControlSignal) => void>()

  /** Follows tab claims, releases and every chat event; returns the unsubscribe. */
  onControl(listener: (signal: ControlSignal) => void): () => void {
    this.#controlListeners.add(listener)
    return () => this.#controlListeners.delete(listener)
  }

  /** The companion a chat runs as (a draft's own choice, or the saved chat's). */
  companionOf(chatId: string): string | null {
    const session = this.#sessions.get(chatId)
    if (session?.draft) return session.draftSummary().companionId
    return this.#deps.chats.summary(chatId)?.companionId ?? null
  }

  /** A companion's name and colours for the at-work surfaces and menus (the active one when unknown). */
  companionLook(companionId: string | null): { id: string; name: string; accent: string } {
    const c = (companionId && this.#deps.companions.find(companionId)) || this.#deps.companions.active()
    return { id: c.id, name: c.name, accent: c.look.colors.accent }
  }

  #control(signal: ControlSignal): void {
    for (const listener of this.#controlListeners) {
      try {
        listener(signal)
      } catch (err) {
        console.warn('Agent control listener failed:', err)
      }
    }
  }

  // CH-26, CH-40, CH-41, CH-47, SS-03
  /** The richChat feature installs the attachment, files and connector APIs for every session. */
  useRichChat(deps: RichChatDeps): void {
    this.#deps.richChat = deps
  }

  get richChatDeps(): RichChatDeps | undefined {
    return this.#deps.richChat
  }

  /** The Files API under the current key (the offline client in smoke), or null without one. */
  filesApi(): FilesApi | null {
    const apiKey = this.#deps.settings.apiKey()
    if (!apiKey && !this.#deps.client) return null
    const client = this.#deps.client ? this.#deps.client(apiKey) : new Anthropic({ apiKey })
    return (client as { files?: FilesApi }).files ?? null
  }

  /** CH-41: the endpoints of the connectors that are on, so suggest_connector skips services already connected. */
  connectedUrls(): string[] {
    try {
      return this.#deps.connectors.resolve(this.#deps.connectors.enabledIds()).map((c) => c.url)
    } catch {
      return []
    }
  }

  /** SS-03: compacts the chat now. A reason it can't throws here; the run's own errors show in the chat. */
  compact(id: string): void {
    this.#writable(id)
    const session = this.#session(id)
    session.checkCompact()
    void session.compact().catch((err: unknown) => console.warn('A compaction failed:', err))
  }

  /** CH-40: the person's answer to a local connector tool's approval. */
  approveConnector(chatId: string, approvalId: string, response: ApprovalResponse): void {
    const session = this.#sessions.get(chatId)
    if (!session) throw new Error('That chat isn’t running anything right now.')
    session.approveConnector(approvalId, response)
  }

  /**
   * CH-41: a new chat with the same companion and these connectors on top of
   * its own, which resends the last message with copies of its attachments.
   */
  continueInNewChat(id: string, options: { connectorIds?: string[] } = {}): ChatSummary {
    const summary = this.#deps.chats.summary(id)
    if (!summary) throw new Error('This chat no longer exists.')
    const last = lastUserMessage(this.#deps.chats.load(id).log)
    if (!last) throw new Error('This chat has no message to continue from.')
    const companionId = this.#deps.companions.find(summary.companionId) ? summary.companionId : undefined
    const session = this.#draft(companionId ? { companionId } : {}, null, true)
    if (options.connectorIds?.length) session.addConnectors(options.connectorIds)
    const ids = last.attachments.map((ref) => ref.id)
    let copied: string[] = []
    const c = this.#deps.richChat
    if (ids.length > 0 && c) {
      try {
        const { failed } = c.attachments().copyForChat(id, session.id, ids)
        // Only the copies that landed go with the message; one that failed would stop the send.
        copied = failed === 0 ? ids : ids.filter((ref) => {
          try {
            return c.attachments().resolve(session.id, [ref]).length === 1
          } catch {
            return false
          }
        })
      } catch (err) {
        console.warn('Attachments could not be copied:', err)
      }
    }
    void this.#track(session.send(last.text, copied.map((ref) => ({ kind: 'ref' as const, id: ref }))))
    return session.draftSummary()
  }

  /** CH-47: duplicates a chat with copies of its attachments; `failed` counts the ones that couldn't be copied. */
  duplicate(id: string): { summary: ChatSummary; failed: number } {
    const summary = this.#deps.chats.duplicate(id)
    let failed = 0
    const c = this.#deps.richChat
    if (c) {
      try {
        failed = c.attachments().copyForChat(id, summary.id).failed
      } catch {
        failed = attachmentCount(this.#deps.chats.load(id).log)
      }
      // The copy's history names the same uploads, so they stay until both chats are gone.
      c.remoteFiles.copyChat(id, summary.id)
    }
    // Another engine's copy carries on from the same place (its own conversation and files).
    for (const backend of this.#otherBackends()) backend.duplicated?.(id, summary.id)
    return { summary, failed }
  }

  /** A draft session for the end-to-end check, which drives its executor directly. */
  smokeSession(): AgentSession {
    return this.#draft({}, null, true)
  }

  #draft(options: NewChatOptions, routineId: string | null, browser: boolean, setup?: DraftSetup): AgentSession {
    if (options.companionId && !this.#deps.companions.find(options.companionId)) throw new Error('That companion no longer exists.')
    const id = randomUUID()
    const session = new AgentSession(this.#deps, this.#hooks(id), { kind: 'draft', id, options, routineId, browser, ...(setup ? { setup } : {}) })
    this.#sessions.set(id, session)
    this.#trim()
    return session
  }

  #session(id: string): AgentSession {
    const loaded = this.#sessions.get(id)
    if (loaded) {
      // Re-insert so the map stays in least-recently-used order.
      this.#sessions.delete(id)
      this.#sessions.set(id, loaded)
      return loaded
    }
    const summary = this.#deps.chats.summary(id)
    if (!summary) throw new Error('This chat no longer exists.')
    const session = new AgentSession(this.#deps, this.#hooks(id), { kind: 'saved', content: this.#deps.chats.load(id), summary })
    this.#sessions.set(id, session)
    this.#trim()
    return session
  }

  #hooks(id: string): SessionHooks {
    return {
      emit: (event: AgentEvent) => {
        // The chat's tabs show that it waits for you while an approval is open.
        if (event.type === 'status') for (const tabId of this.#tabsOf(id)) this.#deps.tabs.setNeedsInput(tabId, event.status === 'awaiting-approval')
        this.#deps.emit({ chatId: id, seq: ++this.#seq, event })
        this.#control({ kind: 'event', chatId: id, event })
      },
      claimTab: (tabId) => this.#claim(id, tabId),
      releaseTabs: () => this.#release(id),
      viewed: () => this.isViewed(id),
      queueChanged: (queued) => this.#deps.onQueue(id, queued),
      stateChanges: {
        pending: () => (this.#pendingChanges.get(id)?.length ?? 0) > 0,
        take: () => this.#pendingChanges.get(id)?.splice(0) ?? [],
      },
      online: () => this.#isOnline(),
      takeNotes: () => this.#notes.take(this.#tabsOf(id)),
      saveState: (error) => this.#saveState(id, error),
    }
  }

  #claim(chatId: string, tabId: string): void {
    const owner = this.#owners.get(tabId)
    if (owner === chatId) return
    if (owner === OUTSIDE) throw new Error(`Claude Code, running outside ${BRAND_NAME}, is working in this tab. Use a different tab.`)
    if (owner && this.#sessions.get(owner)?.running) {
      throw new Error('Another chat is working in this tab. Use a different tab, or wait until that chat finishes.')
    }
    this.#owners.set(tabId, chatId)
    this.#used.set(chatId, (this.#used.get(chatId) ?? new Set<string>()).add(tabId))
    this.#deps.tabs.setAgentControlled(tabId, true, chatId)
    this.#control({ kind: 'claim', chatId, tabId })
    this.#deps.onTabOwners(this.tabOwners())
  }

  #release(chatId: string): void {
    let changed = false
    for (const [tabId, owner] of [...this.#owners]) {
      if (owner !== chatId) continue
      this.#owners.delete(tabId)
      this.#deps.tabs.setAgentControlled(tabId, false)
      this.#control({ kind: 'release', chatId, tabId })
      changed = true
    }
    this.#pendingChanges.delete(chatId)
    if (changed) this.#deps.onTabOwners(this.tabOwners())
  }

  /** Drops the least recently used idle sessions beyond the limits. */
  #trim(): void {
    // A chat whose save failed stays loaded, so Retry still has its content.
    const idle = (s: AgentSession): boolean => !s.running && s.queued().length === 0 && !this.isViewed(s.id) && !this.#ownsTabs(s.id) && s.saveError === null
    const saved = [...this.#sessions.values()].filter((s) => !s.draft && idle(s))
    for (const session of saved.slice(0, Math.max(0, saved.length - LOADED_LIMIT))) this.#sessions.delete(session.id)
    // CH-30: a private chat that has started lives only here, so it is never dropped.
    const drafts = [...this.#sessions.values()].filter((s) => s.draft && idle(s) && !(s.agentTools.isPrivate && s.content() !== null))
    for (const session of drafts.slice(0, Math.max(0, drafts.length - DRAFT_LIMIT))) this.#sessions.delete(session.id)
  }

  #ownsTabs(chatId: string): boolean {
    for (const owner of this.#owners.values()) if (owner === chatId) return true
    return false
  }

  #tabsOf(chatId: string): string[] {
    return [...this.#owners].flatMap(([tabId, owner]) => (owner === chatId ? [tabId] : []))
  }

  async #track(run: Promise<SendResult>): Promise<void> {
    try {
      await run
    } catch (err) {
      console.warn('A chat run failed:', err)
    }
  }
}

/** The newest message you typed, with its attachments. */
function lastUserMessage(log: readonly AgentEvent[]): { text: string; attachments: AttachmentRef[] } | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]
    if (event?.type === 'user-message') return { text: event.text, attachments: event.attachments ?? [] }
  }
  return null
}

function attachmentCount(log: readonly AgentEvent[]): number {
  return log.reduce((n, event) => n + (event.type === 'user-message' ? (event.attachments?.length ?? 0) : 0), 0)
}

/** The quick model's call, as complete() uses it (the QuickModel). */
export interface QuickText {
  text(request: { system: string; prompt: string; model?: string; maxTokens?: number; companionId?: string; kind?: UsageKind }): Promise<string>
}

/** Hooks for a throwaway session that never runs (the prompt viewer). */
const QUIET_HOOKS: SessionHooks = {
  emit: () => undefined,
  claimTab: () => undefined,
  releaseTabs: () => undefined,
  viewed: () => false,
  queueChanged: () => undefined,
}

/** What a resumed sub-task is told. */
const CHILD_CONTINUE = 'Continue where you stopped.'

function childContext(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120)
  return `This chat is a sub-task that another chat handed to you, called "${clean}". Work on it by yourself and end with the full result in your final reply: the other chat reads only that. If something only the user can decide comes up, ask them; they can open this chat and answer.`
}

/** How a child's run ended, for the parent's card and tool result. */
function childOutcome(child: AgentSession): ChildOutcome {
  const outcome = child.agentTools.outcome
  if (!outcome) return { status: 'needs-attention', text: '', error: 'The sub-task ended without a result.' }
  if (outcome.stopped) return { status: 'stopped', text: outcome.text, error: null }
  if (outcome.error) return { status: 'needs-attention', text: outcome.text, error: outcome.error }
  return { status: outcome.waiting ? 'needs-input' : 'done', text: outcome.text, error: null }
}
