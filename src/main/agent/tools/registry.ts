/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The client-tool registry. Tools the
// agent calls that Atelier runs itself, on any engine: the API-key loop
// lists them in `tools`, and an engine that runs the model elsewhere reaches
// the same ones through the local MCP tools server with the same JSON Schemas. A chat
// freezes the chosen names in ChatCapabilities.clientTools at its first
// message and never gains or loses one later, so the cached prefix and
// earlier thinking stay valid. Each feature registers its own tools through a
// register<Feature>Tools(deps) function called by its feature module.
import type { z } from 'zod'
import type { AgentRequestResponse } from '@shared/agentTools'
import type { AgentEvent } from '@shared/ipc'

export type ClientToolGroup = 'chat' | 'routines' | 'skills' | 'workspace' | 'files' | 'tables' | 'apps' | 'calendar' | 'activity' | 'connectors' | /* docs/packs.md: the builder tools and each pack's own tools */ 'packs'

/** What a chat starts with; `enabled()` decides from this alone. */
export interface ToolSetup {
  companionId: string
  browser: boolean
  memory: boolean
  /** A routine or other background run: no tools that wait on you. */
  routine: boolean
  private: boolean
  flags: Record<string, string>
  workspace: { folders: boolean; tables: boolean; apps: boolean; calendar: boolean; activity: boolean }
  /** A delegated sub-task's chat; children never delegate further (depth 1). Absent means a top-level chat. */
  child?: boolean
  /** Creator mode (docs/apps.md › Creator mode): the chat builds packs and apps, so the builder tools are on. */
  creator?: boolean
}

/** The builder tool whose place in a chat's frozen list marks a Creator chat (chats from before the mode have it too). */
export const CREATOR_TOOL = 'create_pack'

/** Events a tool may wait on through `ask`: every member with a requestId, plus the auto-approval countdown. */
export type AskableEvent = Extract<AgentEvent, { requestId: string }> | Extract<AgentEvent, { type: 'auto-approval' }>

export interface ClientToolContext {
  chatId: string
  companionId: string
  isPrivate: boolean
  isRoutine: boolean
  /** Aborts on Stop; a waiting `ask` then resolves as stopped. */
  signal: AbortSignal
  emit(event: AgentEvent): void
  /** Appends the request to the log, marks the chat as waiting and resolves through agent.respond. */
  ask<R extends AgentRequestResponse>(event: AskableEvent): Promise<R>
}

export interface ClientToolResult {
  /** Plain text or JSON text, capped at CLIENT_TOOL_RESULT_MAX characters. */
  content: string
  isError?: boolean
  /** Pictures the model looks at after the text (a playtest's frames, say): at most CLIENT_TOOL_IMAGES_MAX, base64. Both engines carry them. */
  images?: Array<{ mediaType: 'image/png' | 'image/jpeg'; data: string }>
  /**
   * The tool changes its chat's setup (creator_mode turns Creator mode on).
   * The tools the new setup turns on join the chat's frozen list, the packs
   * group's only: on the API key at the next step, on an engine that takes
   * tools only at launch in a fresh process that resumes the conversation.
   */
  setup?: { creator?: boolean }
}

/** Pictures one client tool result may carry. */
export const CLIENT_TOOL_IMAGES_MAX = 8

export interface ClientTool<I = unknown> {
  name: string
  group: ClientToolGroup
  description: string
  /** JSON Schema sent to the model (and to other engines through the MCP server). */
  inputSchema: Record<string, unknown>
  /** Validates the model's input; a failure becomes an is_error result naming the field. */
  parse: z.ZodType<I>
  enabled(setup: ToolSetup): boolean
  run(input: I, ctx: ClientToolContext): Promise<ClientToolResult>
}

export const CLIENT_TOOL_RESULT_MAX = 50_000

/** Exact names and owners. suggest_next_steps, save_artifact and suggest_connector keep their names and behaviour. */
export const CLIENT_TOOL_OWNERS = {
  ask_user_questions: 'plans',
  update_plan: 'plans',
  delegate_task: 'plans',
  /** CO-08: read-only access to the chat's own companion folder. */
  companion_files: 'plans',
  propose_routine: 'routines and skills',
  list_routines: 'routines and skills',
  draft_skill: 'routines and skills',
  read_skill: 'routines and skills',
  search_activity: 'activity',
  search_everything: 'files',
  list_folder: 'files',
  read_file: 'files',
  search_files: 'files',
  write_file: 'files',
  build_app: 'apps, tables and calendar',
  list_tables: 'apps, tables and calendar',
  query_table: 'apps, tables and calendar',
  write_table: 'apps, tables and calendar',
  calendar_events: 'apps, tables and calendar',
  list_reminders: 'apps, tables and calendar',
  suggest_next_steps: 'replies',
  save_artifact: 'replies',
  suggest_connector: 'replies',
  // Packs (docs/packs.md › Companions as builders); each pack's own tools are pk_<id>_<name>.
  create_pack: 'packs',
  write_pack_file: 'packs',
  read_pack_file: 'packs',
  test_pack: 'packs',
  propose_pack: 'packs',
  list_packs: 'packs',
  // Quick decisions (docs/decisions.md › Your companion): many small judgment calls on the decision model.
  label_items: 'decisions',
  // docs/decisions.md › Browser tasks: atelier-step takes a browser task page by page on this computer.
  browser_steps: 'decisions',
} as const

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const registry = new Map<string, ClientTool<unknown>>()

