/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The single source of IPC channel names and payload shapes.
// UI channels connect the browser chrome (renderer) to main. PAGE channels
// connect main to the agent bridge preload inside each tab. Nothing here is
// ever exposed to a web page's own JavaScript world.
import type { EngineId, ExternalTabs } from './engine'
import type { ExtraEngineSettings } from '@engines/shared'
import type { SidebarAppPin } from './sidebarApps'
import type { AppLanguageSetting } from './i18n/locales'
import type { ProfileHue } from './profile'
import type { AccentChoice, ThemePreference, ThemeState } from './theme'
import type { Destination } from './url'
import type { NotificationCategory } from './notifications'
import type { PageErrorKind, SecurityState, SitePermission } from './sites'
import type { CookieListId } from './privacyPack' // privacy pack
import type { LoadStage, TabGroup } from './tabs'
// SS-03: error codes and where a message came from.
import type { ChatErrorCode } from './chatErrors'
import type { MessageSource } from './chats'
import type { AutofillSettings } from './autofill'
import type { GuardKind } from './fields'
import type { MeetingCardSettings } from './meetingCapture'
import type { TranscriptionSettings } from './speech'
import type { VoiceSettings } from './voice'
import type { AttachmentView } from './chats'
import type { AttachmentRef } from './attachments'
import type { LibraryFileRef } from './files'
import type { Profile } from './profiles'
import type { ActionKind, AgentToolsEvent, ApprovalScope, UserMessageSkill } from './agentTools'

export const UI = {
  tabsCreate: 'ui:tabs-create',
  tabsClose: 'ui:tabs-close',
  tabsActivate: 'ui:tabs-activate',
  navigate: 'ui:navigate',
  back: 'ui:back',
  forward: 'ui:forward',
  reload: 'ui:reload',
  stop: 'ui:stop',
  layout: 'ui:layout',
  overlay: 'ui:overlay',
  suggest: 'ui:suggest',
  /** Starts a new chat with its first message; resolves to the chat id. */
  agentStart: 'ui:agent-start',
  agentSend: 'ui:agent-send',
  agentStop: 'ui:agent-stop',
  agentApprove: 'ui:agent-approve',
  settingsGet: 'ui:settings-get',
  settingsSet: 'ui:settings-set',
  apiKeySet: 'ui:api-key-set',
  invoke: 'ui:invoke',
  /** Synchronous: the preload reads the initial state before the chrome renders. */
  initialState: 'ui:initial-state',
  // main -> UI events
  appEvent: 'ui:app-event',
  tabsChanged: 'ui:tabs-changed',
  agentEvent: 'ui:agent-event',
  command: 'ui:command',
  overlayOpen: 'ui:overlay-open',
  overlayUpdate: 'ui:overlay-update',
  overlayClose: 'ui:overlay-close',
  overlayResult: 'ui:overlay-result',
  overlayShow: 'ui:overlay-show',
  overlayHide: 'ui:overlay-hide',
  overlayBounds: 'ui:overlay-bounds',
  overlayResolve: 'ui:overlay-resolve',
  overlayRemoved: 'ui:overlay-removed',
  overlayPrewarm: 'ui:overlay-prewarm',
  /** overlay → main: (instanceId, policy) once a surface mounted; main enforces that policy from then on. */
  overlayMounted: 'ui:overlay-mounted',
  /** overlay → main: (instanceId, 'escape' | 'closed') to dismiss without a value. */
  overlayDismiss: 'ui:overlay-dismiss',
  /** popup strip → main: () asks for the strip's state; main → strip: PopupStripState. */
  popupStrip: 'ui:popup-strip',
  /** CH-40: (chatId, approvalId, { allowed: true, input } | { allowed: false, message? }) for a connector tool call. */
  agentApproveConnector: 'ui:agent-approve-connector',
} as const

