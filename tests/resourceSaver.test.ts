/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

import { MiniInstaller } from '../src/main/decisions/deviceMini'
import {
  BATTERY_SLEEP_MINUTES,
  PRESSURE_SLEEP_MINUTES,
  ResourceWatch,
  mayPreload,
  parseMeminfo,
  pressureFromAvailable,
  pressureFromLevel,
  readPressure,
  shouldRelease,
  sleepMinutesNow,
  type Pressure,
} from '../src/main/resourceSaver'
import { canSleep } from '../src/main/tabSleep'

const GB = 1024 ** 3
const PARTIAL = 'downloading.json' // deviceMini.ts PARTIAL_VERSION
const on = { memorySaver: true, energySaver: true }
const off = { memorySaver: false, energySaver: false }
const calm = { pressure: 'normal' as Pressure, onBattery: false }

describe('memory pressure', () => {
  it("reads macOS's own level", () => {
    expect([0, 1, 2, 4].map(pressureFromLevel)).toEqual(['normal', 'normal', 'low', 'critical'])
  })

  it('goes by what an app could still get elsewhere', () => {
    expect(pressureFromAvailable(8 * GB, 16 * GB)).toBe('normal')
    expect(pressureFromAvailable(1.5 * GB, 16 * GB)).toBe('low') // under 12%
    expect(pressureFromAvailable(0.9 * GB, 4 * GB)).toBe('low') // under 1 GB
    expect(pressureFromAvailable(0.6 * GB, 16 * GB)).toBe('critical') // under 5%
    expect(pressureFromAvailable(0.3 * GB, 2 * GB)).toBe('critical') // under 400 MB
    expect(pressureFromAvailable(Number.NaN, 0)).toBe('normal')
  })

  it('parses /proc/meminfo', () => {
    expect(parseMeminfo('MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:    4000000 kB\n')).toEqual({ available: 4000000 * 1024, total: 16000000 * 1024 })
    expect(parseMeminfo('MemTotal: 1 kB')).toBeNull()
  })

  it('asks each platform its own way and never throws', async () => {
    const src = { sysctl: async () => '4\n', meminfo: async () => 'MemTotal: 16000000 kB\nMemAvailable: 1500000 kB\n', system: () => ({ total: 16_000_000, free: 8_000_000 }) }
    expect(await readPressure({ ...src, platform: 'darwin' })).toBe('critical')
    expect(await readPressure({ ...src, platform: 'linux' })).toBe('low')
    expect(await readPressure({ ...src, platform: 'win32' })).toBe('normal')
    expect(await readPressure({ ...src, platform: 'darwin', sysctl: async () => Promise.reject(new Error('no sysctl')) })).toBe('normal')
    expect(await readPressure({ ...src, platform: 'darwin', sysctl: async () => 'nonsense' })).toBe('normal')
  })
})

describe('when a background tab sleeps', () => {
  it("is the person's setting while nothing is short", () => {
    expect(sleepMinutesNow(120, calm, on)).toBe(120)
    expect(sleepMinutesNow(null, calm, on)).toBeNull()
  })

  it('comes forward while memory is short, also when the setting is never', () => {
    expect(sleepMinutesNow(120, { pressure: 'low', onBattery: false }, on)).toBe(PRESSURE_SLEEP_MINUTES.low)
    expect(sleepMinutesNow(120, { pressure: 'critical', onBattery: false }, on)).toBe(PRESSURE_SLEEP_MINUTES.critical)
    expect(sleepMinutesNow(null, { pressure: 'critical', onBattery: false }, on)).toBe(PRESSURE_SLEEP_MINUTES.critical)
    expect(sleepMinutesNow(5, { pressure: 'low', onBattery: false }, on)).toBe(5)
  })

  it('is half an hour at most on battery', () => {
    expect(sleepMinutesNow(120, { pressure: 'normal', onBattery: true }, on)).toBe(BATTERY_SLEEP_MINUTES)
    expect(sleepMinutesNow(15, { pressure: 'normal', onBattery: true }, on)).toBe(15)
    expect(sleepMinutesNow(null, { pressure: 'normal', onBattery: true }, on)).toBe(BATTERY_SLEEP_MINUTES)
  })

  it('leaves everything alone with the savers off', () => {
    expect(sleepMinutesNow(120, { pressure: 'critical', onBattery: true }, off)).toBe(120)
    expect(sleepMinutesNow(null, { pressure: 'critical', onBattery: true }, off)).toBeNull()
  })

  it('never reaches a tab that must not sleep', () => {
    const tab = { visible: false, pinned: false, audible: false, capturing: false, agentControlled: false, asleep: false, chromeDrawn: false, lastActiveAt: 0 }
    const minutes = sleepMinutesNow(null, { pressure: 'critical', onBattery: true }, on)
    const now = 10 * 60_000
    expect(canSleep(tab, now, minutes)).toBe(true)
    for (const keep of ['visible', 'pinned', 'audible', 'capturing', 'agentControlled'] as const) expect(canSleep({ ...tab, [keep]: true }, now, minutes)).toBe(false)
    expect(canSleep({ ...tab, lastActiveAt: now - 60_000 }, now, minutes)).toBe(false) // used a minute ago
  })
})

