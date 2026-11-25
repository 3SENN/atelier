/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BrowserStepLine, BrowserStepsStatus } from '@shared/browserSteps'
import type { AgentEvent, AgentStatus } from '@shared/ipc'
import type { AttachmentRef } from '@shared/attachments'
import type { LibraryFileRef } from '@shared/files'
import type { MemoryChange } from '@shared/ipc'
import type { ActionKind, ApprovalScope, DelegationStatus, PlanItem, QuestionSpec, RequestOutcome, UserMessageSkill } from '@shared/agentTools'
import type { RoutineDraft } from '@shared/routines'
import type { SkillDraft } from '@shared/skills'
import type { FileRef } from '@shared/workspace'
import type { ChatErrorCode, ChatErrorFacts } from '@shared/chatErrors'
import type { ToolKind } from '@shared/ipc'

/** What CH-19's expandable steps show beyond the label (the tool event fields). */
export interface ToolStepInfo {
  kind?: ToolKind
  startedAt?: number
  endedAt?: number
  input?: string
  result?: string
  connector?: { id: string; name: string }
}

export type LogItem =
  | { kind: 'user'; id: string; text: string; /** The message's attachment chips. */ attachments?: AttachmentRef[]; /** SK-04: the skill the message ran. */ skill?: UserMessageSkill }
  | { kind: 'assistant'; id: string; text: string; thinking: string }
  | { kind: 'tool'; id: string; label: string; state: 'running' | 'done' | 'error'; detail?: string; /** CH-19: the step's kind, times, input and result summaries, and its connector. */ step?: ToolStepInfo }
  | { kind: 'approval'; id: string; description: string; origin: string; resolved: boolean | null; /** The kind of action and the scopes offered. */ action?: ActionKind; scopes?: ApprovalScope[] }
  | { kind: 'notice'; id: string; text: string; tone: 'error' | 'info'; /** SS-03: picks the error card; absent in older logs. */ code?: ChatErrorCode; retryAfterMs?: number; /** The raw failure, behind Details. */ details?: string; facts?: ChatErrorFacts }
  // CH-14, CH-17: the step-limit card with Continue, and the inline stop mark
  | { kind: 'step-limit'; id: string; turnId: string; steps: number }
  | { kind: 'stopped'; id: string; turnId: string | null; reason: 'user' | 'interrupt' | 'error' }
  // Reply cards, one per AgentEvent; cards register through chat/cards/registry.ts
  | { kind: 'compaction'; id: string; state: 'running' | 'done' | 'failed'; trigger: 'auto' | 'manual'; summary: string | null; replacedTokens: number | null; thresholdTokens: number | null }
  | { kind: 'suggestions'; id: string; turnId: string; heading: string | null; items: string[] }
  | { kind: 'memory-change'; id: string; turnId: string; changes: MemoryChange[] }
  | { kind: 'tab-opened'; id: string; turnId: string; tabId: string; url: string; title: string }
  | { kind: 'file-produced'; id: string; turnId: string; file: LibraryFileRef }
  | { kind: 'partial'; id: string; turnId: string; reason: 'step-limit' | 'stopped' | 'cut-off' | 'error' }
  | {
      kind: 'connector-approval'
      id: string
      connectorId: string
      connectorName: string
      tool: string
      actionLabel: string
      inputSchema: unknown
      input: unknown
      /** null while it waits for you. */
      outcome: 'confirmed' | 'declined' | null
      edited: boolean
    }
  | { kind: 'connector-needed'; id: string; turnId: string; directoryId: string | null; service: string; reason: string }
  // Requests and agent records, one per AgentEvent; requests carry `outcome`, null while they wait for you
  | { kind: 'auto-approval'; id: string; description: string; origin: string; rule: 'site' | 'chat'; runsAt: number; outcome: RequestOutcome | null }
  | { kind: 'site-access'; id: string; origin: string; action: string; outcome: RequestOutcome | null }
  | { kind: 'table-write'; id: string; table: string; sql: string; scope: string; destructive: boolean; outcome: RequestOutcome | null }
  | { kind: 'question'; id: string; questions: QuestionSpec[]; outcome: RequestOutcome | null }
  | { kind: 'plan'; id: string; items: PlanItem[] }
  | { kind: 'delegation'; id: string; childChatId: string; title: string; status: DelegationStatus }
  | { kind: 'browser-steps'; id: string; goal: string; status: BrowserStepsStatus; steps: BrowserStepLine[]; note: string | null }
  | { kind: 'routine-proposal'; id: string; draft: RoutineDraft; outcome: RequestOutcome | null }
  | { kind: 'routine-list'; id: string; routineIds: string[] }
  | { kind: 'skill-draft'; id: string; draft: SkillDraft; outcome: RequestOutcome | null }
  | { kind: 'app-built'; id: string; appId: string; versionId: string; name: string; outcome: RequestOutcome | null }
  | { kind: 'source'; id: string; url: string; title: string }
  | { kind: 'file-written'; id: string; turnId: string; ref: FileRef; name: string }
  /** docs/packs.md: a companion's pack draft, ready to review. */
  | { kind: 'pack-proposed'; id: string; packId: string; name: string; version: string; note: string; permissions: import('@shared/packs').PackPermissionLine[] }

