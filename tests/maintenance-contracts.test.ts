/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { RELEASE, releaseFrom } from '../src/shared/release'
import { SETTINGS } from '../src/shared/settingsRegistry'
import { SURFACE_IDS } from '../src/shared/overlay'
import { EN } from '../src/shared/i18n/en'
import { initialUpdateStatus, EMPTY_UPDATES_FILE } from '../src/shared/updates'
import { CHAT_FORMAT_VERSION, emptyMigrationReport } from '../src/shared/migrations'
import { REPORT_MAX_BYTES } from '../src/shared/diagnostics'
import { AVAILABLE_LANGUAGES } from '../src/shared/i18n/locales'
import { INTERNAL_PAGES, parseInternalUrl } from '../src/shared/url'
import { SHORTCUTS, isCommandId } from '../src/shared/shortcuts'
import { resolveResourcePath } from '../src/main/resources'
import { DIAGNOSTICS_SCHEMAS, reportDraftSchema } from '../src/main/diagnostics/schemas'
import { UPDATES_SCHEMAS } from '../src/main/updates/schemas'
import { MIGRATIONS_SCHEMAS } from '../src/main/migrations/schemas'
import { SYSTEM_SCHEMAS } from '../src/main/system/schemas'
import { NATIVE_SCHEMAS } from '../src/main/native/schemas'
import { setupDiagnostics } from '../src/main/diagnostics/service'
import { setupMigrations } from '../src/main/migrations/service'
import { setupSystem } from '../src/main/system/service'
import { setupUpdates } from '../src/main/updates/service'
import { setupNative } from '../src/main/native/service'
import { SettingsStore } from '../src/main/settings'
import { CommandRegistry } from '../src/main/commands'
import { ChatStore } from '../src/main/chats'
import { FIRST_COMPANION_ID } from '../src/main/companions'

// Electron is faked: the services below only need to construct, not reach the OS.
vi.mock('electron', () => {
  const events = () => ({ on: () => undefined, off: () => undefined, once: () => undefined, removeListener: () => undefined })
  return {
    app: {
      ...events(),
      isPackaged: false,
      getVersion: () => '1.0.0',
      getName: () => 'Atelier',
      getPath: () => '/tmp',
      getAppPath: () => '/tmp',
      getLocale: () => 'en-US',
      getPreferredSystemLanguages: () => ['en-US'],
    },
    shell: { showItemInFolder: () => undefined, openPath: async () => '', openExternal: async () => undefined },
    powerMonitor: events(),
    safeStorage: { isEncryptionAvailable: () => false },
    crashReporter: { start: () => undefined, getUploadedReports: () => [] },
    nativeTheme: { ...events(), shouldUseDarkColors: false },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({ isEmpty: () => true }) },
    dialog: {},
    Menu: { buildFromTemplate: () => ({}) },
    Tray: class {},
    Notification: class {
      static isSupported(): boolean {
        return false
      }
    },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  }
})

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e0-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A real settings store on a temp folder, so every key reads its default. */
const settingsFake = (dir: string): SettingsStore => new SettingsStore(dir)
/** A real, empty chat store on its own temp folder. */
const chatsFake = (dir: string): ChatStore => new ChatStore(dir, FIRST_COMPANION_ID)
const routinesFake = { runningCount: () => 0, nextRunAt: () => null }
const recorderFake = { status: () => ({ state: 'idle' }), on: () => () => undefined, off: () => undefined, pause: async () => undefined, resume: async () => undefined, stop: async () => undefined } as never
const windowsFake = { focused: () => null, all: () => [], on: () => undefined, off: () => undefined } as never
const attentionFake = { onChange: () => () => undefined }

// The release and platform contracts: the shapes the updates, diagnostics, system,
// language and native features build on.

describe('RELEASE', () => {
  it('has safe defaults without build defines', () => {
    expect(RELEASE).toEqual({ channel: 'dev', publicRelease: false, updatesEnabled: false, updateNotices: false, supportEmail: '', website: '', repo: null })
  })

  it('parses the defines', () => {
    expect(releaseFrom({ channel: 'beta', publicRelease: '1', updates: 'true', supportEmail: 'a@b.c', website: 'https://x.y', repo: 'me/atelier' })).toEqual({
      channel: 'beta',
      publicRelease: true,
      updatesEnabled: true,
      updateNotices: false,
      supportEmail: 'a@b.c',
      website: 'https://x.y',
      repo: { owner: 'me', name: 'atelier' },
    })
  })

  it('reads an unsigned release build as one that announces updates', () => {
    expect(releaseFrom({ channel: 'stable', updates: 'notify', repo: 'me/atelier' })).toMatchObject({ updatesEnabled: false, updateNotices: true })
    expect(releaseFrom({ channel: 'stable', updates: '0', repo: 'me/atelier' })).toMatchObject({ updatesEnabled: false, updateNotices: false })
  })

  it('falls back on unknown channels and malformed repos', () => {
    const r = releaseFrom({ channel: 'nightly', publicRelease: '0', repo: 'no-slash' })
    expect(r.channel).toBe('dev')
    expect(r.publicRelease).toBe(false)
    expect(r.repo).toBeNull()
  })
})

