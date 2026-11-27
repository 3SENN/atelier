/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings registry (ST-06): every Settings key, registered
// exactly once with its scope. 'app' keys are one value for the whole app;
// 'profile' keys are stored per profile, so a theme or search engine can
// differ between Work and Home. Nested keys use dotted paths
// ('sidebar.destinations.files'). Every key is registered here;
// each feature adds its own inside its own region.
import { z } from 'zod'
import { SIDEBAR_APPS_MAX, type SidebarAppPin } from './sidebarApps'
import { ENGINES } from './engine'
import { EXTRA_ENGINE_SETTINGS } from '@engines/shared'
import { DECISIONS_DEFAULTS, DECISIONS_SETTINGS_SCHEMA, type DecisionsSettings } from './decisions'
import { AVATAR_MAX, CHAT_ROWS_DEFAULT, PANEL_WIDTH, SIDEBAR_WIDTH } from './ipc'
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from './notifications'
import { PROFILE_HUE_IDS, DEFAULT_PROFILE_HUE } from './profile'
import { ACCENT_CHOICES, PACK_ACCENT_PATTERN, type PackAccentChoice } from './theme'
import { SITE_PERMISSIONS, type SitePermission } from './sites'
import { COOKIE_LIST_IDS, type CookieListId } from './privacyPack' // privacy pack
import { READER_FONTS, READER_RATE, READER_TEXT_SIZE, READER_THEMES, READER_WIDTHS } from './readerPrefs' // reader
import { TRANSLATE_DEFAULTS, TRANSLATE_SETTINGS_SCHEMA, type TranslateSettings } from './translate' // translate

export type SettingScope = 'app' | 'profile'

export interface SettingDef<T> {
  key: string
  scope: SettingScope
  schema: z.ZodType<T>
  default: T
}

type SettingInput = { scope: SettingScope; schema: z.ZodType; default: unknown }
type Registry<M extends Record<string, SettingInput>> = { readonly [K in keyof M & string]: SettingDef<z.output<M[K]['schema']>> & { key: K } }

/**
 * Builds the registry from `{ key: { scope, schema, default } }`. An object
 * literal can't repeat a key, which keeps every key registered once; a
 * default its own schema rejects throws at load, so a typo fails every test.
 */
export function defineSettings<M extends Record<string, SettingInput>>(map: M): Registry<M> {
  const out: Record<string, SettingDef<unknown>> = {}
  for (const [key, def] of Object.entries(map)) {
    if (!def.schema.safeParse(def.default).success) throw new Error(`Setting ${key}: the default fails its own schema.`)
    out[key] = { key, scope: def.scope, schema: def.schema, default: def.default }
  }
  return Object.freeze(out) as Registry<M>
}

/** The models Atelier offers. */
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] as const

const absolutePath = z.string().trim().min(1).max(1024).regex(/^\//).refine((p) => !p.includes('\0')).nullable()
const engineId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const byCategory = <T>(value: T): Record<NotificationCategory, T> => Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, value])) as Record<NotificationCategory, T>

