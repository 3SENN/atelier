/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import './brandingEarly'
import './diagnostics/early'
import './i18n/early'
import './signInEarly' // sign-in compatibility: FedCM off before Chromium starts
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Notification, app, clipboard, dialog, nativeTheme, safeStorage, session, shell as electronShell, type WebContents } from 'electron'
import { SHARED_OWNER, memoryLocation } from '@shared/chats'
import { COMPANION_FILE_EXTENSION } from '@shared/companion'
import { UI } from '@shared/ipc'
import type { AppEvent, Services } from '@shared/services'
import { AdBlocker } from './adblock'
import { AgentHost } from './agent/host'
import { ChatStore, exportFileName } from './chats'
import { COMPANION_FILE_MAX_BYTES, CompanionStore, FIRST_COMPANION_ID } from './companions'
import { CompanionService } from './companionsService'
import { CompanionFiles } from './companionFiles'
import { SKILL_FILE_EXTENSION, SKILL_FILE_MAX_BYTES, parseSkillMarkdown, skillMarkdown } from './skillFiles'
import { APP_ORIGIN, devRendererUrl, handleAppProtocol, registerAppScheme } from './appProtocol'
import { compatibilityPath, CompanionPresets, dockIconImage, presetsPath, readCompatibility, resetDockIcon, setDockIcon } from './companion'
import { DownloadManager, downloadManager, setProfileDownloadManagers } from './downloads'
import { bookmarkStore, setProfileBookmarkStores } from './bookmarks'
import { eventForProfile, profileThemeState, scopeNamespaces } from './profiles/scope'
import { profileOfWindowId } from './profiles/windowProfiles'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'
import type { ThemeMode, ThemeState } from '@shared/theme'
import { EngineService } from './engines/service'
import { setupFirstWeek } from './firstWeekSetup'
import { HistoryStore } from './history'
import { availableSources, readSource } from './importer'
import type { SpendView } from '@shared/pricing'
import { registerIpc } from './ipc'
import { SpendStore } from './spend'
import { MemoryService, memoryCommandPaths } from './memory'
import { PageBridge } from './pageBridge'
import { PeekManager } from './peek'
import { RoutineRunner, lastReplyOf } from './routines'
import { SERVICE_SCHEMAS, registerServices } from './services'
import { SettingsStore, WindowStateStore } from './settings'
import { agentOverlayLook, setupShell } from './shell'
import { personDetails } from './agent/details'
import { createAppQuickModel, createPersonalWiring } from './personalWiring'
// The HUD previews replies from the same chat events the chrome gets
import { voiceChatTap } from './voice/chatTap'
import { emptyContentRuntime } from './features/contentRuntime'
import { bindPlatformServices } from './apps/feature'
import { bindPacks, openPackFile } from './packs/feature'
import { isPackArchiveName } from '@shared/packs'
import { readJsonFile } from './guides/feature'
import { DIRECTORY } from './connectors/directory'
import { createMaintenanceRuntime } from './features/maintenanceRuntime'
import { attention } from './attention'
import { sandboxSessions } from './features/sandboxSessions'
import { attachSessionInstaller, onProfileSession } from './profiles/service'
// Background mode decides what closing the last window and a login launch do
import { backgroundMode } from './system/background'
import { onSessionEnd } from './system/sessionEnd'
import { runSmoke, smokeUncaught } from './smoke'
import { createSmokeClient } from './smokeClient'
import { BookmarkStore, ConnectorStore, RoutineStore, SkillStore } from './stores'
import { TabManager } from './tabs'
import { PinnedTabsStore } from './tabState'
import { ThemeController } from './theme'
import { createChromeWindow } from './window'
import { core, startCore } from './app'
import { isWindowScopedEvent } from './windows'
// Features plug in through ./features, not lines here
import { commands } from './commands'
import { bindMenuServices, wireMenuSources } from './menuFeature'
import { mergeServices, missingMethods, startFeatures } from './features'
import type { ServiceParts, WindowContext } from './features/types'
import { log } from './log'
import { browserUserAgent } from './userAgent'
import { followIdentityExperiments, watchSignInIdentity } from './signInIdentity'
import { notifyRoutineResult } from './features/settings'
import { setSettingsDeps } from './settingsDeps'
import { OverlayHost } from './overlayHost'
import { uiOriginOf } from '@shared/url'
import { TabRegistry } from './tabRegistry'
import { WindowManager } from './windows'
import { mainT } from './i18n/mainT'
import { appRoot } from './resources'

const smoke = process.env.ATELIER_SMOKE === '1'
if (smoke) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'atelier-smoke-')))
  app.setPath('downloads', mkdtempSync(join(tmpdir(), 'atelier-smoke-downloads-')))
  // Chats in the smoke test talk to an offline stand-in (smokeClient.ts); a
  // placeholder key keeps the UI out of its "no key" state. Nothing is sent.
  process.env.ANTHROPIC_API_KEY = 'smoke-offline'
  // A test host Google's sign-in mode applies to (signInHosts.ts; the smokeBrowser sign-in check). Set before any
  // page process starts, so the page preload sees it too.
  process.env.ATELIER_SMOKE_SIGNIN_HOSTS ??= 'accounts.google.localhost=google'
  // The smoke window usually runs behind other apps. Chromium would mark its
  // pages hidden (occluded) and drop their input, so keep them live.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  // The throwaway profile needs no real keychain. A rebuilt (ad hoc signed)
  // app would otherwise stop at macOS's keychain prompt before any check runs.
  app.commandLine.appendSwitch('use-mock-keychain')
  // Linux CI has no GPU: Chromium blocklists its software GL for WebGL, which the companion draws with.
  // SwiftShader stands in for the smoke run only; a person's Atelier keeps Chromium's own GPU rules.
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('ignore-gpu-blocklist')
    app.commandLine.appendSwitch('enable-unsafe-swiftshader')
    app.commandLine.appendSwitch('use-angle', 'swiftshader')
  }
  // A locked screen still hides every view, so no smoke page is ever put in the background.
  app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false))
  // Electron's default handler shows a blocking dialog; the smoke run records
  // the error as a failed check instead and keeps going (smoke.ts).
  process.on('uncaughtException', (err) => {
    smokeUncaught.push(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
  })
}
// Lets the smoke test's visual check capture both colour schemes. It seeds
// the (throwaway) theme setting, so switching the theme still works.
const smokeTheme = smoke && (process.env.ATELIER_SMOKE_THEME === 'light' || process.env.ATELIER_SMOKE_THEME === 'dark') ? process.env.ATELIER_SMOKE_THEME : null
if (smokeTheme) nativeTheme.themeSource = smokeTheme
const smokeClient = smoke ? createSmokeClient() : null