export interface AgentLog {
  items: LogItem[]
  status: AgentStatus
  /** CH-16: ⌘↩ was pressed and the run is winding down to its next safe point. Live only. */
  interrupting?: boolean
}

export const EMPTY_LOG: AgentLog = { items: [], status: 'idle' }

let noticeCounter = 0

function upsert(items: LogItem[], id: string, kind: LogItem['kind'], update: (item: LogItem | undefined) => LogItem): LogItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item && item.id === id && item.kind === kind) {
      const next = items.slice()
      next[i] = update(item)
      return next
    }
  }
  return [...items, update(undefined)]
}

/** Folds a saved chat's compacted log; status events are not saved, so the caller passes the live one. */
export function foldAgentLog(events: readonly AgentEvent[], status: AgentStatus = 'idle'): AgentLog {
  return events.reduce(reduceAgentLog, { ...EMPTY_LOG, status })
}

/** Folds the agent's event stream into what a chat surface renders. */
export function reduceAgentLog(log: AgentLog, event: AgentEvent): AgentLog {
  switch (event.type) {
    case 'status':
      return { ...log, status: event.status }
    case 'reset':
      return { ...EMPTY_LOG, status: log.status }
    case 'user-message':
      return { ...log, items: [...log.items, { kind: 'user', id: event.id, text: event.text, ...(event.attachments?.length ? { attachments: event.attachments } : {}), ...(event.skill ? { skill: event.skill } : {}) }] }
    case 'text-delta':
    case 'thinking-delta':
      return {
        ...log,
        items: upsert(log.items, event.turnId, 'assistant', (item) => {
          const base = item?.kind === 'assistant' ? item : { kind: 'assistant' as const, id: event.turnId, text: '', thinking: '' }
          return event.type === 'text-delta'
            ? { ...base, text: base.text + event.text }
            : { ...base, thinking: base.thinking + event.text }
        }),
      }
    case 'tool':
      return {
        ...log,
        items: upsert(log.items, event.id, 'tool', (prev) => ({
          kind: 'tool',
          id: event.id,
          label: event.label,
          state: event.state,
          ...(event.detail ? { detail: event.detail } : {}),
          ...toolStep(event, prev?.kind === 'tool' ? prev.step : undefined), // CH-19
        })),
      }
    case 'approval':
      return {
        ...log,
        items: [...log.items, { kind: 'approval', id: event.approvalId, description: event.description, origin: event.origin, resolved: null, ...(event.action ? { action: event.action } : {}), ...(event.scopes ? { scopes: event.scopes } : {}) }],
      }
    case 'approval-resolved':
      return {
        ...log,
        items: upsert(log.items, event.approvalId, 'approval', (item) =>
          item?.kind === 'approval'
            ? { ...item, resolved: event.allowed }
            : { kind: 'approval', id: event.approvalId, description: '', origin: '', resolved: event.allowed }),
      }
    case 'error':
      return {
        ...log,
        items: [...log.items, { kind: 'notice', id: `notice-${++noticeCounter}`, text: event.message, tone: event.message === 'Stopped.' ? 'info' : 'error', ...(event.code ? { code: event.code } : {}), ...(event.retryAfterMs ? { retryAfterMs: event.retryAfterMs } : {}) /* SS-03 */, ...(event.details ? { details: event.details } : {}), ...(event.facts ? { facts: event.facts } : {}) }],
      }
    // CH-14, CH-16, CH-17
    case 'step-limit':
      return { ...log, items: upsert(log.items, `step-limit-${event.turnId}`, 'step-limit', () => ({ kind: 'step-limit', id: `step-limit-${event.turnId}`, turnId: event.turnId, steps: event.steps })) }
    case 'stopped':
      // Its place in the log is its id, so a replayed log folds to the same keys.
      return { ...log, interrupting: false, items: [...log.items, { kind: 'stopped', id: `stopped-${log.items.length}`, turnId: event.turnId, reason: event.reason }] }
    case 'interrupting':
      return { ...log, interrupting: true }
    case 'compaction':
      return {
        ...log,
        items: upsert(log.items, event.id, 'compaction', () => ({
          kind: 'compaction',
          id: event.id,
          state: event.state,
          trigger: event.trigger,
          summary: event.summary ?? null,
          replacedTokens: event.replacedTokens ?? null,
          thresholdTokens: event.thresholdTokens ?? null,
        })),
      }
    case 'suggestions':
      return { ...log, items: upsert(log.items, event.id, 'suggestions', () => ({ kind: 'suggestions', id: event.id, turnId: event.turnId, heading: event.heading, items: event.items })) }
    case 'memory-change': {
      // One card per turn: later changes in the same turn join it.
      const id = `memory-${event.turnId}`
      return {
        ...log,
        items: upsert(log.items, id, 'memory-change', (item) => ({
          kind: 'memory-change',
          id,
          turnId: event.turnId,
          changes: [...(item?.kind === 'memory-change' ? item.changes : []), ...event.changes],
        })),
      }
    }
    case 'tab-opened':
      return { ...log, items: [...log.items, { kind: 'tab-opened', id: `tab-${event.turnId}-${event.tabId}`, turnId: event.turnId, tabId: event.tabId, url: event.url, title: event.title }] }
    case 'file-produced':
      // A report streams: 'writing' first, then the same file id as 'ready' or 'failed'.
      return { ...log, items: upsert(log.items, event.file.id, 'file-produced', () => ({ kind: 'file-produced', id: event.file.id, turnId: event.turnId, file: event.file })) }
    case 'partial':
      return { ...log, items: upsert(log.items, `partial-${event.turnId}`, 'partial', () => ({ kind: 'partial', id: `partial-${event.turnId}`, turnId: event.turnId, reason: event.reason })) }
    case 'connector-approval':
      return {
        ...log,
        items: [
          ...log.items,
          {
            kind: 'connector-approval',
            id: event.approvalId,
            connectorId: event.connectorId,
            connectorName: event.connectorName,
            tool: event.tool,
            actionLabel: event.actionLabel,
            inputSchema: event.inputSchema,
            input: event.input,
            outcome: null,
            edited: false,
          },
        ],
      }
    case 'connector-approval-resolved':
      return {
        ...log,
        items: upsert(log.items, event.approvalId, 'connector-approval', (item) =>
          item?.kind === 'connector-approval'
            ? { ...item, outcome: event.outcome, edited: event.edited }
            : { kind: 'connector-approval', id: event.approvalId, connectorId: '', connectorName: '', tool: '', actionLabel: '', inputSchema: null, input: null, outcome: event.outcome, edited: event.edited }),
      }
    case 'connector-needed':
      return { ...log, items: upsert(log.items, event.id, 'connector-needed', () => ({ kind: 'connector-needed', id: event.id, turnId: event.turnId, directoryId: event.directoryId, service: event.service, reason: event.reason })) }
    // Mirrors appendToLog: the latest plan wins, delegations upsert by id
    case 'auto-approval':
    case 'site-access':
    case 'table-write':
    case 'question':
    case 'plan':
    case 'delegation':
    case 'browser-steps':
    case 'routine-proposal':
    case 'routine-list':
    case 'skill-draft':
    case 'app-built':
    case 'source':
    case 'file-written':
    case 'request-resolved':
      return reduceAgentToolsEvent(log, event)
    case 'pack-proposed':
      return { ...log, items: upsert(log.items, event.id, 'pack-proposed', () => ({ kind: 'pack-proposed', id: event.id, packId: event.packId, name: event.name, version: event.version, note: event.note, permissions: event.permissions })) }
    default:
      // Events this build doesn't draw (yet) leave the log as it is.
      return log
  }
}