export const PAGE = {
  command: 'atelier-page:command',
  reply: 'atelier-page:reply',
  agentState: 'atelier-page:agent-state',
  // Payloads below, zod-validated in main
  /** page → main: ⌥-hover, long-press and ⇧-click on links. */
  links: 'atelier-page:links',
  /** page → main: the page's text selection for the selection chip. */
  selection: 'atelier-page:selection',
  /** page → main, sendSync: alert, confirm and prompt from any frame of the tab. */
  dialog: 'atelier-page:dialog',
  /** page → main: scroll, throttled to about 60 ms. */
  scroll: 'atelier-page:scroll',
  /** main → page: privacy configuration. */
  config: 'atelier-page:config',
  /** page → main: which capture tracks are live ({ camera, microphone, screen }). */
  capture: 'atelier-page:capture',
  /** main → page: the sharing bar's Stop, with the kinds to end. */
  captureStop: 'atelier-page:capture-stop',
  // ── sign-in compatibility page channel ── (window geometry: windowGeometry.ts)
  /** page → main, sendSync: the host window's bounds, asked only while Chromium reports none; main → page: the bounds again as the window moves; page → main 'settled': Chromium has its own now. */
  window: 'atelier-page:window',
  // ── translate page channels ── (TR-07: payloads in shared/translate.ts, zod-validated in main/translate)
  /** page → main: the page's language hints and a text sample (PageLanguageHints). */
  translateHints: 'atelier-page:translate-hints',
  /** main → page: start, restore or send hints again (PageTranslateCommand). */
  translate: 'atelier-page:translate',
  /** page → main, invoke: one batch of texts (PageTranslateBatch → PageTranslateBatchReply). */
  translateBatch: 'atelier-page:translate-batch',
  /** page → main: progress, done, failed, restored (PageTranslateReport). */
  translateReport: 'atelier-page:translate-report',
  // ── tweaks page channels ── (TWK-01: payloads in shared/tweaks.ts, zod-validated in main/tweaks)
  /** page → main: 'get' (sendSync at document start: PageTweakRules | null), and the picker's 'hide', 'undo', 'done' (PageTweakMessage). */
  tweaks: 'atelier-page:tweaks',
  /** main → page: new rules, picking on or off, the picker's count (PageTweakPush). */
  tweaksPush: 'atelier-page:tweaks-push',
  // ── permissions pass page channel ── (preload/page/permissionStatus.ts)
  /** page → main, sendSync at document start: this frame's permission states (QueryStates in shared/permissions.ts); main → page: the states again when an answer changes. */
  permissions: 'atelier-page:permissions',
} as const

export interface TabInfo {
  id: string
  title: string
  url: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  agentControlled: boolean
  /** The chat whose agent controls this tab, while one does. */
  agentChatId: string | null
  /** The tab's chat is waiting for an approval or an answer. */
  needsInput: boolean
  /** Pinned tabs come first in `TabsSnapshot.tabs`, survive restarts and are skipped by bulk close. */
  pinned: boolean
  /** Playing sound right now (even when muted). */
  audible: boolean
  muted: boolean
  /** When the tab was last activated (ms since epoch); drives the recent-activity sort. */
  lastActiveAt: number
  /** Breadcrumb for atelier:// pages ("Chat", "<title>"); null for websites and the new tab. */
  crumbs: string[] | null
  windowId: number
  loadStage: LoadStage
  loadStartedAt: number | null
  zoomPercent: number
  groupId: string | null
  sleeping: boolean
  restoring: boolean
  security: SecurityState
  capture: { camera: boolean; microphone: boolean; screen: boolean }
  pageError: { kind: PageErrorKind; code: number; url: string } | null
  crashed: boolean
  unresponsive: boolean
  // ── translate tab info ── (TR-01: the pill's translate button; absent or null when the page offers nothing)
  translate?: import('./translate').TabTranslate | null
  // ── reader tab info ── (RD-03: the pill's reader button; absent when the page isn't an article)
  reader?: import('./reader').ReaderTabState
  // ── permissions pass tab info ── (the pill's permission chips: this page load's refused and held-back requests)
  permissionActivity?: import('./sites').PermissionActivity[]
}

/** A destination shown on the window-level surface (DS-99): its address, title and breadcrumb. */
export interface RailState {
  url: string
  title: string
  crumbs: string[]
}