registerAppScheme()
app.enableSandbox()
// Present as stock Chromium (userAgent.ts): the reduced UA, no Electron or Atelier
// token. Sessions get the same string with their languages (languages.ts).
app.userAgentFallback = browserUserAgent()
// Sign-in compatibility mode: a tab on a 'firefox' sign-in page presents Firefox there (signInIdentity.ts;
// Google's, while Experiments' "Google sign-in: present as Firefox" is on).
app.on('web-contents-created', (_event, contents) => watchSignInIdentity(contents))

if (!smoke && !app.requestSingleInstanceLock()) app.quit()

// Every webContents: links become tabs in their own window, scripted popups get a window with an origin strip; SH-62
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler((details) => core()?.windowOpen(contents, details) ?? { action: 'deny' })
})

// Background mode may keep Atelier running in the tray; otherwise the default quit.
// Windows and Linux decide as the last browser window closes (see lastBrowserWindowWatch below); this
// one then leaves it be.
let allClosedDecided = false
app.on('window-all-closed', () => {
  if (allClosedDecided) return
  backgroundMode.windowAllClosed(() => app.quit())
})

// A double-clicked .ateliercompanion file can arrive before start-up finishes;
// it waits here until the chrome can show the review sheet.
const openedCompanionFiles: string[] = []
let openCompanionFile: ((path: string) => void) | null = null
// Packs (docs/packs.md): a double-clicked .atelierpack waits the same way, then opens its review on atelier://packs.
const openedPackFiles: string[] = []
let openPack: ((path: string) => void) | null = null
app.on('open-file', (event, path) => {
  if (isPackArchiveName(path)) {
    event.preventDefault()
    if (openPack) openPack(path)
    else openedPackFiles.push(path)
    return
  }
  if (!path.toLowerCase().endsWith(`.${COMPANION_FILE_EXTENSION}`)) return
  event.preventDefault()
  if (openCompanionFile) openCompanionFile(path)
  else openedCompanionFiles.push(path)
})