/** The optional step fields of a tool event, kept on the log item (CH-19). */
function toolStep(event: Extract<AgentEvent, { type: 'tool' }>, prev?: ToolStepInfo): { step?: ToolStepInfo } {
  // An end event that leaves a field out keeps what its start said.
  const step: ToolStepInfo = {
    ...prev,
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.startedAt ? { startedAt: event.startedAt } : {}),
    ...(event.endedAt ? { endedAt: event.endedAt } : {}),
    ...(event.input ? { input: event.input } : {}),
    ...(event.result ? { result: event.result } : {}),
    ...(event.connector ? { connector: event.connector } : {}),
  }
  return Object.keys(step).length > 0 ? { step } : {}
}

type AgentToolsEventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>
type AgentToolsEventType = 'auto-approval' | 'site-access' | 'table-write' | 'question' | 'plan' | 'delegation' | 'browser-steps' | 'routine-proposal' | 'routine-list' | 'skill-draft' | 'app-built' | 'source' | 'file-written' | 'request-resolved'

/** Request kinds whose card waits for an answer; `request-resolved` closes them by id. */
const REQUEST_KINDS = new Set<LogItem['kind']>(['auto-approval', 'site-access', 'table-write', 'question', 'routine-proposal', 'skill-draft', 'app-built'])