export const SETTINGS = defineSettings({
  profileHue: { scope: 'profile', schema: z.enum(PROFILE_HUE_IDS), default: DEFAULT_PROFILE_HUE },
  // Moved here from main/settings.ts; it builds its schema and defaults from these
  // App scope: the agent, the account and engine, the panel, the interface and the machine.
  model: { scope: 'app', schema: z.enum(MODELS), default: 'claude-opus-5-5' },
  effort: { scope: 'app', schema: z.enum(['low', 'medium', 'high', 'xhigh', 'max']), default: 'high' },
  confirmConsequentialActions: { scope: 'app', schema: z.boolean(), default: true },
  /** CH-14: runs go on until they finish or you press Stop, instead of pausing for Continue after MAX_STEPS steps. */
  unlimitedSteps: { scope: 'app', schema: z.boolean(), default: false },
  webTools: { scope: 'app', schema: z.boolean(), default: true },
  memory: { scope: 'app', schema: z.boolean(), default: true },
  onboarded: { scope: 'app', schema: z.boolean(), default: false },
  userName: { scope: 'app', schema: z.string().trim().max(40), default: '' },
  /** Your details (the wallet's address marked as yours, Settings › You) go into new chats' instructions, never private ones. */
  shareDetails: { scope: 'app', schema: z.boolean(), default: true },
  userAvatar: { scope: 'app', schema: z.string().max(AVATAR_MAX).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/).nullable(), default: null },
  reduceMotion: { scope: 'app', schema: z.boolean(), default: false },
  engine: { scope: 'app', schema: z.enum(ENGINES), default: 'api-key' },
  // The settings of the engines a build adds (src/shared/engine.ts).
  ...EXTRA_ENGINE_SETTINGS,
  externalAccess: { scope: 'app', schema: z.boolean(), default: false },
  externalTabs: { scope: 'app', schema: z.enum(['own', 'any']), default: 'own' },
  /** Settings › Quick decisions (docs/decisions.md): an optional decision model; off keeps Atelier's own rules. */
  decisions: { scope: 'app', schema: DECISIONS_SETTINGS_SCHEMA, default: DECISIONS_DEFAULTS as DecisionsSettings },
  monthlyBudgetUsd: { scope: 'app', schema: z.number().finite().min(1).max(100_000).nullable(), default: null },
  panelWidth: { scope: 'app', schema: z.number().int().min(PANEL_WIDTH.min).max(PANEL_WIDTH.max), default: PANEL_WIDTH.default },
  panelDock: { scope: 'app', schema: z.enum(['right', 'left']), default: 'right' },
  warnBeforeQuit: { scope: 'app', schema: z.boolean(), default: true },
  confirmCloseTabs: { scope: 'app', schema: z.boolean(), default: true },
  keepAwake: { scope: 'app', schema: z.boolean(), default: false },
  autoPictureInPicture: { scope: 'app', schema: z.boolean(), default: true },
  mediaCard: { scope: 'app', schema: z.boolean(), default: false },
  nowPlayingButton: { scope: 'app', schema: z.boolean(), default: true }, // MD-01
  tabSleepMinutes: { scope: 'app', schema: z.number().int().min(5).max(1440).nullable(), default: 120 },
  memorySaver: { scope: 'app', schema: z.boolean(), default: true }, // resourceSaver.ts
  energySaver: { scope: 'app', schema: z.boolean(), default: true },
  proxy: {
    scope: 'app',
    schema: z.object({ mode: z.enum(['system', 'direct', 'manual', 'pac']), http: z.string().max(512), https: z.string().max(512), socks: z.string().max(512), pacUrl: z.string().max(2048), bypass: z.string().max(2048) }).strict(),
    default: { mode: 'system', http: '', https: '', socks: '', pacUrl: '', bypass: '<local>' },
  },
  downloadDir: { scope: 'app', schema: absolutePath, default: null },
  askWhereToSave: { scope: 'app', schema: z.boolean(), default: false },
  showReasoning: { scope: 'app', schema: z.boolean(), default: false },
  density: { scope: 'app', schema: z.enum(['comfortable', 'compact']), default: 'comfortable' },
  fontSize: { scope: 'app', schema: z.number().int().min(12).max(16), default: 13 },
  uiZoom: { scope: 'app', schema: z.number().finite().min(0.3).max(1), default: 1 },
  chatZoom: { scope: 'app', schema: z.number().finite().min(0.3).max(2), default: 1 },
  notifications: {
    scope: 'app',
    schema: z.object({ enabled: z.boolean(), categories: z.object(byCategory(z.boolean())).strict(), sounds: z.boolean() }).strict(),
    default: { enabled: true, categories: byCategory(true), sounds: false },
  },
  dockIcon: {
    scope: 'app',
    schema: z.discriminatedUnion('kind', [z.object({ kind: z.literal('standard') }).strict(), z.object({ kind: z.literal('companion'), companionId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict()]),
    default: { kind: 'standard' } as { kind: 'standard' } | { kind: 'companion'; companionId: string },
  },
  // Profile scope: how a profile looks, searches and browses (ST-24, ST-31, ST-35).
  theme: { scope: 'profile', schema: z.enum(['system', 'light', 'dark']), default: 'system' },
  accent: { scope: 'profile', schema: z.union([z.enum(ACCENT_CHOICES), z.string().regex(PACK_ACCENT_PATTERN).transform((v) => v as PackAccentChoice)]), default: 'companion' },
  layout: { scope: 'profile', schema: z.enum(['sidebar', 'horizontal']), default: 'sidebar' },
  sidebarTint: { scope: 'profile', schema: z.boolean(), default: true },
  /** DS-75b: "Companions on New Tab": the other companions wander the floor of the start surfaces. */
  companionFloor: { scope: 'profile', schema: z.boolean(), default: true },
  /** A built-in engine or a custom engine's id (widened from an earlier enum; old values still parse). */
  searchEngine: { scope: 'profile', schema: engineId, default: 'google' },
  customSearchEngines: {
    scope: 'profile',
    schema: z.array(z.object({ id: engineId, name: z.string().trim().min(1).max(60), template: z.string().max(2048).regex(/^https?:\/\/[^\s]*%s/) }).strict()).max(50),
    default: [] as { id: string; name: string; template: string }[],
  },
  searchSuggestions: { scope: 'profile', schema: z.boolean(), default: false },
  // ── new tab search ── (NT-01)
  /** What the new tab's composer does on Enter: ask the companion or search the web. */
  newTabMode: { scope: 'profile', schema: z.enum(['companion', 'web']), default: 'companion' },
  /** Set once a search engine was picked (setup, the new tab or Settings › Search), so the choice is offered only once. */
  searchEngineChosen: { scope: 'profile', schema: z.boolean(), default: false },
  // ── privacy pack settings ── (src/main/privacy: HTTPS-First and cookie banners)
  httpsFirst: { scope: 'profile', schema: z.boolean(), default: true },
  hideCookieBanners: { scope: 'profile', schema: z.boolean(), default: true },
  cookieBannerLists: { scope: 'profile', schema: z.array(z.enum(COOKIE_LIST_IDS)).max(COOKIE_LIST_IDS.length), default: [] as CookieListId[] },
  adblock: { scope: 'profile', schema: z.boolean(), default: true },
  // ── site permission defaults ── (Settings › Privacy › Site permissions; read by src/main/permissions.ts)
  /** A permission missing here asks; 'block' refuses it on every site without a stored answer of its own. */
  sitePermissionDefaults: { scope: 'profile', schema: z.partialRecord(z.enum(SITE_PERMISSIONS as [SitePermission, ...SitePermission[]]), z.enum(['ask', 'block'])), default: {} as Partial<Record<SitePermission, 'ask' | 'block'>> },
  /** Notification requests show as a quiet address-bar chip instead of a prompt. */
  quietNotificationPrompts: { scope: 'profile', schema: z.boolean(), default: false },
  languages: {
    scope: 'profile',
    schema: z.object({ mode: z.enum(['system', 'custom']), list: z.array(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/)).max(10) }).strict(),
    default: { mode: 'system', list: [] as string[] } as { mode: 'system' | 'custom'; list: string[] },
  },
  // ── translate ── (TR-01 to TR-06: the offer, the target, the always and never lists, the companion engine)
  translate: { scope: 'profile', schema: TRANSLATE_SETTINGS_SCHEMA, default: TRANSLATE_DEFAULTS as TranslateSettings },
  blockThirdPartyCookies: { scope: 'profile', schema: z.boolean(), default: false },
  globalPrivacyControl: { scope: 'profile', schema: z.boolean(), default: false },
  clearOnExit: { scope: 'profile', schema: z.object({ cookies: z.boolean(), cache: z.boolean(), history: z.boolean() }).strict(), default: { cookies: false, cache: false, history: false } },
  popupBlocking: { scope: 'profile', schema: z.boolean(), default: true },
  bookmarksBar: { scope: 'profile', schema: z.enum(['always', 'newtab', 'never']), default: 'always' },
  showFullUrls: { scope: 'profile', schema: z.boolean(), default: false },
  sidebarWidth: { scope: 'profile', schema: z.number().int().min(SIDEBAR_WIDTH.min).max(SIDEBAR_WIDTH.max), default: SIDEBAR_WIDTH.default },
  // The sidebar options, one leaf each; settings.ts assembles them into Settings.sidebar.
  'sidebar.sections': { scope: 'profile', schema: z.enum(['tabs-and-chats', 'tabs-only']), default: 'tabs-and-chats' },
  'sidebar.chatSort': { scope: 'profile', schema: z.enum(['recent', 'manual', 'progress']), default: 'recent' },
  'sidebar.tabSort': { scope: 'profile', schema: z.enum(['manual', 'recent']), default: 'manual' },
  /** The stamps show only while the pointer is in the sidebar (DS-14). */
  'sidebar.showLastUsed': { scope: 'profile', schema: z.boolean(), default: true },
  'sidebar.chatRows': { scope: 'profile', schema: z.number().int().min(1).max(200).nullable(), default: CHAT_ROWS_DEFAULT as number | null },
  'sidebar.chatsCollapsed': { scope: 'profile', schema: z.boolean(), default: false },
  /** AP-01: how each app shows in the sidebar (row, icon or hidden), in sidebar order; apps not listed start where they say. */
  'sidebar.apps': { scope: 'profile', schema: z.array(z.object({ ref: z.string().min(1).max(400), show: z.enum(['row', 'icon', 'hidden']) }).strict()).max(SIDEBAR_APPS_MAX), default: [] as SidebarAppPin[] },
  'sidebar.destinations.chats': { scope: 'profile', schema: z.boolean(), default: true },
  'sidebar.destinations.routines': { scope: 'profile', schema: z.boolean(), default: true },
  /** In More by default: a companion already works in the sites you have open, so most people never need the row. */
  'sidebar.destinations.connectors': { scope: 'profile', schema: z.boolean(), default: false },
  'sidebar.destinations.skills': { scope: 'profile', schema: z.boolean(), default: true },
  /** Visible by default. */
  'sidebar.destinations.meetings': { scope: 'profile', schema: z.boolean(), default: true },
  /** The optional Files and documents ability (code execution with document skills). Off by default. */
  documents: { scope: 'app', schema: z.boolean(), default: false },
  'sidebar.destinations.files': { scope: 'profile', schema: z.boolean(), default: false },
  // All app scope: early.ts reads them from the app settings.json before
  // ready, and profiles never get their own updater, logs, tray or login item.
  /** Download updates as soon as they are found (otherwise wait for consent). */
  autoDownloadUpdates: { scope: 'app', schema: z.boolean(), default: true },
  /** Keep Crashpad dumps on this computer (never uploaded). Off by default. */
  crashReports: { scope: 'app', schema: z.boolean(), default: false },
  /** Keep running in the menu bar, notification area or tray with no window open. */
  runInBackground: { scope: 'app', schema: z.boolean(), default: false },
  /** The interface language ('system' follows the OS). */
  appLanguage: { scope: 'app', schema: z.enum(['system', 'en', 'nl']), default: 'system' },
  /** Trackpad haptics on split snap (macOS). */
  haptics: { scope: 'app', schema: z.boolean(), default: true },
  /** Pause a meeting recording while the lid is closed. */
  pauseMeetingsOnLidClose: { scope: 'app', schema: z.boolean(), default: true },
  // All app scope; feature state lives in each feature's own files
  /** 'dont-ask' is runtime-only and never stored. */
  approvalMode: { scope: 'app', schema: z.enum(['standard', 'ask-all']), default: 'standard' },
  siteAccessDefault: { scope: 'app', schema: z.enum(['allow', 'ask']), default: 'allow' },
  /** Chat sounds, off by default (NS-03). */
  chatSounds: { scope: 'app', schema: z.boolean(), default: false },
  /** The setup flow's intro sounds. */
  introSounds: { scope: 'app', schema: z.boolean(), default: true },
  /** Tips while a chat works (CH-29). */
  chatTips: { scope: 'app', schema: z.boolean(), default: true },
  /** Atelier://flags values by flag id. */
  flags: { scope: 'app', schema: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), z.string().max(64)), default: {} },
  /** The newer destinations start in the overflow dropdown, so the visible block is DS-06's five rows plus More. */
  'sidebar.destinations.workspace': { scope: 'profile', schema: z.boolean(), default: false },
  'sidebar.destinations.guides': { scope: 'profile', schema: z.boolean(), default: false },
  /** AP-02: Packs, in the overflow dropdown until the person shows it. */
  'sidebar.destinations.packs': { scope: 'profile', schema: z.boolean(), default: false },
  // ── reader settings ── (RD-05: how the reader looks and reads aloud; one choice for every profile)
  readerFont: { scope: 'app', schema: z.enum(READER_FONTS), default: 'serif' },
  readerTextSize: { scope: 'app', schema: z.number().int().min(READER_TEXT_SIZE.min).max(READER_TEXT_SIZE.max), default: READER_TEXT_SIZE.default as number },
  readerWidth: { scope: 'app', schema: z.enum(READER_WIDTHS), default: 'medium' },
  readerTheme: { scope: 'app', schema: z.enum(READER_THEMES), default: 'auto' },
  readerVoice: { scope: 'app', schema: z.string().min(1).max(256).nullable(), default: null as string | null },
  readerRate: { scope: 'app', schema: z.number().finite().min(READER_RATE.min).max(READER_RATE.max), default: READER_RATE.default as number },
  readerButton: { scope: 'app', schema: z.boolean(), default: true },
})