// Links from other apps, once Atelier is the default browser (ON-13). They can
// also arrive before start-up finishes and wait for the first window.
const openedUrls: string[] = []
let openExternalUrl: ((url: string) => void) | null = null
app.on('open-url', (event, url) => {
  // File URLs too, which a Windows or Linux cold start passes on from its command line.
  if (!/^(https?|file):\/\//i.test(url)) return
  event.preventDefault()
  if (openExternalUrl) openExternalUrl(url)
  else openedUrls.push(url)
})

function readCompanionFile(path: string): string {
  if (statSync(path).size > COMPANION_FILE_MAX_BYTES) throw new Error('This companion file is too large to import.')
  return readFileSync(path, 'utf8')
}

void app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  handleAppProtocol(join(__dirname, '../renderer'))
  const webSession = session.fromPartition('persist:atelier-web')
  const settings = new SettingsStore(dataDir)
  // Experiments' "Google sign-in: present as Firefox", applied live (signInIdentity.ts).
  followIdentityExperiments(settings)
  if (smokeTheme) settings.update({ theme: smokeTheme })
  // ATELIER_SMOKE_LANG=nl runs smoke with Atelier in Dutch (pair it with ATELIER_SMOKE_ONLY=layout: the other checks read English).
  if (smoke && process.env.ATELIER_SMOKE_LANG === 'nl') settings.update({ appLanguage: 'nl' })
  const history = new HistoryStore(dataDir)
  const bridge = new PageBridge()
  const bookmarks = new BookmarkStore(dataDir)
  const skills = new SkillStore(dataDir)
  const routines = new RoutineStore(dataDir)
  const connectors = new ConnectorStore(dataDir)
  const presets = new CompanionPresets(presetsPath())
  // The companion list; `get()` without an id is the active companion.
  const companion = new CompanionStore(dataDir, { presets: () => presets.list(), compatibility: () => readCompatibility(compatibilityPath()) })
  // Chats saved before companions had ids belong to the first companion.
  const chats = new ChatStore(dataDir, companion.list()[0]?.id ?? FIRST_COMPANION_ID)
  const memory = new MemoryService(dataDir)

  // ---- shell: theme, window, tabs (F2) ----
  // The accent follows the active companion unless a named hue is chosen.
  const companionAccent = (): string => companion.get().look.colors.accent
  // SH-64: theme and accent are profile settings. nativeTheme is app-wide, so it (and with it
  // websites, popups and floats) follows the profile of the window in front; each window's chrome
  // gets its own profile's theme (broadcastAll below).
  let frontProfile = (): string => DEFAULT_PROFILE_ID
  // The OS mode as last seen while nativeTheme followed it (a profile's light or dark hides it).
  let systemMode: ThemeMode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource === 'system') systemMode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })
  const theme = new ThemeController({
    preference: () => settings.getFor(frontProfile()).theme,
    accentChoice: () => settings.getFor(frontProfile()).accent,
    companionAccent,
  })
  const themeFor = (profileId: string): ThemeState => profileThemeState(settings.getFor(profileId), systemMode, companionAccent())
  const window = createChromeWindow({ preload: join(__dirname, '../preload/ui.js'), mode: theme.state().mode, layout: settings.get().layout })
  // Smoke runs print the chrome's warnings and errors, so a broken render is visible in the log.
  // The chrome keeps drawing (and its companions animating) even when other
  // windows cover it, so screenshots are never a stale frame.
  if (smoke) {
    window.webContents.setBackgroundThrottling(false)
    window.webContents.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') console.log(`[chrome ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    })
  }
  // Window-scoped events go to this window; the rest reach every window and, for theme and settings, their overlays
  let broadcastAll: ((event: AppEvent) => void) | null = null
  const sendEvent = (event: AppEvent): void => {
    if (broadcastAll && !isWindowScopedEvent(event)) return broadcastAll(event)
    if (!window.isDestroyed()) window.webContents.send(UI.appEvent, event)
  }

  let peek: PeekManager | null = null
  const tabs = new TabManager({
    window,
    session: webSession,
    preloadPath: join(__dirname, '../preload/page.js'),
    history,
    bridge,
    onFindResult: (result) => sendEvent({ type: 'find', result }),
    onPeek: (url) => peek?.open(url),
    pinned: new PinnedTabsStore(dataDir),
    windowId: window.id,
    names: {
      chat: (id) => chats.summary(id)?.title ?? null,
      companion: (id) => companion.find(id)?.name ?? null,
    },
    // The overlay shows the companion that owns the tab's chat (the active one if unknown).
    agentOverlay: (tab) => {
      const ownerId = tab.agentChatId ? chats.summary(tab.agentChatId)?.companionId : undefined
      const owner = (ownerId && companion.find(ownerId)) || companion.get()
      return agentOverlayLook({ name: owner.name, accent: owner.look.colors.accent }, theme.state().mode)
    },
  })
  const tabManager = tabs
  peek = new PeekManager(window, webSession, tabManager, (state) => sendEvent({ type: 'peek', state }))
  const peekManager = peek


  const adblock = new AdBlocker(dataDir)
  if (settings.get().adblock && !smoke) {
    adblock.setEnabled(webSession, true).catch((err: unknown) => console.warn('Ad blocking is unavailable:', err))
  }

  const downloads = new DownloadManager(webSession, dataDir, app.getPath('downloads'))

  // ---- agent sessions, chats and companions (F1) ----
  // Memory changes made by the agent refresh the Memory and Files views.
  const agentMemory = {
    execute: async (input: unknown, companionId: string | null): Promise<string> => {
      const output = await memory.execute(input, companionId)
      const owners = new Set(memoryCommandPaths(input).map((path) => (companionId ? memoryLocation(path, companionId).owner : SHARED_OWNER)))
      for (const owner of owners) sendEvent({ type: 'memory', owner })
      return output
    },
  }
  // ---- engines: your API key, and any engine the build adds (ST-58 to ST-60) ----
  // Approvals for a Claude Code session (or another MCP client) outside Atelier: a native prompt that fails closed.
  const askOutside = async (description: string, origin: string, signal: AbortSignal): Promise<boolean> => {
    if (smoke || window.isDestroyed() || signal.aborted) return false
    window.show()
    const waiting = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
    const answer = await dialog
      .showMessageBox(window, {
        type: 'question',
        buttons: [mainT('core.mainIndex.allow'), mainT('core.mainIndex.dontAllow')],
        defaultId: 1,
        cancelId: 1,
        message: description,
        detail: mainT('core.mainIndex.onClaudeCodeIs', { origin }),
        signal: waiting,
      })
      .catch(() => ({ response: 1 }))
    return !waiting.aborted && answer.response === 0
  }
  const engines = new EngineService({
    dataDir,
    home: app.getPath('home'),
    env: process.env,
    platform: process.platform,
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    appRoot: appRoot(),
    smoke,
    settings: () => settings.get(),
    updateSettings: (patch) => settings.update(patch),
    pickFile: async (options) => {
      const picked = await dialog.showOpenDialog(window, { ...options, properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'] })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    retry: (chatId) => agent.retry(chatId),
    apiKeyState: () => {
      const source = settings.view().apiKeySource
      return source === 'none' ? 'missing' : source
    },
    folder: (companionId) => companionFiles.folderFor(companionId),
    openPath: (path) => electronShell.openPath(path),
    outside: {
      box: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptString(text), decrypt: (data) => safeStorage.decryptString(data) },
      executor: { tabs: tabManager, bridge },
      approve: askOutside,
      claim: (tabId) => agent.claimOutside(tabId),
      release: () => agent.releaseOutside(),
    },
  })
  engines.on('changed', (status) => sendEvent({ type: 'engine', status }))
  settings.on('changed', (next, previous) => {
    engines.settingsChanged(next, previous).catch((err: unknown) => {
      console.warn('Engine settings:', err)
      if (next.externalAccess && !previous.externalAccess) settings.update({ externalAccess: false })
    })
  })

  // This month's spend on your own key, for the footer gauge and the main menu (DS-18).
  const spend = new SpendStore(dataDir)
  const spendView = (): SpendView => ({ ...spend.view(), budgetUsd: settings.get().monthlyBudgetUsd })
  spend.on('changed', () => sendEvent({ type: 'spend', view: spendView() }))
  settings.on('changed', (next, previous) => {
    if (next.monthlyBudgetUsd !== previous.monthlyBudgetUsd) sendEvent({ type: 'spend', view: spendView() })
  })

  // One session per chat; every event carries its chat id.
  const agent: AgentHost = new AgentHost({
    spend,
    settings,
    tabs: tabManager,
    bridge,
    memory: agentMemory,
    connectors,
    skills,
    chats,
    companions: companion,
    presets,
    ...(smokeClient ? { client: smokeClient.client } : {}),
    backends: engines.backends,
    // Settings › You: the saved address marked as yours, read when a chat starts (the wallet is there by then).
    details: () => {
      try {
        return personDetails(personalWiring.context.personal.wallet.mine())
      } catch {
        return null
      }
    },
    emit: (envelope) => {
      if (!window.isDestroyed()) window.webContents.send(UI.agentEvent, envelope)
      voiceChatTap.event(envelope)
      // The smoke test answers approval prompts itself (with "deny").
      const { event } = envelope
      if (smoke && event.type === 'approval') setTimeout(() => agent.approve(envelope.chatId, event.approvalId, false), 50)
    },
    onTabOwners: (owners) => sendEvent({ type: 'chat-tabs', owners }),
    onQueue: (chatId, queued) => {
      sendEvent({ type: 'chat-queue', chatId, queued })
      voiceChatTap.queue(chatId, queued)
    },
  })
  // Download events reach the running chats in their next browser_state.
  downloads.on('stateChange', (change) => agent.stateChange(change))
  const companionService = new CompanionService({ store: companion, skills, routines, connectors, memory, trash: (folder) => electronShell.trashItem(folder) })
  const companionFiles = new CompanionFiles(dataDir, { trash: (path) => electronShell.trashItem(path) })
  const idList = (ids: string | string[]): string[] => (Array.isArray(ids) ? ids : [ids])
  /** Owners are 'shared' or a companion that exists. */
  const checkOwner = (owner: string | undefined): string | undefined => {
    if (owner === undefined || owner === SHARED_OWNER || companion.find(owner)) return owner
    throw new Error('That companion no longer exists.')
  }
  // The Dock shows the active companion while its dockIcon is on. The chrome
  // renders it and calls setDockIcon; switching companion or turning it off resets it.
  let dockShownFor: string | null = null
  const syncDockIcon = (): void => {
    const active = companion.get()
    if (dockShownFor && (dockShownFor !== active.id || !active.dockIcon)) {
      resetDockIcon()
      dockShownFor = null
    }
  }

  const routineRunner = new RoutineRunner({
    store: routines,
    run: (routine) => agent.runRoutine(routine),
    // NS-01: routine results go through notifications.notify, by category.
    notify: (routine, run) => notifyRoutineResult(routine, run),
    // DC-07: an "Only tell me if…" condition reads the run's closing reply.
    reply: (chatId) => {
      try {
        return lastReplyOf(chats.load(chatId).log)
      } catch {
        return null
      }
    },
  })

  let pending = false
  const pushTabs = (): void => {
    if (pending) return
    pending = true
    setImmediate(() => {
      pending = false
      if (!window.isDestroyed()) window.webContents.send(UI.tabsChanged, tabManager.snapshot())
    })
  }
  tabManager.on('changed', pushTabs)
  downloads.on('changed', (items) => sendEvent({ type: 'downloads', items }))
  bookmarks.on('changed', (items) => sendEvent({ type: 'bookmarks', items }))
  chats.on('changed', (items) => sendEvent({ type: 'chats', items }))
  routines.on('changed', (items) => sendEvent({ type: 'routines', items }))
  skills.on('changed', (items) => sendEvent({ type: 'skills', items }))
  connectors.on('changed', () => sendEvent({ type: 'connectors', items: connectors.views() }))
  companionFiles.on('changed', (companionId) => sendEvent({ type: 'companion-files', companionId }))
  companion.on('changed', (state) => {
    sendEvent({ type: 'companions', items: state.items, activeId: state.activeId })
    sendEvent({ type: 'companion', profile: companion.get() })
    syncDockIcon()
  })

  const uiUrl = devRendererUrl() ?? `${APP_ORIGIN}/index.html`
  const windowStore = new WindowStateStore(dataDir)
  const shell = setupShell({
    window,
    tabs: tabManager,
    settings,
    windowStore,
    theme,
    uiUrl,
    sendEvent,
    recentChats: () => chats.list().filter((c) => !c.archived && !c.draft).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    // ⌘D only adds; removing a bookmark takes the star.
    addBookmark: () => {
      const tab = tabManager.active()
      const url = tab?.view.webContents.getURL()
      if (tab && url && /^https?:/i.test(url) && !tab.internalUrl && !bookmarks.findByUrl(url)) bookmarks.toggle(url, tab.view.webContents.getTitle(), tab.favicon)
    },
  })
  chats.on('changed', () => shell.namesChanged())
  companion.on('changed', () => shell.companionChanged())

  const importSources = () => availableSources(process.platform, app.getPath('home'), process.env)

  // The one QuickModel for model calls outside chats, on whichever engine the person picked.
  const quick = createAppQuickModel({ dataDir, home: app.getPath('home'), settings, engines, smoke, smokeClient })

  // ---- getting started (atelier://first-week) ----
  const firstWeek = setupFirstWeek({
    dataDir,
    settings,
    companions: companion,
    connectors,
    routines,
    memory,
    history,
    sendEvent,
    isDefaultBrowser: () => app.isDefaultProtocolClient('https'),
    makeDefaultBrowser: () => {
      // An unpackaged run would register the Electron binary itself.
      if (!app.isPackaged) throw new Error(`${BRAND_NAME} can become your default browser once it is installed.`)
      app.setAsDefaultProtocolClient('http')
      app.setAsDefaultProtocolClient('https')
    },
    // Smoke runs never make the starter call; they get the curated starters.
    ...(smoke ? {} : { quick, engines }),
  })

  // The stores Settings › Storage, Import, notifications and the Dock choice work on
  setSettingsDeps({ chats, history, memory, bookmarks, companions: companion, webSession, stopRoutines: () => routineRunner.stop(), signalImport: () => firstWeek.store.signal('import-data') })
  const windowManager = new WindowManager()
  // Windows and Linux: the last browser window closing is the last window closing. Electron would
  // wait for Atelier's helper windows too (the hidden tab-drag ghost, hidden floats), so Atelier ran on with
  // no window and no tray, and the next start found it still there. macOS keeps its Dock behaviour.
  if (process.platform !== 'darwin') {
    let checking = false
    windowManager.onChange(() => {
      if (windowManager.all().length > 0) {
        allClosedDecided = false
        return
      }
      if (checking || allClosedDecided) return
      checking = true
      // On the next turn, as Electron decides: a window opened in the same breath (a tab moved out) still counts.
      setImmediate(() => {
        checking = false
        if (windowManager.all().length > 0 || allClosedDecided) return
        allClosedDecided = true
        backgroundMode.windowAllClosed(() => app.quit())
      })
    })
  }
  // SH-64: every window hears app-wide events as its own profile sees them: its theme and
  // settings, and only its own profile's bookmark and download lists.
  const profileEvents = { theme: themeFor, settings: (id: string) => settings.viewFor(id) }
  const sendToWindows = (event: AppEvent, match: (profileId: string) => boolean = () => true): void => {
    for (const win of windowManager.all()) {
      const profileId = profileOfWindowId(win.id)
      if (win.chrome.isDestroyed() || !match(profileId)) continue
      const own = eventForProfile(event, profileId, profileEvents)
      if (!own) continue
      win.chrome.send(UI.appEvent, own)
      if (own.type === 'theme' || own.type === 'settings') win.overlay.relay(own)
    }
  }
  broadcastAll = (event) => sendToWindows(event)
  // The window in front sets nativeTheme; a theme change in any profile reaches that profile's windows.
  frontProfile = () => profileOfWindowId(windowManager.focused()?.id)
  app.on('browser-window-focus', () => theme.refresh())
  const pushTheme = (match: (profileId: string) => boolean): void => sendToWindows({ type: 'theme', theme: theme.state() }, match)
  settings.on('profileChanged', (id, next, previous) => {
    if (next.theme === previous.theme && next.accent === previous.accent) return
    theme.refresh()
    pushTheme((profileId) => profileId === id)
  })
  // A companion's colour reaches the profiles that follow it even when the front one uses a named hue.
  companion.on('changed', () => {
    if (settings.getFor(frontProfile()).accent !== 'companion') pushTheme((profileId) => settings.getFor(profileId).accent === 'companion')
  })
  const tabsRegistry = new TabRegistry()
  tabManager.on('created', (tab) => tabsRegistry.add(tab, window.id))
  tabManager.on('closed', (tab) => tabsRegistry.remove(tab.id))
  // Floats, QuickModel, notify, signals and the ctx.personal slots; speech replaces the v1 wiring
  const personalWiring = createPersonalWiring({ dataDir, home: app.getPath('home'), settings, engines, theme, companions: companion, atelierWindow: () => window, smoke, smokeClient, quick,
    // ON-13: getting-started signals tick their checklist items.
    onSignal: (id) => firstWeek.store.signal(id === 'transcription-ready' ? 'try-dictation' : id === 'meeting-transcribed' ? 'record-meeting' : id === 'web-searched' ? 'search-web' : 'build-artifact'),
  })
  // Kept so the window factory can reach the profile manager the profiles feature installs.
  const contentRuntime = emptyContentRuntime()
  const stubProfiles = contentRuntime.profiles
  const features = startFeatures({ dataDir, settings, agent, windows: windowManager, tabsRegistry, commands, broadcast: sendEvent, ...personalWiring.context,
    engineStatus: () => engines.status(),
 content: contentRuntime,
 intakeHosts: { bridge, skills },
 workspaceStores: { chats, history, bookmarks, memory, companionFiles, companions: companion },
 skillRoutines: { skills, routines, runner: routineRunner, chats, companions: companion, window: () => (window.isDestroyed() ? null : window), reveal: (path) => electronShell.showItemInFolder(path),
      // The activity timeline, for the "regular morning sites" suggestions (read lazily: the feature starts below).
      timeline: { sites: (q) => features.services.timeline?.sites?.(q) ?? [] } },
 firstRunDeps: {
      companions: { find: (id) => companion.find(id), update: (id, patch) => companion.update(id, patch), activeId: () => companion.activeId() },
      presets: () => presets.list(),
      presetsRaw: () => readJsonFile(presetsPath()),
      startMemoryBuild: (companionId, chatIds) => void features.services.memory?.startJob?.('build', companionId, { chatIds }),
      directoryIds: () => DIRECTORY.map((e) => e.id),
      directory: () => DIRECTORY,
      writeMemory: (path, text) => memory.write(path, text),
    },
 memoryDeps: { memory, history, bridge, companions: companion },
    // The chat store, the routine runner's counts and the attention feed for the tray and the restart card.
    maintenance: createMaintenanceRuntime({
      chats,
      routines: {
        runningCount: () => routineRunner.runningCount(),
        nextRunAt: () => routines.list().reduce<number | null>((soonest, r) => (r.enabled && r.nextRunAt !== null && (soonest === null || r.nextRunAt < soonest) ? r.nextRunAt : soonest), null),
      },
      attention,
    }),
  })
  features.installSession(webSession, { private: false, partition: 'persist:atelier-web' })
  // Profile sessions run the same installers (ProfileManager.sessionFor.2).
  attachSessionInstaller(features.installSession)
  // Each profile session gets its own ad-blocking value (the sites feature's installer covers permissions).
  onProfileSession((profileSession, profile) => {
    if (settings.getFor(profile.id).adblock && !smoke) adblock.setEnabled(profileSession, true).catch((err: unknown) => console.warn('Ad blocking is unavailable:', err))
  })
  // Every other profile keeps its own bookmarks and downloads in
  // its data folder. Its windows' service calls run in its scope (the window factory below), so the
  // stores reached through bookmarkStore() and downloadManager() are its own.
  const profileManager = contentRuntime.profiles !== stubProfiles ? contentRuntime.profiles : null
  const sendToProfile = (profileId: string, event: AppEvent): void => {
    for (const win of windowManager.all()) if (!win.chrome.isDestroyed() && profileOfWindowId(win.id) === profileId) win.chrome.send(UI.appEvent, event)
  }
  const profileDownloads = new Map<string, DownloadManager>()
  if (profileManager) {
    setProfileBookmarkStores((id) =>
      profileManager.get(id)
        ? profileManager.store(id, 'bookmarks', (dir) => {
            const store = new BookmarkStore(dir, { profile: true })
            store.on('changed', (items) => sendToProfile(id, { type: 'bookmarks', items }))
            store.on('tree', (tree) => sendToProfile(id, { type: 'bookmark-tree', tree }))
            return store
          })
        : null,
    )
    setProfileDownloadManagers((id) => profileDownloads.get(id) ?? null)
    onProfileSession((profileSession, profile) => {
      const id = profile.id
      if (id === DEFAULT_PROFILE_ID || profileDownloads.has(id)) return
      const manager = profileManager.store(id, 'downloads', (dir) => new DownloadManager(profileSession, dir, app.getPath('downloads'), { broadcast: (event) => sendToProfile(id, event) }, { profile: true }))
      profileDownloads.set(id, manager)
      manager.on('changed', (items) => sendToProfile(id, { type: 'downloads', items }))
      manager.on('stateChange', (change) => agent.stateChange(change))
    })
    // A deleted profile's downloads stop before its folder goes.
    profileManager.onRemoving((id) => {
      const manager = profileDownloads.get(id)
      for (const item of manager?.list() ?? []) if (item.state === 'progressing') manager?.cancel(item.id)
      manager?.removeAllListeners()
      profileDownloads.delete(id)
    })
  }
  /** A profile window's own services: bookmarks, downloads and address suggestions in its scope, and its history. */
  const profileWindowParts = (win: WindowContext, parts: ServiceParts): ServiceParts => {
    const profileId = profileOfWindowId(win.id)
    if (!profileManager || profileId === DEFAULT_PROFILE_ID) return {}
    const isPrivate = win.kind === 'private'
    const scoped = scopeNamespaces(mergeServices(services, parts), isPrivate ? ['bookmarks', 'omnibox'] : ['bookmarks', 'downloads', 'omnibox'], profileId)
    if (isPrivate) return scoped
    const ownHistory = profileManager.store(profileId, 'history', (dir) => new HistoryStore(dir))
    return mergeServices(scoped, { history: { search: (query, limit) => ownHistory.search(query, limit), remove: (url) => ownHistory.remove(url), clear: () => ownHistory.clear() } })
  }
  // The locked-down sandbox partitions (atelier-preprocess, atelier-artifacts) get the webRequest mux too, so their lockdown holds.
  for (const sandbox of sandboxSessions()) features.installSession(sandbox.session, { private: true, partition: sandbox.partition })
  const firstWindow: WindowContext = {
    id: window.id,
    kind: 'normal',
    window,
    chrome: window.webContents,
    tabs: tabManager,
    peek: peekManager,
    overlay: new OverlayHost(window.id),
    chromeWindow: shell.chrome,
    session: webSession,
    // The window's own events go to its chrome only (sendEvent broadcasts the app-wide ones).
    send: (event) => {
      if (!window.isDestroyed()) window.webContents.send(UI.appEvent, event)
    },
  }
  windowManager.add(firstWindow)
  const windowServices = features.addWindow(firstWindow)

  // The core namespaces; features add theirs and extend these (merged below).
  const a0Services: ServiceParts = {
    spend: { view: spendView },
    // Through the accessors, so a profile window's calls reach its own profile's stores.
    bookmarks: {
      list: () => (bookmarkStore() ?? bookmarks).list(),
      // The star saves the favicon of the tab showing that page, when one does.
      toggle: (url, title) => (bookmarkStore() ?? bookmarks).toggle(url, title, tabManager.all().find((t) => !t.internalUrl && t.view.webContents.getURL() === url)?.favicon ?? null),
      remove: (id) => (bookmarkStore() ?? bookmarks).remove(id),
      rename: (id, title) => {
        const store = bookmarkStore() ?? bookmarks
        const bookmark = store.get(id)
        if (bookmark) store.upsert({ ...bookmark, title: title.trim() || bookmark.url })
      },
    },
    downloads: {
      list: () => (downloadManager() ?? downloads).list(),
      open: (id) => (downloadManager() ?? downloads).open(id),
      showInFolder: (id) => (downloadManager() ?? downloads).showInFolder(id),
      cancel: (id) => (downloadManager() ?? downloads).cancel(id),
      clear: () => (downloadManager() ?? downloads).clear(),
    },
    history: {
      search: (query, limit) => history.search(query, limit),
      remove: (url) => history.remove(url),
      clear: () => history.clear(),
    },
    find: {
      start: (text, forward, findNext) => {
        const wc = tabManager.active()?.view.webContents
        if (wc && text) wc.findInPage(text, { forward, findNext })
      },
      stop: () => tabManager.active()?.view.webContents.stopFindInPage('clearSelection'),
    },
    chats: {
      list: (filter) => chats.query(filter),
      get: (id) => agent.view(id),
      create: (options) => agent.create(options),
      configure: (id, options) => agent.configure(id, options),
      rename: (id, title) => agent.rename(id, title),
      pin: (ids) => void chats.update(idList(ids), { pinned: true }),
      unpin: (ids) => void chats.update(idList(ids), { pinned: false }),
      markRead: (ids) => void chats.update(idList(ids), { unread: false }),
      markUnread: (ids) => void chats.update(idList(ids), { unread: true }),
      markAllRead: () => void chats.update(chats.list().filter((c) => c.unread).map((c) => c.id), { unread: false }),
      archive: (ids) => void chats.update(idList(ids), { archived: true }),
      unarchive: (ids) => void chats.update(idList(ids), { archived: false }),
      duplicate: (id) => chats.duplicate(id),
      export: async (id) => {
        const { title, text } = agent.markdown(id)
        const target = await dialog.showSaveDialog(window, {
          defaultPath: join(app.getPath('documents'), exportFileName(title, 'md')),
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        })
        if (target.canceled || !target.filePath) return null
        writeFileSync(target.filePath, text, 'utf8')
        return target.filePath
      },
      remove: (ids) => {
        agent.discard(idList(ids))
        chats.remove(idList(ids))
      },
      editAndResend: (id, userMessageId, text) => agent.editAndResend(id, userMessageId, text),
      retry: (id, turnId) => agent.retry(id, turnId),
      feedback: (id, turnId, rating, note) => agent.feedback(id, turnId, rating, note),
      details: (id, turnId) => agent.details(id, turnId),
      editQueued: (id, queuedId, text) => agent.editQueued(id, queuedId, text),
      setViewing: (surface, chatId) => agent.setViewing(surface, chatId),
      tabOwners: () => agent.tabOwners(),
    },
    skills: {
      list: () => skills.list(),
      save: (skill) => skills.save({ ...skill, owner: checkOwner(skill.owner) }),
      remove: (id) => skills.remove(id),
      exportFile: async (id) => {
        const skill = skills.get(id)
        if (!skill) throw new Error('That skill no longer exists.')
        const target = await dialog.showSaveDialog(window, {
          defaultPath: join(app.getPath('documents'), exportFileName(skill.name, SKILL_FILE_EXTENSION)),
          filters: [{ name: mainT('core.mainIndex.skill'), extensions: [SKILL_FILE_EXTENSION] }],
        })
        if (target.canceled || !target.filePath) return null
        writeFileSync(target.filePath, skillMarkdown(skill), 'utf8')
        return target.filePath
      },
      importFile: async (owner) => {
        const picked = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: mainT('core.mainIndex.skill'), extensions: [SKILL_FILE_EXTENSION, 'txt'] }] })
        const path = picked.filePaths[0]
        if (picked.canceled || !path) return null
        if (statSync(path).size > SKILL_FILE_MAX_BYTES) throw new Error('This skill file is too large to import.')
        const parsed = parseSkillMarkdown(readFileSync(path, 'utf8'), basename(path))
        return skills.save({ ...parsed, owner: checkOwner(owner) })
      },
    },
    routines: {
      list: () => routines.list(),
      save: (routine) => routines.save({ ...routine, owner: checkOwner(routine.owner) }),
      remove: (id) => routines.remove(id),
      runNow: (id) => void routineRunner.runNow(id),
    },
    memory: {
      list: (owner) => memory.list(checkOwner(owner)),
      read: (path, owner) => memory.read(path, checkOwner(owner)),
      write: (path, text, owner) => {
        memory.write(path, text, checkOwner(owner))
        sendEvent({ type: 'memory', owner: owner ?? SHARED_OWNER })
      },
      remove: (path, owner) => {
        memory.remove(path, checkOwner(owner))
        sendEvent({ type: 'memory', owner: owner ?? SHARED_OWNER })
      },
    },
    connectors: {
      list: () => connectors.views(),
      save: (input) => connectors.save({ ...input, owner: checkOwner(input.owner) }),
      remove: (id) => connectors.remove(id),
    },
    companion: {
      get: () => companion.get(),
      set: (patch) => companion.update(companion.activeId(), patch),
      presets: () => presets.list(),
      // A late render can arrive after the toggle was turned off or the companion changed; ignore it.
      setDockIcon: (dataUrl) => {
        const active = companion.get()
        if (!active.dockIcon || !setDockIcon(dockIconImage(dataUrl))) return false
        dockShownFor = active.id
        return true
      },
    },
    companions: {
      list: () => companion.list(),
      activeId: () => companion.activeId(),
      get: (id) => companion.get(id),
      setActive: (id) => companion.setActive(id),
      update: (id, patch) => companion.update(id, patch),
      create: (input) => companionService.create(input),
      duplicate: (id) => {
        const copy = companionService.duplicate(id)
        companionFiles.copyOwner(id, copy.id)
        return copy
      },
      hide: (id) => companion.setHidden(id, true),
      unhide: (id) => companion.setHidden(id, false),
      reset: (id) => companion.reset(id),
      remove: async (id) => {
        await companionService.remove(id)
        await companionFiles.removeOwner(id)
      },
      export: async (id, options) => {
        const text = companionService.exportText(id, options)
        const target = await dialog.showSaveDialog(window, {
          defaultPath: join(app.getPath('documents'), exportFileName(companion.get(id).name, COMPANION_FILE_EXTENSION)),
          filters: [{ name: mainT('core.mainIndex.atelierCompanion'), extensions: [COMPANION_FILE_EXTENSION] }],
        })
        if (target.canceled || !target.filePath) return null
        writeFileSync(target.filePath, text, 'utf8')
        // The share image goes beside the file under the same name.
        if (options?.shareImage) {
          writeFileSync(target.filePath.replace(/\.[^./\\]+$/, '') + '.png', Buffer.from(options.shareImage.slice(options.shareImage.indexOf(',') + 1), 'base64'))
        }
        return target.filePath
      },
      pickImport: async () => {
        const picked = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: mainT('core.mainIndex.atelierCompanion'), extensions: [COMPANION_FILE_EXTENSION] }] })
        const path = picked.filePaths[0]
        if (picked.canceled || !path) return null
        return companionService.preview(readCompanionFile(path))
      },
      previewImport: (text) => companionService.preview(text),
      confirmImport: (token) => companionService.confirm(token),
    },
    companionFiles: {
      list: (id, folder) => companionFiles.list(companion.get(id).id, folder),
      add: (id, folder, name, base64) => companionFiles.add(companion.get(id).id, folder, name, Buffer.from(base64, 'base64')),
      open: async (id, path) => {
        const failure = await electronShell.openPath(companionFiles.resolve(id, path))
        if (failure) throw new Error(failure)
      },
      reveal: (id, path) => {
        const target = companionFiles.resolve(id, path)
        if (path === '') {
          // The folder may not exist until the first file is added.
          mkdirSync(target, { recursive: true })
          void electronShell.openPath(target)
        } else electronShell.showItemInFolder(target)
      },
      remove: (id, path) => companionFiles.remove(id, path),
    },
    importer: {
      sources: () => importSources().map(({ id, name, kind }) => ({ id, name, kind })),
      run: (id) => {
        const source = importSources().find((s) => s.id === id)
        if (!source) throw new Error('That browser was not found on this computer.')
        const data = readSource(source)
        const result = { bookmarks: bookmarks.addMany(data.bookmarks), history: history.importMany(data.history) }
        if (result.bookmarks + result.history > 0) firstWeek.store.signal('import-data')
        return result
      },
    },
    peek: {
      open: (url) => peekManager.open(url),
      close: () => peekManager.close(),
      promote: () => peekManager.promote(),
    },
    split: {
      open: () => tabManager.openSplit(),
      close: () => tabManager.closeSplit(),
      swap: () => tabManager.swapSplit(),
      openWith: (id, partnerId) => tabManager.openSplitWith(id, partnerId),
    },
    pages: {
      open: (url, options) => tabManager.openInternal(url, options),
      snapshot: (id) => tabManager.capture(id, window.webContents),
    },
    ...shell.services,
    onboarding: {
      complete: () => {
        settings.update({ onboarded: true })
        // The getting-started page opens itself once, right after setup.
        if (firstWeek.store.setupFinished()) tabManager.openInternal('atelier://first-week', { newTab: true })
      },
    },
    ...firstWeek.services,
    engine: {
      status: () => engines.status(),
      copyCommand: async () => clipboard.writeText(await engines.outsideCommand()),
      addToClaudeCode: () => engines.addToClaudeCode(),
      revoke: () => engines.rotate(),
    },
    // The engines a build adds bring their own service namespaces.
    ...engines.extras.services,
  }
  const services: Services = mergeServices(a0Services, features.services, windowServices)
  // Site suggestions see connectors, chats and exclusions; app partitions get the webRequest lockdown.
  bindPlatformServices(services, (s, i) => features.installSession(s, i))
  // Packs (docs/packs.md): pack companions, connectors and routines go through the merged services; pack partitions get the webRequest mux.
  bindPacks({
    services,
    installSession: (s, i) => features.installSession(s, i),
    companionText: (id) => {
      try {
        return companionService.exportText(id, { includeSkills: true, includeRoutines: true })
      } catch {
        return null
      }
    },
    companionName: (id) => {
      try {
        return companion.get(id).name
      } catch {
        return null
      }
    },
    // Apps cast companions by name and look; speak lines get the personality and instructions in main, never memory.
    cast: {
      list: () => companion.list().filter((c) => !c.hidden).map((c) => ({ id: c.id, name: c.name, look: c.look, personality: presets.personality(c.persona) ?? null, instructions: c.instructions })),
      activeId: () => companion.activeId(),
    },
  })
  const unimplemented = missingMethods(services, SERVICE_SCHEMAS)
  if (unimplemented.length > 0) log.error('features', `Service methods without an implementation: ${unimplemented.join(', ')}`)
  personalWiring.bindServices(services, SERVICE_SCHEMAS as unknown as Parameters<typeof personalWiring.bindServices>[1])
  // What the menus list: visits, bookmarks, closed entries, the default-browser state; then the services their commands call
  wireMenuSources({ history, bookmarks, windows: windowManager, isDefaultBrowser: () => app.isDefaultProtocolClient('https') })
  bindMenuServices(services)
  registerServices(window.webContents, services)
  registerIpc({
    ui: window.webContents,
    tabs: tabManager,
    agent,
    settings,
    history,
    adblock,
    webSession,
    peek: peekManager,
    initialState: () => shell.initialState(),
    sendEvent,
  })
  // Overlay host, per-window routing, later windows, session restore, the ShortcutRouter, the core commands, the Dock, keep-awake
  const uiPreload = join(__dirname, '../preload/ui.js')
  const coreHandle = startCore({
    windows: windowManager,
    first: firstWindow,
    firstServices: services,
    firstIpc: { ui: window.webContents, tabs: tabManager, peek: peekManager, webSession, initialState: () => shell.initialState(), sendEvent },
    factory: {
      uiUrl,
      preloadUi: uiPreload,
      preloadPage: join(__dirname, '../preload/page.js'),
      settings,
      theme,
      history,
      bridge,
      windowStore,
      webSession,
      names: {
        chat: (id) => chats.summary(id)?.title ?? null,
        companion: (id) => companion.find(id)?.name ?? null,
      },
      agentOverlay: (tab) => {
        const ownerId = tab.agentChatId ? chats.summary(tab.agentChatId)?.companionId : undefined
        const owner = (ownerId && companion.find(ownerId)) || companion.get()
        return agentOverlayLook({ name: owner.name, accent: owner.look.colors.accent }, theme.state().mode)
      },
      installSession: (s, info) => features.installSession(s, info),
      addWindow: (win) => {
        const parts = features.addWindow(win)
        return mergeServices(parts, profileWindowParts(win, parts))
      },
      // Later windows open in their own profile's session and stores.
      ...(contentRuntime.profiles !== stubProfiles ? { profiles: contentRuntime.profiles } : {}),
      tabsRegistry,
      smoke,
    },
    settings,
    theme,
    dataDir,
    smoke,
    busyCount: () => chats.list().filter((c) => c.status === 'running').length + routineRunner.runningCount(),
    onBusyChange: (fn) => void chats.on('changed', fn),
    agentName: (tab) => {
      const ownerId = tab.agentChatId ? chats.summary(tab.agentChatId)?.companionId : undefined
      return ((ownerId && companion.find(ownerId)) || companion.get()).name
    },
  })

  const uiOrigin = uiOriginOf(uiUrl)
  window.webContents.on('will-navigate', (event) => {
    if (uiOrigin === null || uiOriginOf(event.url) !== uiOrigin) event.preventDefault()
  })
  window.webContents.on('did-finish-load', pushTabs)
  // A reloaded chrome mounts its chat surfaces again, and they report what they
  // show. Its overlay holds, order and peek frame start empty, so main's go too.
  window.webContents.on('did-start-loading', () => {
    agent.clearViewing(window.id)
    tabManager.resetChromeState()
    peekManager.close()
  })
  // A launch at login in background mode starts without a window.
  window.once('ready-to-show', () => {
    if (!backgroundMode.startHidden()) window.show()
  })
  app.on('before-quit', (event) => {
    // CH-30: a quit held to ask about a private chat isn't happening (yet).
    if (event.defaultPrevented) return
    agent.stopAll()
    void features.dispose()
    void engines.dispose()
    routineRunner.stop()
    firstWeek.store.dispose()
    history.flush()
  })
  // Windows shutting down or signing out sends no before-quit (system/sessionEnd.ts): the same saves, synchronously.
  onSessionEnd(() => {
    agent.stopAll()
    routineRunner.stop()
    firstWeek.store.dispose()
    history.flush()
  })

  // A failed load is retried by the chrome's crash guard (src/main/window.ts).
  await window.loadURL(uiUrl).catch(() => undefined)
  // Session.json brings back every window; without one, the pinned tabs and a new tab.
  if (!coreHandle.restoreSession()) {
    if (!smoke) tabManager.restorePinned()
    tabManager.create(!settings.get().onboarded && !smoke ? 'atelier://welcome' : 'about:blank')
  }

  // Opened .ateliercompanion files go to the chrome's review sheet.
  openCompanionFile = (path) => {
    try {
      sendEvent({ type: 'companion-import', preview: companionService.preview(readCompanionFile(path)) })
    } catch (err) {
      sendEvent({ type: 'companion-import-error', message: err instanceof Error ? err.message : String(err) })
    }
    if (!window.isDestroyed()) window.show()
  }
  for (const path of openedCompanionFiles.splice(0)) openCompanionFile(path)
  openPack = (path) => {
    // As with outside links: the window in front, unless it is private (an app's saves outlive no private window).
    const front = windowManager.focused()
    openPackFile(path, front && front.kind !== 'private' && front.kind !== 'chat' ? front : firstWindow)
    if (!window.isDestroyed()) window.show()
  }
  for (const path of openedPackFiles.splice(0)) openPack(path)
  openExternalUrl = (url) => {
    // Into the window in front (a private one never gets outside links).
    const front = windowManager.focused()
    const target = front && front.kind !== 'private' && front.kind !== 'chat' ? front : firstWindow
    target.tabs.create(url)
    if (!target.window.isDestroyed()) target.window.show()
  }
  for (const url of openedUrls.splice(0)) openExternalUrl(url)

  if (smoke) {
    const code = await runSmoke({
      ui: window.webContents,
      tabs: tabManager,
      agent: agent.smokeSession(),
      host: agent,
      client: smokeClient ?? createSmokeClient(),
      bridge,
      memory,
      bookmarks,
      downloads,
      peek: peekManager,
      settings,
      skills,
      routines,
      connectors,
      chats,
      history,
      windowState: shell.chrome,
    })
    app.exit(code)
  } else {
    routineRunner.start()
    void engines.start()
  }
})