describe('release and platform settings', () => {
  it('registers every release and platform key with app scope and its default', () => {
    const expected = { autoDownloadUpdates: true, crashReports: false, runInBackground: false, appLanguage: 'system', haptics: true, pauseMeetingsOnLidClose: true }
    for (const [key, value] of Object.entries(expected)) {
      const def = (SETTINGS as Record<string, { scope: string; default: unknown }>)[key]
      expect(def?.scope, key).toBe('app')
      expect(def?.default, key).toEqual(value)
    }
  })
})

describe('release and platform surfaces, routes, commands and strings', () => {
  it('lists every release and platform overlay surface', () => {
    for (const id of ['problem-report', 'crash-notice', 'whats-new', 'update-restart', 'update-unsupported', 'login-item-approval']) {
      expect(SURFACE_IDS as readonly string[]).toContain(id)
    }
  })

  it('routes atelier://logs', () => {
    expect(INTERNAL_PAGES.logs).toBeTruthy()
    expect(parseInternalUrl('atelier://logs')?.page).toBe('logs')
  })

  it('binds Report a Problem to ⇧⌘H and knows the menu-only commands', () => {
    expect(SHORTCUTS.find((s) => s.id === 'report-problem')?.accelerator).toBe('CmdOrCtrl+Shift+H')
    for (const id of ['check-for-updates', 'whats-new', 'send-feedback', 'show-logs']) expect(isCommandId(id), id).toBe(true)
  })

  it('merges the release and platform fragments into the English catalogue', () => {
    for (const key of ['updates.pill.ready', 'diagnostics.report.title', 'migrations.about.upToDate', 'system.tray.quit', 'native.haptics.row']) {
      expect((EN as Record<string, string>)[key], key).toBeTruthy()
    }
    expect(AVAILABLE_LANGUAGES.map((l) => l.code)).toEqual(['en', 'nl'])
  })
})

describe('release and platform shapes', () => {
  it('starts updates disabled and the updates file empty', () => {
    const s = initialUpdateStatus('1.2.3')
    expect(s.phase).toBe('disabled')
    expect(s.currentVersion).toBe('1.2.3')
    expect(EMPTY_UPDATES_FILE.pending).toBeNull()
  })

  it('reports no migrations before any run', () => {
    const r = emptyMigrationReport('1.0.0')
    expect(r.to).toBe(CHAT_FORMAT_VERSION)
    expect(r.failed).toEqual([])
  })

  it('caps the report at 25 MB', () => {
    expect(REPORT_MAX_BYTES).toBe(25 * 1024 * 1024)
  })

  it('resolves runtime resources for packaged and dev builds', () => {
    const o = { resourcesPath: '/App/Contents/Resources', appPath: '/src/atelier', branding: 'official' }
    expect(resolveResourcePath({ ...o, packaged: true }, ['tray', 'tray.png'])).toBe(join('/App/Contents/Resources/resources/tray/tray.png'))
    expect(resolveResourcePath({ ...o, packaged: false }, ['icons', 'app-32.png'])).toBe(join('/src/atelier/branding/official/resources/icons/app-32.png'))
  })
})

