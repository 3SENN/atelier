/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Agent tools contract: the engine-neutral agent pieces
// every agent feature shares. Approval modes and scopes, per-site rules, the
// questions, plans and delegation the agent can ask for, and the one
// request protocol every user decision answers through (`agent.respond`).
// Every engine (your API key, and any other the build offers) uses these unchanged.
import { t } from './i18n/core'
import type { RoutineDraft } from './routines'
import type { SkillDraft } from './skills'
import { defaultPolicy, type ConnectorV2 } from './connectors'
import type { FileRef, WatchedFolder } from './workspace'

/** 'dont-ask' lives in memory only: launch always starts from the stored 'standard' or 'ask-all'. */
export type ApprovalMode = 'standard' | 'ask-all' | 'dont-ask'
export const APPROVAL_MODES = ['standard', 'ask-all', 'dont-ask'] as const satisfies readonly ApprovalMode[]
/** What Settings may store; 'dont-ask' never reaches disk. */
export type StoredApprovalMode = Exclude<ApprovalMode, 'dont-ask'>

export type ApprovalScope = 'once' | 'chat' | 'site'
export const APPROVAL_SCOPES = ['once', 'chat', 'site'] as const satisfies readonly ApprovalScope[]

export type SiteAccess = 'allow' | 'ask' | 'never'
export const SITE_ACCESS = ['allow', 'ask', 'never'] as const satisfies readonly SiteAccess[]

export type ActionKind = 'purchase' | 'payment' | 'message' | 'post' | 'delete' | 'account' | 'security' | 'submit' | 'navigate' | 'input' | 'other'
export const ACTION_KINDS = [
  'purchase', 'payment', 'message', 'post', 'delete', 'account', 'security', 'submit', 'navigate', 'input', 'other',
] as const satisfies readonly ActionKind[]

/** Actions that ask every time, in every mode, with scope 'once' only. Password fields stay blocked outright (the autofill guard). */
export const ALWAYS_ASK: ReadonlySet<ActionKind> = new Set<ActionKind>(['payment', 'security'])

/** One origin's saved rule (userData/agent-site-rules.json, app-wide). */
export interface SiteRule {
  origin: string
  access: SiteAccess
  /** Kinds of consequential action you allowed for good on this site. */
  actions: Partial<Record<ActionKind, 'allow'>>
  updatedAt: number
}

/** One question of `ask_user_questions` (1–8 per call, up to 6 suggested options each). */
export interface QuestionSpec {
  id: string
  prompt: string
  detail?: string
  options?: string[]
  multi?: boolean
  allowOther?: boolean
  /** "Look at this page first": opens a tab. */
  link?: { url: string; title: string }
}

export const QUESTION_LIMITS = { questions: 8, options: 6 } as const

export interface PlanItem {
  id: string
  title: string
  status: 'pending' | 'active' | 'done' | 'skipped'
}

export type DelegationStatus = 'working' | 'done' | 'needs-attention' | 'needs-input' | 'stopped' | 'interrupted'

/** Delegation limits: running children per parent; children never delegate further (depth 1). */
export const DELEGATION_LIMITS = { children: 3, depth: 1, resultChars: 20_000 } as const

/** The auto-approval countdown before a rule-approved consequential action runs. */
export const AUTO_APPROVAL_MS = 8_000

/** Settings › Agent permissions › Saved permissions (ST-13). */
export interface PermissionsOverview {
  connectors: Array<{ id: string; name: string; enabled: boolean }>
  toolPolicies: Array<{ connectorId: string; tool: string; policy: string }>
  sites: SiteRule[]
  folders: WatchedFolder[]
  chats: Array<{ chatId: string; title: string; grants: number }>
}

/** A remembered approval in a chat's record (scope 'chat'). */
export interface ChatGrant {
  origin: string
  action: ActionKind
  at: number
}

/** The host of an origin for sentences ("shop.example"); the input itself when it isn't a URL. */
function siteName(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/**
 * The sentence the second confirmation shows for a scope ("Purchases on
 * shop.example run in this chat without asking again…"). Payment and
 * account-security actions always ask, so any scope means once for them.
 */
export function scopeExplanation(action: ActionKind, origin: string, scope: ApprovalScope): string {
  const site = siteName(origin)
  const actions = t(`agent.action.many.${action}`)
  if (scope !== 'once' && ALWAYS_ASK.has(action)) return t('agent.scope.alwaysOnce', { actions })
  if (scope === 'once') return t('agent.scope.once', { action: t(`agent.action.one.${action}`), site })
  return t(scope === 'chat' ? 'agent.scope.chat' : 'agent.scope.site', { actions, site })
}

/** Every user decision, answered through `agent.respond(chatId, requestId, response)`. */
export type AgentRequestResponse =
  | { kind: 'approval'; allowed: boolean; scope: ApprovalScope }
  | { kind: 'auto-approval'; action: 'stop' | 'run-now' }
  | { kind: 'site-access'; choice: 'once' | 'chat' | 'site' | 'block' }
  | { kind: 'table-write'; allowed: boolean; scope: 'once' | 'chat' }
  | { kind: 'question'; answers: Array<{ id: string; answer: string | string[] | null }> | null }
  | { kind: 'proposal'; action: 'saved' | 'dismissed'; savedId?: string }

export type RequestOutcome = 'allowed' | 'denied' | 'answered' | 'skipped' | 'saved' | 'dismissed' | 'stopped' | 'interrupted' | 'ran'

/**
 * The agent tools' AgentEvent members. `src/shared/ipc.ts` adds this union to
 * AgentEvent. `appendToLog` keeps only the latest `plan` and upserts
 * `delegation` by id; the renderer's agentLog.ts mirrors that. Library files
 * reuse `file-produced`, and `file-written` is added for writes to watched
 * folders.
 */
export type AgentToolsEvent =
  | { type: 'auto-approval'; approvalId: string; description: string; origin: string; rule: 'site' | 'chat'; runsAt: number }
  | { type: 'site-access'; requestId: string; origin: string; action: string }
  | { type: 'table-write'; requestId: string; table: string; sql: string; scope: string; destructive: boolean }
  | { type: 'question'; requestId: string; questions: QuestionSpec[] }
  | { type: 'request-resolved'; requestId: string; outcome: RequestOutcome }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'delegation'; id: string; childChatId: string; title: string; status: DelegationStatus }
  | { type: 'routine-proposal'; requestId: string; draft: RoutineDraft }
  | { type: 'routine-list'; routineIds: string[] }
  | { type: 'skill-draft'; requestId: string; draft: SkillDraft }
  | { type: 'app-built'; requestId: string; appId: string; versionId: string; name: string }
  | { type: 'source'; url: string; title: string }
  | { type: 'file-written'; turnId: string; ref: FileRef; name: string }
  /** browser_steps (docs/decisions.md › Browser tasks): the steps atelier-step took, upserted by id while it runs. */
  | import('./browserSteps').BrowserStepsCard
  /** propose_pack (docs/packs.md): a draft ready for the person to review; the card opens the review, nothing waits on it. */
  | { type: 'pack-proposed'; id: string; packId: string; name: string; version: string; note: string; permissions: import('./packs').PackPermissionLine[] }