describe('loading ahead and letting go', () => {
  it('loads nothing ahead of use on battery or while memory is short', () => {
    expect(mayPreload(calm, on)).toBe(true)
    expect(mayPreload({ pressure: 'normal', onBattery: true }, on)).toBe(false)
    expect(mayPreload({ pressure: 'low', onBattery: false }, on)).toBe(false)
    expect(mayPreload({ pressure: 'critical', onBattery: true }, off)).toBe(true)
  })

  it('lets go only when memory is critically short', () => {
    expect(shouldRelease({ pressure: 'low', onBattery: true }, on)).toBe(false)
    expect(shouldRelease({ pressure: 'critical', onBattery: false }, on)).toBe(true)
    expect(shouldRelease({ pressure: 'critical', onBattery: false }, off)).toBe(false)
  })
})

describe('ResourceWatch', () => {
  it('follows the pressure and the power source, and tells listeners once per change', async () => {
    let pressure: Pressure = 'normal'
    let battery = false
    let power: () => void = () => undefined
    const watch = new ResourceWatch({ pressure: async () => pressure, onBattery: () => battery, onPower: (l) => ((power = l), () => undefined) })
    const heard: string[] = []
    watch.onChange((s, before) => heard.push(`${before.pressure}/${before.onBattery} -> ${s.pressure}/${s.onBattery}`))
    watch.start(3_600_000)
    await watch.check()
    expect(heard).toEqual([])
    pressure = 'critical'
    await watch.check()
    await watch.check()
    battery = true
    power()
    power()
    expect(heard).toEqual(['normal/false -> critical/false', 'critical/false -> critical/true'])
    expect(watch.state()).toEqual({ pressure: 'critical', onBattery: true })
    watch.dispose()
  })

  it('treats a failing reading as normal', async () => {
    const watch = new ResourceWatch({ pressure: async () => Promise.reject(new Error('gone')), onBattery: () => { throw new Error('no battery') }, onPower: () => () => undefined })
    watch.start(3_600_000)
    expect((await watch.check()).pressure).toBe('normal')
    expect(watch.state().onBattery).toBe(false)
    watch.dispose()
  })
})

describe('outdated model folders', () => {
  const manifest = { version: 'v2', base: 'https://example.invalid/', model: [{ path: 'a.bin', url: 'a.bin', size: 3, sha256: 'x' }], servers: {} }
  const installer = (dir: string, external = false): MiniInstaller =>
    new MiniInstaller({ dir, manifest, needsServer: false, installed: (d) => (existsSync(join(d, 'a.bin')) ? d : null), external, release: () => undefined, download: async () => ({ status: 500, body: null }) })
  const folder = (version: string | null, name = 'model', marker = 'version.json'): string => {
    const dir = join(mkdtempSync(join(tmpdir(), 'atelier-tidy-')), name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.bin'), 'abcdefgh')
    if (version) writeFileSync(join(dir, marker), JSON.stringify({ version }))
    return dir
  }

  it('removes a folder of another version and says what it freed', () => {
    const dir = folder('v1')
    expect(installer(dir).tidy()).toBeGreaterThanOrEqual(8)
    expect(existsSync(dir)).toBe(false)
  })

  it("keeps this version's folder, a folder it doesn't know, and one set from outside", () => {
    const current = folder('v2')
    expect(installer(current).tidy()).toBe(0)
    expect(existsSync(join(current, 'a.bin'))).toBe(true)
    const unknown = folder(null)
    expect(installer(unknown).tidy()).toBe(0)
    expect(existsSync(unknown)).toBe(true)
    const outside = folder('v1')
    expect(installer(outside, true).tidy()).toBe(0)
    expect(existsSync(outside)).toBe(true)
  })

  it("removes another version's stopped download and keeps this version's", () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'atelier-tidy-')), 'model')
    const stale = `${dir}.partial`
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'a.bin'), 'abc')
    const marker = (v: string): void => writeFileSync(join(stale, PARTIAL), JSON.stringify({ version: v }))
    marker('v2')
    expect(installer(dir).tidy()).toBe(0)
    expect(existsSync(stale)).toBe(true)
    marker('v1')
    expect(installer(dir).tidy()).toBeGreaterThan(0)
    expect(existsSync(stale)).toBe(false)
  })
})