describe('release and platform service schemas', () => {
  const dir = tempDir()
  const settings = settingsFake(dir)
  const updates = setupUpdates({
    settings,
    sessionRestore: { flush: async () => undefined },
    agent: { isRunning: () => false } as never,
    routines: routinesFake,
    meetings: recorderFake,
    menus: { invalidate: () => undefined },
    broadcast: () => undefined,
    dataDir: dir,
    chats: chatsFake(dir),
    windows: { focused: () => null },
    openPage: () => undefined,
    smoke: false,
    backend: 'fake',
  })
  const diagnostics = setupDiagnostics({ settings, tabs: {} as never, agent: {} as never, chats: chatsFake(dir), windows: windowsFake })
  const migrations = setupMigrations({ chats: chatsFake(dir), dataDir: dir, appVersion: '1.0.0', schedule: () => undefined })
  const system = setupSystem({ settings, routines: routinesFake, meetings: recorderFake, windows: windowsFake, attention: attentionFake, dataDir: dir })
  const native = setupNative({ settings, broker: { onLine: () => () => undefined } as never, recorder: recorderFake, platform: 'linux' })
  afterAll(() => {
    updates.dispose()
    diagnostics.dispose()
    migrations.migrations.stop()
    native.dispose()
  })
  const pairs = [
    [UPDATES_SCHEMAS, updates.services],
    [DIAGNOSTICS_SCHEMAS, diagnostics.services],
    [MIGRATIONS_SCHEMAS, migrations.services],
    [SYSTEM_SCHEMAS, system.services],
    [NATIVE_SCHEMAS, native.services],
  ] as const

  it('has a schema for every method and a method for every schema', () => {
    for (const [schemas, services] of pairs) {
      for (const [name, service] of Object.entries(services as unknown as Record<string, Record<string, unknown>>)) {
        const methods = (schemas as Record<string, Record<string, unknown>>)[name]
        expect(methods, name).toBeTruthy()
        for (const [method, fn] of Object.entries(service)) {
          expect(methods?.[method], `${name}.${method}`).toBeTruthy()
          expect(typeof fn, `${name}.${method}`).toBe('function')
        }
        expect(Object.keys(methods ?? {}).sort()).toEqual(Object.keys(service).sort())
      }
    }
  })

  it('answers the read-only calls with real values', () => {
    expect(updates.services.updates.status().phase).toBeTruthy()
    expect(migrations.services.migrations.report().failed).toEqual([])
  })

  it('validates a report draft strictly', () => {
    const draft = { description: 'It froze', images: [], fileTokens: [], includeChatId: null, includeScreenshotTabId: null, includeCrashDumps: false }
    expect(reportDraftSchema.safeParse(draft).success).toBe(true)
    expect(reportDraftSchema.safeParse({ ...draft, extra: 1 }).success).toBe(false)
    expect(reportDraftSchema.safeParse({ ...draft, images: [{ name: 'x', dataUrl: 'javascript:alert(1)' }] }).success).toBe(false)
    expect(reportDraftSchema.safeParse({ ...draft, fileTokens: ['../etc/passwd'] }).success).toBe(false)
  })
})

describe('release and platform feature modules', () => {
  it('fill the ctx.maintenance slots and return their services', async () => {
    const { createMaintenanceRuntime } = await import('../src/main/features/maintenanceRuntime')
    const { diagnosticsFeature } = await import('../src/main/features/diagnostics')
    const { migrationsFeature } = await import('../src/main/features/migrations')
    const { updatesFeature } = await import('../src/main/features/updates')
    const { systemFeature } = await import('../src/main/features/system')
    const { nativeFeature } = await import('../src/main/features/native')
    const { i18nFeature } = await import('../src/main/features/i18n')
    const dir = tempDir()
    const e = createMaintenanceRuntime({ chats: chatsFake(dir), routines: routinesFake, attention: attentionFake })
    // Before the migrations feature runs, its slot is a placeholder.
    expect(() => e.migrations.report()).toThrow('Not available yet')
    const ctx = {
      dataDir: dir,
      settings: settingsFake(dir),
      agent: { isRunning: () => false, on: () => undefined, off: () => undefined, onControl: () => () => undefined, view: () => null },
      windows: windowsFake,
      tabsRegistry: {},
      commands: new CommandRegistry(),
      broadcast: () => undefined,
      notify: () => undefined,
      smoke: false,
      personal: { broker: { onLine: () => () => undefined }, recorder: recorderFake },
      maintenance: e,
    } as never
    const features = [diagnosticsFeature, migrationsFeature, updatesFeature, systemFeature, nativeFeature, i18nFeature]
    try {
      const parts = features.map((f) => f.app?.(ctx))
      expect(parts.flatMap((p) => Object.keys(p ?? {})).sort()).toEqual(['diagnostics', 'haptics', 'migrations', 'system', 'updates'])
      expect(e.migrations.report().failed).toEqual([])
      expect(e.migrations).toBe((parts[1] as { migrations: unknown }).migrations)
      expect(e.updates).toBe((parts[2] as { updates: unknown }).updates)
    } finally {
      for (const f of features) await f.dispose?.()
    }
  })
})
