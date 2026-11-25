/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The agent feature module (`agentTools` in FEATURES): the request protocol,
// approval modes, saved site rules, the usage ledger, private chats,
// delegation and the prompt viewer. It installs this runtime on the
// agent host, so every session (either engine) asks, counts down, refuses
// blocked sites and records its turns the same way.
import { deviceSteps } from '../decisions/device'
import { registerBrowserSteps } from './tools/browserSteps'
import { join } from 'node:path'
import type { AgentToolsMethods, AgentSitesService, PrivateChatsMethods, PermissionsOverview, SiteAccess } from '@shared/agentTools'
import { chatUrl } from '@shared/url'
import type { UsageService } from '@shared/usage'
import { CompanionFiles } from '../companionFiles'
import { dialogs } from '../dialogs'
import type { AppContext, Feature, ServiceParts } from '../features/types'
import { mainT } from '../i18n/mainT'
import { chatIdOf } from '../tabState'
import { UsageLedger, NO_CHAT } from '../usage'
import { ApprovalModeState } from './approvals'
import { Delegations } from './delegation'
import { PrivateCloseGuard, installPrivateClose, privateCloseSpec } from './privateClose'
import type { AgentToolsRuntime } from './sessionAgentTools'
import { ruleOrigin, SiteRulesStore } from './sitePolicy'
import { registerAgentClientTools, type AgentToolDeps } from './tools/agentTools'
import { setUsageSink } from './usageSink'

/** Registers the agent's client tools (ask_user_questions, update_plan, delegate_task, companion_files). */
export function registerAgentTools(deps?: AgentToolDeps): void {
  if (deps) registerAgentClientTools(deps)
}

// ── Sources other features register (index.ts or the owning feature wires them) ──

type PermissionSources = Partial<Pick<PermissionsOverview, never>> & {
  connectors?(): PermissionsOverview['connectors']
  toolPolicies?(): PermissionsOverview['toolPolicies']
  folders?(): PermissionsOverview['folders']
}
const permissionSources: PermissionSources = {}

/** Connectors (and their tool policies) and the workspace (folder grants) feed Saved permissions. */
export function registerPermissionSources(sources: PermissionSources): void {
  Object.assign(permissionSources, sources)
}

let projectLookup: ((id: string) => { name: string; instructions: string } | null) | null = null

/** A project's name and instructions, for the system prompt of chats in it. */
export function registerProjectLookup(lookup: (id: string) => { name: string; instructions: string } | null): void {
  projectLookup = lookup
}

function safe<T>(read: (() => T) | undefined, fallback: T): T {
  try {
    return read ? read() : fallback
  } catch {
    return fallback
  }
}

const USAGE_EVENT_MS = 2000

