/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, migrateSettings, settingsPatchSchema } from '../src/main/settings'

// The settings fields: defaults for older files, field-by-field fallback,
// and the widened search engine.

describe('settings fields', () => {
  it('default for older settings files', () => {
    const s = migrateSettings({ theme: 'dark' })
    expect(s).toMatchObject({
      warnBeforeQuit: true,
      confirmCloseTabs: true,
      keepAwake: false,
      tabSleepMinutes: 120,
      memorySaver: true,
      energySaver: true,
      popupBlocking: true,
      proxy: { mode: 'system', bypass: '<local>' },
      density: 'comfortable',
      fontSize: 13,
      uiZoom: 1,
      chatZoom: 1,
      languages: { mode: 'system', list: [] },
      dockIcon: { kind: 'standard' },
    })
    expect(s.notifications.categories).toEqual({ 'needs-you': true, 'chat-updates': true, 'routine-results': true, meetings: true, downloads: true, passwords: true, packs: true })
  })

  it('drop invalid values one field at a time', () => {
    const s = migrateSettings({ fontSize: 40, uiZoom: 0.5, chatZoom: 9, languages: { mode: 'custom', list: ['nl', 'en-GB'] }, proxy: { mode: 'tunnel' } })
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(s.uiZoom).toBe(0.5)
    expect(s.chatZoom).toBe(DEFAULT_SETTINGS.chatZoom)
    expect(s.languages).toEqual({ mode: 'custom', list: ['nl', 'en-GB'] })
    expect(s.proxy).toEqual(DEFAULT_SETTINGS.proxy)
  })

  it('keep a custom search engine and drop an unknown one', () => {
    const custom = { id: 'kagi', name: 'Kagi', template: 'https://kagi.com/search?q=%s' }
    expect(migrateSettings({ searchEngine: 'kagi', customSearchEngines: [custom] }).searchEngine).toBe('kagi')
    expect(migrateSettings({ searchEngine: 'altavista' }).searchEngine).toBe('google')
    // Every engine Settings › Search lists survives a restart (NT-01).
    expect(migrateSettings({ searchEngine: 'ecosia' }).searchEngine).toBe('ecosia')
    expect(migrateSettings({ searchEngine: 'kagi' }).searchEngine).toBe('kagi')
    expect(migrateSettings({ searchEngine: 'duckduckgo' }).searchEngine).toBe('duckduckgo')
  })

  it('validate patches strictly', () => {
    expect(settingsPatchSchema.safeParse({ dockIcon: { kind: 'companion', companionId: 'companion-1' } }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ dockIcon: { kind: 'emoji' } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ customSearchEngines: [{ id: 'x', name: 'X', template: 'javascript:%s' }] }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ clearOnExit: { cookies: true, cache: false, history: false, extra: true } }).success).toBe(false)
  })
})