export interface TabsSnapshot {
  /** Main's manual order: pinned tabs first, then the rest. */
  tabs: TabInfo[]
  activeId: string | null
  split: { primaryId: string; secondaryId: string } | null
  /** How many closed tabs ⇧⌘T can bring back. */
  closedCount: number
  /**
   * A destination (All chats, Routines, Skills, Connectors) shown over the
   * content area instead of a tab. The active tab stays as it was, hidden,
   * and comes back when any tab or chat is chosen. Null while a tab shows.
   */
  rail?: RailState | null
  groups: TabGroup[]
  /** Selected tab ids (⌘-click, ⇧-click); empty when only the active tab is. */
  selection: string[]
  /** The left pane's share of the width while split (0.2 to 0.8; even is 0.5). */
  splitRatio?: number
  /** The media card's tab (SH-17), when the setting is on and a background tab plays or was paused from the card. */
  media?: import('./tabs').TabMedia | null
}

/** One entry in the sidebar's visible order (pinned tiles, then chats, then tabs). */
export type OrderEntry = { kind: 'tab'; id: string } | { kind: 'chat'; id: string }

/** Per-window state main keeps; it arrives in the initial state and as 'window' app events. */
export interface WindowState {
  /** The saved open state of the sidebar for this window. The chrome may still hide it when the window is narrow. */
  sidebarOpen: boolean
  /** A custom window name, or null to follow the active tab's title. */
  name: string | null
  /** The window is in native full screen: drop the traffic-light inset. */
  fullScreen: boolean
  /** A page is in HTML full screen: draw no chrome; the page view fills the window. */
  pageFullScreen: boolean
  /** Focus mode (⇧⌘F): draw no chrome, like page full screen, while the window stays as it is. */
  focusMode?: boolean
  /** The window's kind: the toolbar shows the private label in a private window (SH-32). */
  kind?: 'normal' | 'private' | 'popup' | 'chat'
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type SearchEngine = 'google' | 'duckduckgo' | 'bing'
export type LayoutMode = 'sidebar' | 'horizontal'
export type BookmarksBarMode = 'always' | 'newtab' | 'never'
export type SidebarSections = 'tabs-and-chats' | 'tabs-only'
export type ChatSort = 'recent' | 'manual' | 'progress'
export type TabSort = 'manual' | 'recent'
export type PanelDock = 'right' | 'left'

// About a fifth of a 1470 px window (design spec DS-04).
export const SIDEBAR_WIDTH = { min: 220, max: 360, default: 300 } as const
export const PANEL_WIDTH = { min: 320, max: 640, default: 390 } as const
/** Rows the Chats section shows above its divider by default. */
export const CHAT_ROWS_DEFAULT = 5

export interface SidebarOptions {
  /** Which destination rows show; hidden ones collect in the overflow row. */
  destinations: Record<Destination, boolean>
  sections: SidebarSections
  /** 'progress' applies only while both sections show; otherwise treat it as 'recent'. */
  chatSort: ChatSort
  tabSort: TabSort
  /** Show how long ago each chat and tab was used. */
  showLastUsed: boolean
  /** Rows the Chats section shows above the divider; null shows them all. */
  chatRows: number | null
  chatsCollapsed: boolean
  /** AP-01: how each app shows in the sidebar, in sidebar order (sidebarApps.ts). */
  apps: SidebarAppPin[]
}

export interface Settings extends ExtraEngineSettings {
  model: string
  effort: Effort
  /** A built-in engine (SearchEngine) or a custom engine's id; widened from the original enum. */
  searchEngine: string
  // ── new tab search ── (NT-01)
  /** The new tab composer's Enter: ask the companion or search the web; per profile. */
  newTabMode: 'companion' | 'web'
  /** A search engine was picked once (setup, the new tab or Settings › Search). */
  searchEngineChosen: boolean
  // ── privacy pack settings ── (src/main/privacy)
  /** Top-level http:// navigations try https:// first (Settings › Privacy). */
  httpsFirst: boolean
  /** Consent banners are hidden, and refused where the banner has a clear Reject button. */
  hideCookieBanners: boolean
  /** Community cookie-banner lists the person turned on (downloaded, never bundled). */
  cookieBannerLists: CookieListId[]
  adblock: boolean
  // ── site permission defaults ──
  /** A permission missing here asks; 'block' refuses it on every site without a stored answer of its own. */
  sitePermissionDefaults: Partial<Record<SitePermission, 'ask' | 'block'>>
  /** Notification requests show as a quiet address-bar chip instead of a prompt. */
  quietNotificationPrompts: boolean
  confirmConsequentialActions: boolean
  /** CH-14: no step limit; a run goes on until it finishes or you press Stop. Applies from a run's next step. */
  unlimitedSteps: boolean
  /** Settings › Quick decisions (docs/decisions.md). */
  decisions: import('./decisions').DecisionsSettings
  /** Server-side web search and fetch for the agent. Applies to new chats. */
  webTools: boolean
  /** Persistent agent memory (the memory tool). Applies to new chats. */
  memory: boolean
  onboarded: boolean
  /** Sidebar first; an unknown stored value falls back to it. */
  layout: LayoutMode
  /** Sets nativeTheme.themeSource. */
  theme: ThemePreference
  accent: AccentChoice
  /** The address pill shows the full URL instead of the compact host. */
  showFullUrls: boolean
  /** Replaces the old showBookmarksBar boolean (true became 'always', false 'never'). */
  bookmarksBar: BookmarksBarMode
  sidebar: SidebarOptions
  /** Pixels, SIDEBAR_WIDTH.min to .max. */
  sidebarWidth: number
  /** Pixels, PANEL_WIDTH.min to .max. */
  panelWidth: number
  /** The side the panel docks on. */
  panelDock: PanelDock
  /** Your local name: the companion uses it and the sidebar footer shows its initial. */
  userName: string
  /** An optional avatar as a small image data URL (png, jpeg or webp, at most AVATAR_MAX characters). */
  userAvatar: string | null
  /** Your details (the wallet's address marked as yours) go into new chats' instructions; never private ones. */
  shareDetails: boolean
  /** Your own colour for the chrome's ground and footer; never the companion's. */
  profileHue: ProfileHue
  /** Atelier's own Reduce Motion, on top of the system setting: either one stills every animation. */
  reduceMotion: boolean
  /** The engine new chats use (ST-58): your API key, or another engine the build offers. A companion can override it. */
  engine: EngineId
  /** ST-60: MCP clients outside Atelier (Claude Code in a terminal, say) may use its browser tools. Off by default. */
  externalAccess: boolean
  /** ST-60: only the tabs such a session opens ('own'), or any open tab ('any'). */
  externalTabs: ExternalTabs
  /** A monthly budget for your own key, in US dollars, for the footer gauge (DS-18); null for none. */
  monthlyBudgetUsd: number | null
  warnBeforeQuit: boolean
  confirmCloseTabs: boolean
  /** Keeps the Mac awake while a chat or routine runs. */
  keepAwake: boolean
  customSearchEngines: CustomSearchEngine[]
  searchSuggestions: boolean
  autoPictureInPicture: boolean
  mediaCard: boolean
  /** MD-01: the toolbar's now-playing button while something plays. */
  nowPlayingButton: boolean
  /** Minutes before a background tab sleeps; null never. */
  tabSleepMinutes: number | null
  blockThirdPartyCookies: boolean
  globalPrivacyControl: boolean
  clearOnExit: { cookies: boolean; cache: boolean; history: boolean }
  proxy: ProxySettings
  popupBlocking: boolean
  /** null uses the system Downloads folder. */
  downloadDir: string | null
  askWhereToSave: boolean
  showReasoning: boolean
  sidebarTint: boolean
  /** DS-75b: companions on the new tab and empty chats' floor; per profile. */
  companionFloor: boolean
  density: 'comfortable' | 'compact'
  /** Interface text size in px, 12 to 16. */
  fontSize: number
  /** Scale of chrome-drawn pages, 0.3 to 1. */
  uiZoom: number
  /** Scale of chat text, 0.3 to 2. */
  chatZoom: number
  /** Preferred website languages: the system's, or up to 10 BCP-47 tags. */
  languages: { mode: 'system' | 'custom'; list: string[] }
  /** Page translation (TR-01 to TR-06); per profile. */
  translate: import('./translate').TranslateSettings
  notifications: { enabled: boolean; categories: Record<NotificationCategory, boolean>; sounds: boolean }
  dockIcon: { kind: 'standard' } | { kind: 'companion'; companionId: string }
  // Defaults and rules in main/nestedSettings.ts
  voice: VoiceSettings
  transcription: TranscriptionSettings
  autofill: AutofillSettings
  meetingCards: MeetingCardSettings
  /** Download updates as soon as they are found. */
  autoDownloadUpdates: boolean
  /** Keep crash reports on this computer; never uploaded. */
  crashReports: boolean
  /** Keep running with no window open. Login-item state is read from the OS, never stored. */
  runInBackground: boolean
  /** The interface language. */
  appLanguage: AppLanguageSetting
  /** Trackpad haptics (macOS). */
  haptics: boolean
  /** Pause a meeting recording while the lid is closed. */
  pauseMeetingsOnLidClose: boolean
  // Registered with app scope in settingsRegistry.ts
  /** ST-12: 'dont-ask' never reaches disk; launch starts from this. */
  approvalMode: 'standard' | 'ask-all'
  /** What an origin without a saved rule gets. */
  siteAccessDefault: 'allow' | 'ask'
  /** NS-03: chat sounds. */
  chatSounds: boolean
  /** The setup flow's intro sounds. */
  introSounds: boolean
  /** CH-29: tips while a chat works. */
  chatTips: boolean
  /** Atelier://flags values by flag id. */
  flags: Record<string, string>
  // Registered with app scope in settingsRegistry.ts
  /** Files and documents (code execution with document skills). Off by default; applies to new chats. */
  documents: boolean
  // ── reader settings ── (RD-05: registered with app scope in settingsRegistry.ts)
  readerFont: import('./readerPrefs').ReaderFont
  /** Body text size in px. */
  readerTextSize: number
  readerWidth: import('./readerPrefs').ReaderWidth
  readerTheme: import('./readerPrefs').ReaderTheme
  /** A speechSynthesis voiceURI; null picks one for the article's language. */
  readerVoice: string | null
  readerRate: number
  /** The address pill's reader button on article pages. */
  readerButton: boolean
}

export const AVATAR_MAX = 300_000

export interface CustomSearchEngine {
  id: string
  name: string
  /** A URL with %s where the query goes. */
  template: string
}

export type ProxyMode = 'system' | 'direct' | 'manual' | 'pac'

export interface ProxySettings {
  mode: ProxyMode
  http: string
  https: string
  socks: string
  pacUrl: string
  bypass: string
}

/** What atelier.settings.set accepts: any subset, with the sidebar options merged field by field. */
// A patch merges these one level deep
export type NestedSettingsGroup = 'voice' | 'transcription' | 'autofill' | 'meetingCards'

/** What atelier.settings.set accepts: any subset, with the sidebar options and the nested groups merged field by field. */
export type SettingsPatch = Partial<Omit<Settings, 'sidebar' | NestedSettingsGroup>> & {
  sidebar?: Partial<Omit<SidebarOptions, 'destinations'>> & { destinations?: Partial<Record<Destination, boolean>> }
} & { [K in NestedSettingsGroup]?: Partial<Settings[K]> }

export interface SettingsView extends Settings {
  hasApiKey: boolean
  apiKeySource: 'saved' | 'environment' | 'none'
  /** The profile of the window that reads it. Optional until the ProfileManager fills it (the default profile). */
  profile?: Profile
}

export interface Suggestion {
  url: string
  title: string
  kind: 'history' | 'search' | 'url'
}

export type AgentStatus = 'idle' | 'running' | 'awaiting-approval'

export type ToolKind = 'read-page' | 'find' | 'screenshot' | 'click' | 'type' | 'navigate' | 'tabs' | 'web-search' | 'web-fetch' | 'memory' | 'connector' | 'other'

export type AgentEvent =
  | { type: 'status'; status: AgentStatus }
  /** Logged as AttachmentRef; older AttachmentView entries are normalized on load (attachmentViewToRef). */
  | { type: 'user-message'; id: string; text: string; attachments?: AttachmentRef[]; /* SK-04 */ skill?: UserMessageSkill; /* Absent for messages you typed */ source?: MessageSource }
  | { type: 'text-delta'; turnId: string; text: string }
  | { type: 'thinking-delta'; turnId: string; text: string }
  | {
      type: 'tool'
      id: string
      label: string
      state: 'running' | 'done' | 'error'
      detail?: string
      // Optional until every emitter fills them
      kind?: ToolKind
      startedAt?: number
      endedAt?: number
      /** Summaries capped at 2 KB. */
      input?: string
      result?: string
      connector?: { id: string; name: string }
    }
  | { type: 'approval'; approvalId: string; description: string; origin: string; action?: ActionKind; scopes?: ApprovalScope[] }
  | { type: 'approval-resolved'; approvalId: string; allowed: boolean }
  /** SS-03: `code` picks the error card; absent in older logs. */
  | { type: 'error'; message: string; code?: ChatErrorCode; retryAfterMs?: number; /** The raw failure, behind the card's Details. */ details?: string; facts?: import('./chatErrors').ChatErrorFacts }
  /** The chat's history was cut (edit and resend, retry): clear it; the kept log is replayed right after. */
  | { type: 'reset' }
  | { type: 'step-limit'; turnId: string; steps: number }
  | { type: 'stopped'; turnId: string | null; reason: 'user' | 'interrupt' | 'error' }
  | { type: 'interrupting' }
  // AgentLog.ts folds each into a LogItem, all kept in the saved log
  | { type: 'compaction'; id: string; state: 'running' | 'done' | 'failed'; trigger: 'auto' | 'manual'; summary?: string; replacedTokens?: number; thresholdTokens?: number }
  | { type: 'suggestions'; id: string; turnId: string; heading: string | null; items: string[] }
  | { type: 'memory-change'; turnId: string; changes: MemoryChange[] }
  | { type: 'tab-opened'; turnId: string; tabId: string; url: string; title: string }
  | { type: 'file-produced'; turnId: string; file: LibraryFileRef }
  | { type: 'partial'; turnId: string; reason: 'step-limit' | 'stopped' | 'cut-off' | 'error' }
  | { type: 'connector-approval'; approvalId: string; connectorId: string; connectorName: string; tool: string; actionLabel: string; inputSchema: unknown; input: unknown }
  | { type: 'connector-approval-resolved'; approvalId: string; outcome: 'confirmed' | 'declined'; edited: boolean }
  | { type: 'connector-needed'; id: string; turnId: string; directoryId: string | null; service: string; reason: string }
  // Requests, plans, delegation, cards and sources; see AgentToolsEvent
  | AgentToolsEvent

/** One memory file a turn touched, for the memory-change card. */
export interface MemoryChange {
  op: 'saved' | 'updated' | 'forgotten' | 'renamed'
  path: string
  owner: string
  /** The new path of a rename. */
  to?: string
}

/**
 * Commands main sends to the chrome from menus and shortcuts.
 * 'new-chat': ⇧⌘E, open a fresh chat in the side panel beside the page.
 * 'reload-page': ⌘R on an atelier:// page or the new tab; remount that page.
 */
export type MenuCommand = 'focus-omnibox' | 'toggle-agent' | 'find' | 'new-chat' | 'reload-page'
  /** Help › Report a Problem… (⇧⌘H) opens the problem report. */
  | 'report-problem'
  /** Help › What's New reopens the current version's card. */
  | 'whats-new'

/** Everything the chrome needs before its first render, read synchronously by the preload. */
export interface InitialState {
  theme: ThemeState
  settings: SettingsView
  window: WindowState
  tabs: TabsSnapshot
}

/** The in-page "agent is working" overlay's look and text, sent by main (PAGE.agentState). */
export interface AgentOverlay {
  active: boolean
  /** '#rrggbb', readable on the page in the current mode. */
  accent: string
  /** Text colour on the accent. */
  onAccent: string
  label: string
}

// ---- main <-> page bridge ----

export type ReadPageFilter = 'interactive' | 'all'

export type PageCommand =
  | { op: 'readPage'; filter: ReadPageFilter | null; depth: number; ref: string | null }
  | { op: 'find'; query: string }
  | { op: 'getText' }
  | { op: 'resolveRef'; ref: string; scrollIntoView: boolean }
  | { op: 'describePoint'; x: number; y: number }
  | { op: 'describeFocus' }
  | { op: 'formInput'; ref: string; value: string | number | boolean }
  | { op: 'viewport' }
  | { op: 'frame' }
  /** The page as atelier-step reads it (src/shared/browserSteps.ts StepPage): controls and short text lines in page order. */
  | { op: 'stepPage' }

export interface ElementDescription {
  role: string
  name: string
  tag: string
  inputType: string | null
  isPassword: boolean
  isPaymentField: boolean
  /** Accessible name of the submit control of the enclosing form, if any. */
  formSubmitName: string | null
  inForm: boolean
  formHasPaymentFields: boolean
  // Autofill fills it; guarded fields are refused to the agent in every approval mode
  guard?: GuardKind | null
}

export interface ResolvedElement extends ElementDescription {
  /** Center point in CSS pixels relative to the viewport. */
  x: number
  y: number
  /** The element's box in CSS pixels relative to the viewport, for a picture of it (docs/decisions.md › Pictures). */
  box: { x: number; y: number; width: number; height: number }
}

export interface ViewportInfo {
  width: number
  height: number
  scrollX: number
  scrollY: number
}

export interface FormInputResult {
  /** Contenteditable targets are focused and selected; main inserts the text. */
  needsInsertText: boolean
  description: ElementDescription
}

export interface PageRequest {
  requestId: number
  command: PageCommand
}

export type PageReply =
  | { requestId: number; ok: true; result: unknown }
  | { requestId: number; ok: false; error: string }

// What 'ui:command' carries
export type ChromeCommand =
  | MenuCommand
  | 'open-command-bar'
  | 'open-universal-search'
  | 'toggle-sidebar'
  | 'switch-layout'
  | 'bookmark-editor'
  | 'shortcuts-sheet'
  | 'focus-ask'
  | 'main-menu'
  | 'clear-data'
  | 'focus-mode'
  // ⌘F in a chat page or the focused panel
  | 'find-in-chat'

export const PAGE_LINK_HREF_MAX = 8192
export const PAGE_SELECTION_TEXT_MAX = 5000
export const PAGE_SELECTION_LINKS_MAX = 20
export const PAGE_DIALOG_MESSAGE_MAX = 10_000

export interface PageRect {
  x: number
  y: number
  width: number
  height: number
}

/** PAGE.links. */
export interface PageLinkMessage {
  kind: 'alt-hover' | 'long-press' | 'shift-click' | 'leave'
  href: string
  rect: PageRect
}

/** PAGE.selection. */
export type PageSelectionMessage = { text: string; rect: PageRect; links: string[]; url: string } | { cleared: true }

/** PAGE.dialog, sent with sendSync; main answers boolean (confirm), string or null (prompt), or nothing (alert). */
export interface PageDialogMessage {
  kind: 'alert' | 'confirm' | 'prompt'
  message: string
  defaultValue?: string
}

export type PageDialogReply = boolean | string | null

/** PAGE.scroll. */
export interface PageScrollMessage {
  scrollX: number
  scrollY: number
}

/** PAGE.config. */
export interface PageConfig {
  gpc: boolean
}

/** PAGE.window: the host window's outer frame in screen DIPs, what window.outerWidth/outerHeight/screenX/screenY report. */
export interface PageWindowBounds {
  x: number
  y: number
  width: number
  height: number
}