export function createAgentFeatures(): Feature {
  let ledger: UsageLedger | null = null
  let privateClose: PrivateCloseGuard | null = null
  let host: AppContext['agent'] | null = null
  return {
    name: 'agentTools',
    app(ctx: AppContext): ServiceParts {
      const sites = new SiteRulesStore(join(ctx.dataDir, 'agent-site-rules.json'), { defaultAccess: () => ctx.settings.get().siteAccessDefault })
      const mode = new ApprovalModeState(() => ctx.settings.get().approvalMode, (approvalMode) => ctx.settings.update({ approvalMode }))
      const usage = new UsageLedger(join(ctx.dataDir, 'usage.sqlite'))
      ledger = usage
      const delegations = new Delegations(ctx.agent.delegationHost())
      const runtime: AgentToolsRuntime = {
        mode: () => mode.get(),
        sites,
        recordUsage: (row) => usage.record(row),
        delegations,
        flags: () => ctx.settings.get().flags ?? {},
        project: (id) => safe(() => projectLookup?.(id) ?? null, null),
        isRunning: (id) => ctx.agent.isRunning(id),
      }
      ctx.agent.installAgentTools(runtime, {
        quick: ctx.quick,
        // The chat panel's opener doesn't take a chat id yet, so a chat opens as a page.
        open: (chatId) => ctx.windows.focused()?.tabs.openInternal(chatUrl(chatId), { newTab: true }),
      })
      setUsageSink((row) => usage.record({ ...row, at: row.at ?? Date.now() }))
      host = ctx.agent
      // CH-30: a private chat that ended stays ended: its tab never goes back on the reopen stacks (⇧⌘T) or into a saved window.
      const ended = new Set<string>()
      const discardPrivate = (id: string): void => {
        ctx.agent.discardPrivate(id)
        ended.add(id)
      }
      ctx.windows.setEphemeral((url) => {
        const id = chatIdOf(url)
        return id !== null && (ended.has(id) || ctx.agent.privateState(id) !== null)
      })
      // CH-30: closing a tab or window that holds a private chat with content asks first (not in smoke runs).
      privateClose = ctx.smoke
        ? null
        : new PrivateCloseGuard({
            privateState: (id) => ctx.agent.privateState(id),
            viewing: () => ctx.agent.viewing(),
            openTabs: () => ctx.tabsRegistry.all().map((t) => ({ id: t.id, internalUrl: t.internalUrl, windowId: ctx.tabsRegistry.windowOf(t.id) ?? -1 })),
            discard: discardPrivate,
            ask: (win) => dialogs.show(win, privateCloseSpec()).then((result) => result.button === 'confirm'),
          })
      installPrivateClose(privateClose)
      registerAgentTools({ delegate: (input, toolCtx) => delegations.run(input, toolCtx), companionFiles: new CompanionFiles(ctx.dataDir) })
      // docs/decisions.md › Browser tasks: atelier-step takes a browser task page by page, through this chat's own browser steps.
      registerBrowserSteps({ browser: (chatId) => ctx.agent.browserFor(chatId), steps: deviceSteps })

      mode.on('changed', (next) => ctx.broadcast({ type: 'agent-mode', mode: next }))
      ctx.settings.on('changed', () => mode.storedChanged())
      sites.on('changed', (rules) => ctx.broadcast({ type: 'agent-sites', rules }))
      // One usage event every couple of seconds at most, however fast turns come in.
      let usageTimer: NodeJS.Timeout | null = null
      usage.onRecorded((at) => {
        if (usageTimer) return
        usageTimer = setTimeout(() => {
          usageTimer = null
          ctx.broadcast({ type: 'usage', at })
        }, USAGE_EVENT_MS)
        usageTimer.unref?.()
      })
      const chats = safe(() => ctx.maintenance.chats, null)
      chats?.on('removed', (ids) => sites.forgetChats(ids))

      const labelFor = (groupBy: Parameters<UsageService['report']>[1]) => (key: string): string => {
        if (groupBy === 'chat') return key === NO_CHAT ? mainT('agent.usage.noChat') : (chats?.summary(key)?.title ?? mainT('agent.usage.deletedChat'))
        if (groupBy === 'companion') return key === NO_CHAT ? mainT('agent.usage.noCompanion') : (safe(() => ctx.agent.companionLook(key), null)?.id === key ? ctx.agent.companionLook(key).name : mainT('agent.usage.removedCompanion'))
        if (groupBy === 'kind') return mainT(`agent.usage.kind.${key}` as Parameters<typeof mainT>[0])
        return key
      }

      const agent: AgentToolsMethods = {
        respond: (chatId, requestId, response) => ctx.agent.respond(chatId, requestId, response),
        approvalMode: () => mode.get(),
        setApprovalMode: (next) => mode.set(next),
        systemPrompt: (target) => ctx.agent.systemPromptView(target),
      }
      const chatsMethods: PrivateChatsMethods & { continue(id: string): void } = {
        discard: discardPrivate,
        // Extends the chat's Continue: a stopped or interrupted sub-task resumes too.
        continue: (id) => ctx.agent.continueChat(id),
      }
      const agentSites: AgentSitesService = {
        overview: () => ({
          connectors: safe(permissionSources.connectors, []),
          toolPolicies: safe(permissionSources.toolPolicies, []),
          sites: sites.list(),
          folders: safe(permissionSources.folders, []),
          chats: sites.chatGrants().flatMap(({ chatId, grants }) => {
            const summary = chats?.summary(chatId)
            return summary ? [{ chatId, title: summary.title, grants }] : []
          }),
        }),
        setSite: (origin: string, access: SiteAccess) => sites.set(origin, access),
        removeSite: (origin) => {
          if (!ruleOrigin(origin)) throw new Error('Site rules are for web addresses (http or https).')
          sites.remove(origin)
        },
        revokeChat: (chatId) => ctx.agent.revokeChat(chatId),
      }
      const usageService: UsageService = {
        report: (range, groupBy) => usage.report(range, groupBy, labelFor(groupBy)),
        chat: (chatId) => usage.chat(chatId),
      }
      return { agent, chats: chatsMethods, agentSites, usage: usageService }
    },
    window(win): ServiceParts | void {
      privateClose?.watch(win) // CH-30
      const agent = host
      if (!agent) return
      // CH-30: each window's chrome and overlays report what their surfaces show, so main knows which window's
      // side panel shows which chat. A reloaded chrome reports again; a closed window shows nothing.
      win.chrome.on('did-start-loading', () => agent.clearViewing(win.id))
      win.window.once('closed', () => agent.clearViewing(win.id))
      return { chats: { setViewing: (surface, chatId) => agent.setViewing(surface, chatId, win.id) } }
    },
    dispose() {
      installPrivateClose(null)
      setUsageSink(null)
      ledger?.close()
      ledger = null
    },
  }
}