export type SettingKey = keyof typeof SETTINGS

/**
 * The nested groups. Their schemas and defaults stay in
 * src/main/nestedSettings.ts (main registers them with the same defineSettings,
 * as NESTED_SETTINGS_REGISTRY in main/settings.ts); their scopes live here so the renderer
 * knows them too. The autofill switches follow the profile (ST-06); the vault
 * and wallet they fill from are shared by every profile.
 */
export const NESTED_GROUP_SCOPES = { voice: 'app', transcription: 'app', meetingCards: 'app', autofill: 'profile' } as const satisfies Record<string, SettingScope>

const DEFS = SETTINGS as Record<string, SettingDef<unknown> | undefined>

/**
 * A key's scope. A top-level group registered by its leaves ('sidebar') takes
 * its leaves' scope. Unknown keys are app-wide, the safe default for a value
 * that must not split by profile.
 */
export function settingScope(key: string): SettingScope {
  const direct = DEFS[key]?.scope ?? (NESTED_GROUP_SCOPES as Record<string, SettingScope | undefined>)[key]
  if (direct) return direct
  const leaf = Object.keys(SETTINGS).find((k) => k.startsWith(`${key}.`))
  return leaf ? DEFS[leaf]!.scope : 'app'
}

/** Every registered key of one scope, in registration order (leaves as dotted paths, the nested groups last). */
export function settingsOfScope(scope: SettingScope): string[] {
  const keys = Object.values(DEFS).filter((d) => d!.scope === scope).map((d) => d!.key)
  return [...keys, ...Object.entries(NESTED_GROUP_SCOPES).filter(([, s]) => s === scope).map(([k]) => k)]
}

/** The top-level Settings keys of one scope ('sidebar' once, not its leaves). */
export function topLevelKeysOfScope(scope: SettingScope): string[] {
  return [...new Set(settingsOfScope(scope).map((k) => k.split('.')[0]!))]
}