/** Adds a tool. Names are unique; a second registration under the same name is a bug and throws. */
// The registry holds tools of many input types; the type parameter keeps each tool's own typing at its call site.
export function registerClientTool<I = any>(tool: ClientTool<I>): void {
  if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid client tool name "${tool.name}".`)
  if (registry.has(tool.name)) throw new Error(`Client tool "${tool.name}" is already registered.`)
  registry.set(tool.name, tool as ClientTool<unknown>)
}

/** Removes a tool (a pack's tools when the pack turns off or goes). Chats that froze its name leave it out of later requests. */
export function unregisterClientTool(name: string): void {
  registry.delete(name)
}

/** The tools a chat with this setup gets, sorted by name so the request prefix is stable. */
export function clientToolsFor(setup: ToolSetup): ClientTool[] {
  return [...registry.values()].filter((tool) => tool.enabled(setup)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** A tool by its frozen name, for routing a call. */
export function clientTool(name: string): ClientTool | undefined {
  return registry.get(name)
}

/** Tests only: forget every registration. */
export function resetClientToolsForTests(): void {
  registry.clear()
}

// Building the request's tool list, routing calls, and the MCP mirror

/** The MCP tool timeout for other engines: questions and approvals can wait on the person for a long time. */
export const MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60_000

/** The names a new chat freezes at its first message (sorted, like clientToolsFor). */
export function clientToolNames(setup: ToolSetup): string[] {
  return clientToolsFor(setup).map((tool) => tool.name)
}

/** The frozen tools as Messages API custom tools. A name no longer registered is left out, so the request stays valid. */
export function clientToolParams(names: readonly string[]): Array<{ name: string; description: string; input_schema: { type: 'object'; [key: string]: unknown } }> {
  return names.flatMap((name) => {
    const tool = registry.get(name)
    return tool ? [{ name: tool.name, description: tool.description, input_schema: { ...tool.inputSchema, type: 'object' as const } }] : []
  })
}

/** The same tools as MCP tool specs for engines that reach them over MCP, with the same JSON Schemas. */
export function clientToolSpecs(names: readonly string[]): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return clientToolParams(names).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema }))
}

/** Where a zod failure is, in words the model can act on: "questions.0.prompt: Too big". */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'input'}: ${issue.message}`)
    .join('; ')
}

function capResult(content: string): string {
  if (content.length <= CLIENT_TOOL_RESULT_MAX) return content
  return `${content.slice(0, CLIENT_TOOL_RESULT_MAX - 80)}\n… (cut: the result was longer than ${CLIENT_TOOL_RESULT_MAX} characters)`
}

/**
 * Runs one client-tool call: an unknown name or input that fails the tool's
 * zod schema becomes an error result naming the field, and the result is
 * capped. Stop rejects (the caller answers the call as stopped); any other
 * failure is an error result.
 */
export async function runClientTool(name: string, input: unknown, ctx: ClientToolContext): Promise<ClientToolResult> {
  const tool = registry.get(name)
  if (!tool) return { content: `Unknown tool "${name}".`, isError: true }
  const parsed = tool.parse.safeParse(input)
  if (!parsed.success) return { content: `Invalid input for ${name}: ${describeIssues(parsed.error)}`, isError: true }
  ctx.signal.throwIfAborted()
  try {
    const result = await tool.run(parsed.data, ctx)
    const images = (result.images ?? []).filter((i) => (i.mediaType === 'image/png' || i.mediaType === 'image/jpeg') && /^[A-Za-z0-9+/=]+$/.test(i.data)).slice(0, CLIENT_TOOL_IMAGES_MAX)
    return { content: capResult(result.content), ...(result.isError ? { isError: true } : {}), ...(images.length > 0 && !result.isError ? { images } : {}), ...(result.setup && !result.isError ? { setup: { ...(result.setup.creator === true ? { creator: true } : {}) } } : {}) }
  } catch (err) {
    if (ctx.signal.aborted) throw err
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}

// Features report their opt-ins: activity memory, folder grants, calendar access
type WorkspaceSetup = ToolSetup['workspace']
const contributors: Array<(setup: Omit<ToolSetup, 'workspace'>) => Partial<WorkspaceSetup>> = []

/** A feature tells new chats which of its tools apply (for example "this chat may use folders"). Read at each chat's first message. */
export function contributeToolSetup(fn: (setup: Omit<ToolSetup, 'workspace'>) => Partial<WorkspaceSetup>): void {
  contributors.push(fn)
}

/** The workspace part of a new chat's setup: flags first, then each feature's contribution. */
export function workspaceSetup(base: Omit<ToolSetup, 'workspace'>, flagOn: (id: string) => boolean): WorkspaceSetup {
  const out: WorkspaceSetup = { folders: false, tables: flagOn('tables'), apps: flagOn('apps'), calendar: false, activity: false }
  for (const fn of contributors) {
    try {
      Object.assign(out, fn(base))
    } catch {
      // A feature that fails to answer leaves its tools off.
    }
  }
  // Private chats never feed or read activity memory.
  if (base.private) out.activity = false
  return out
}