/** Which skill a `/skill` message expanded (SK-04), carried on `user-message`. */
export interface UserMessageSkill {
  id: string
  name: string
  builtin: boolean
}

/** The prompt viewer's answer: the frozen prompt of a chat, or what the companion's next chat would get. */
export interface SystemPromptView {
  system: string
  tools: string[]
  frozen: boolean
}


/** Methods the agent tools add to the `agent` namespace. */
export interface AgentToolsMethods {
  respond(chatId: string, requestId: string, response: AgentRequestResponse): void
  approvalMode(): ApprovalMode
  setApprovalMode(mode: ApprovalMode): ApprovalMode
  systemPrompt(target: { chatId: string } | { companionId: string }): SystemPromptView
}

/** Methods the agent tools add to the `chats` namespace. `continue(id)` also resumes stopped or interrupted children. */
export interface PrivateChatsMethods {
  /** Drops a private chat; nothing of it was ever saved. */
  discard(id: string): void
}

export interface AgentSitesService {
  overview(): PermissionsOverview
  setSite(origin: string, access: SiteAccess): SiteRule
  removeSite(origin: string): void
  revokeChat(chatId: string): void
}

/** New namespaces of the agent tools (the `usage` namespace comes from ./usage). */
export interface AgentToolsServices {
  agentSites: AgentSitesService
}

/** AppEvent additions of the agent tools. */
export type AgentToolsAppEvent =
  | { type: 'agent-mode'; mode: ApprovalMode }
  | { type: 'agent-sites'; rules: SiteRule[] }
  | { type: 'usage'; at: number }

// ST-13: the page merges main's overview with the connectors and the shared folders

/** Saved permissions as the page lists them. */
export interface SavedPermissionsView {
  connectors: PermissionsOverview['connectors']
  toolPolicies: Array<PermissionsOverview['toolPolicies'][number] & { connectorName: string }>
  sites: SiteRule[]
  folders: WatchedFolder[]
  chats: PermissionsOverview['chats']
}

/**
 * What Saved permissions shows. Main's overview wins where a feature registered
 * its source; otherwise the connectors list gives connectors and the tool
 * policies that differ from their default, and folders.list gives folders.
 * Sites go newest first, chats by most approvals.
 */
export function savedPermissionsView(
  overview: PermissionsOverview,
  connectors: ReadonlyArray<Pick<ConnectorV2, 'id' | 'name' | 'displayName' | 'enabled' | 'execution' | 'tools'>> | null,
  folders: readonly WatchedFolder[] | null,
): SavedPermissionsView {
  const nameOf = new Map((connectors ?? []).map((c) => [c.id, c.displayName || c.name]))
  for (const c of overview.connectors) if (!nameOf.has(c.id)) nameOf.set(c.id, c.name)
  const listed = overview.connectors.length > 0 || !connectors ? overview.connectors : connectors.map((c) => ({ id: c.id, name: c.displayName || c.name, enabled: c.enabled }))
  const policies = overview.toolPolicies.length > 0 || !connectors
    ? overview.toolPolicies
    : connectors.flatMap((c) => c.tools.filter((tool) => tool.policy !== defaultPolicy(tool, c.execution)).map((tool) => ({ connectorId: c.id, tool: tool.name, policy: tool.policy })))
  return {
    connectors: [...listed].sort((a, b) => a.name.localeCompare(b.name)),
    toolPolicies: policies.map((p) => ({ ...p, connectorName: nameOf.get(p.connectorId) ?? p.connectorId })),
    sites: [...overview.sites].sort((a, b) => b.updatedAt - a.updatedAt || a.origin.localeCompare(b.origin)),
    folders: [...(folders ?? overview.folders)].sort((a, b) => a.name.localeCompare(b.name)),
    chats: overview.chats.filter((c) => c.grants > 0).sort((a, b) => b.grants - a.grants || a.title.localeCompare(b.title)),
  }
}

/** A site rule's origin as people read it: "shop.example", or the host and port. */
export function siteLabel(origin: string): string {
  return siteName(origin)
}