/** Settles a request by id: an agent request gets its outcome, an approval its allowed flag. */
function resolveRequest(items: LogItem[], requestId: string, outcome: RequestOutcome): LogItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || item.id !== requestId) continue
    if (REQUEST_KINDS.has(item.kind) && 'outcome' in item) {
      const next = items.slice()
      next[i] = { ...item, outcome } as LogItem
      return next
    }
    if (item.kind === 'approval' && item.resolved === null) {
      const next = items.slice()
      next[i] = { ...item, resolved: outcome === 'allowed' || outcome === 'ran' }
      return next
    }
  }
  // Unknown or already settled requests leave the log as it is.
  return items
}

function reduceAgentToolsEvent(log: AgentLog, event: AgentToolsEventOf<AgentToolsEventType>): AgentLog {
  switch (event.type) {
    case 'auto-approval':
      return { ...log, items: upsert(log.items, event.approvalId, 'auto-approval', () => ({ kind: 'auto-approval', id: event.approvalId, description: event.description, origin: event.origin, rule: event.rule, runsAt: event.runsAt, outcome: null })) }
    case 'site-access':
      return { ...log, items: upsert(log.items, event.requestId, 'site-access', () => ({ kind: 'site-access', id: event.requestId, origin: event.origin, action: event.action, outcome: null })) }
    case 'table-write':
      return { ...log, items: upsert(log.items, event.requestId, 'table-write', () => ({ kind: 'table-write', id: event.requestId, table: event.table, sql: event.sql, scope: event.scope, destructive: event.destructive, outcome: null })) }
    case 'question':
      return { ...log, items: upsert(log.items, event.requestId, 'question', () => ({ kind: 'question', id: event.requestId, questions: event.questions, outcome: null })) }
    case 'plan':
      // Only the latest plan is kept, at the end (as main's appendToLog does).
      return { ...log, items: [...log.items.filter((item) => item.kind !== 'plan'), { kind: 'plan', id: 'plan', items: event.items }] }
    case 'delegation':
      return { ...log, items: upsert(log.items, event.id, 'delegation', () => ({ kind: 'delegation', id: event.id, childChatId: event.childChatId, title: event.title, status: event.status })) }
    case 'browser-steps':
      return { ...log, items: upsert(log.items, event.id, 'browser-steps', () => ({ kind: 'browser-steps', id: event.id, goal: event.goal, status: event.status, steps: event.steps, note: event.note ?? null })) }
    case 'routine-proposal':
      return { ...log, items: upsert(log.items, event.requestId, 'routine-proposal', () => ({ kind: 'routine-proposal', id: event.requestId, draft: event.draft, outcome: null })) }
    case 'routine-list':
      // Its place in the log is its id, so a replayed log folds to the same keys.
      return { ...log, items: [...log.items, { kind: 'routine-list', id: `routines-${log.items.length}`, routineIds: event.routineIds }] }
    case 'skill-draft':
      return { ...log, items: upsert(log.items, event.requestId, 'skill-draft', () => ({ kind: 'skill-draft', id: event.requestId, draft: event.draft, outcome: null })) }
    case 'app-built':
      return { ...log, items: upsert(log.items, event.requestId, 'app-built', () => ({ kind: 'app-built', id: event.requestId, appId: event.appId, versionId: event.versionId, name: event.name, outcome: null })) }
    case 'source':
      // One entry per address; a later title wins.
      return { ...log, items: upsert(log.items, `source:${event.url}`, 'source', () => ({ kind: 'source', id: `source:${event.url}`, url: event.url, title: event.title })) }
    case 'file-written': {
      const id = `written:${event.turnId}:${fileRefKey(event.ref)}`
      return { ...log, items: upsert(log.items, id, 'file-written', () => ({ kind: 'file-written', id, turnId: event.turnId, ref: event.ref, name: event.name })) }
    }
    case 'request-resolved':
      return { ...log, items: resolveRequest(log.items, event.requestId, event.outcome) }
  }
}

/** A stable key for a file reference (one card per file and turn). */
export function fileRefKey(ref: FileRef): string {
  switch (ref.kind) {
    case 'folder':
      return `folder:${ref.folderId}:${ref.path}`
    case 'companion':
      return `companion:${ref.companionId}:${ref.path}`
    case 'memory':
      return `memory:${ref.owner}:${ref.path}`
    case 'skill':
      return `skill:${ref.skillId}:${ref.path}`
    case 'library':
      return `library:${ref.id}`
    case 'app':
      return `app:${ref.appId}`
  }
}
