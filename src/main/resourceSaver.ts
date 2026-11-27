/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { log } from './log'

// Staying light (docs/architecture.md › Staying light). Two savers sit on top of sleeping tabs (tabSleep.ts):
//
//   Memory saver   when the computer runs short of memory, background tabs sleep much sooner than their timer says,
//                  and what Atelier only keeps loaded for speed (the on-device models) is let go.
//   Energy saver   on battery, background tabs sleep after half an hour at most, and nothing is loaded ahead of use.
//
// Both only bring forward what already happens to a background tab; what never sleeps (tabSleep.ts canSleep) still
// never does. How short of memory the computer is comes from the operating system's own word for it where it has
// one, because "free" memory means little: a healthy Mac reports almost none.

export type Pressure = 'normal' | 'low' | 'critical'

/** macOS's kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. Anything unreadable is normal. */
export function pressureFromLevel(level: number): Pressure {
  return level >= 4 ? 'critical' : level >= 2 ? 'low' : 'normal'
}

/** Where there is no such level: the share of memory an app could still get (Linux's MemAvailable, Windows' available physical memory). */
export function pressureFromAvailable(availableBytes: number, totalBytes: number): Pressure {
  if (!(totalBytes > 0) || !(availableBytes >= 0)) return 'normal'
  const share = availableBytes / totalBytes
  if (share < 0.05 || availableBytes < 400 * 1024 * 1024) return 'critical'
  if (share < 0.12 || availableBytes < 1024 * 1024 * 1024) return 'low'
  return 'normal'
}

/** MemAvailable and MemTotal from /proc/meminfo, in bytes; null when either is missing. */
export function parseMeminfo(text: string): { available: number; total: number } | null {
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const available = kb('MemAvailable')
  const total = kb('MemTotal')
  return available === null || total === null ? null : { available, total }
}

export interface PressureSources {
  platform: NodeJS.Platform
  /** `sysctl -n kern.memorystatus_vm_pressure_level` (macOS). */
  sysctl(name: string): Promise<string>
  /** /proc/meminfo (Linux). */
  meminfo(): Promise<string>
  /** Electron's process.getSystemMemoryInfo(), in kilobytes (Windows: free is the available physical memory). */
  system(): { total: number; free: number }
}

/** How short of memory the computer is right now. Never throws: what can't be read is normal. */
export async function readPressure(src: PressureSources): Promise<Pressure> {
  try {
    if (src.platform === 'darwin') return pressureFromLevel(Number.parseInt(await src.sysctl('kern.memorystatus_vm_pressure_level'), 10) || 0)
    if (src.platform === 'linux') {
      const m = parseMeminfo(await src.meminfo())
      return m ? pressureFromAvailable(m.available, m.total) : 'normal'
    }
    const s = src.system()
    return pressureFromAvailable(s.free * 1024, s.total * 1024)
  } catch {
    return 'normal'
  }
}

export interface SaverState {
  pressure: Pressure
  onBattery: boolean
}

export interface SaverSettings {
  memorySaver: boolean
  energySaver: boolean
}

/** Minutes in the background after which a tab sleeps while memory is short. */
export const PRESSURE_SLEEP_MINUTES: Record<Exclude<Pressure, 'normal'>, number> = { low: 10, critical: 2 }
/** The longest a background tab stays awake on battery with the energy saver on. */
export const BATTERY_SLEEP_MINUTES = 30

/**
 * After how many minutes in the background a tab sleeps now: the person's own setting (null for never), brought
 * forward by whichever saver applies. A saver also applies when the setting is "never": it has its own switch.
 */
export function sleepMinutesNow(setting: number | null, state: SaverState, savers: SaverSettings): number | null {
  const limits: number[] = []
  if (setting !== null && setting > 0) limits.push(setting)
  if (savers.memorySaver && state.pressure !== 'normal') limits.push(PRESSURE_SLEEP_MINUTES[state.pressure])
  if (savers.energySaver && state.onBattery) limits.push(BATTERY_SLEEP_MINUTES)
  return limits.length ? Math.min(...limits) : null
}

/** Whether to load something ahead of its first use (the on-device model's warm-up): not while a saver is holding back. */
export function mayPreload(state: SaverState, savers: SaverSettings): boolean {
  if (savers.memorySaver && state.pressure !== 'normal') return false
  if (savers.energySaver && state.onBattery) return false
  return true
}

/** Whether to let go of what is only kept loaded for speed: when memory is critically short and the memory saver is on. */
export function shouldRelease(state: SaverState, savers: SaverSettings): boolean {
  return savers.memorySaver && state.pressure === 'critical'
}

export interface WatchDeps {
  pressure(): Promise<Pressure>
  onBattery(): boolean
  /** Subscribes to the computer going on battery or back on power; returns the unsubscribe. */
  onPower(listener: () => void): () => void
}

/**
 * Keeps the state the savers go by: asks for the memory pressure every half minute and follows the power source.
 * Listeners hear about every change, so tabs can sleep the moment memory runs short instead of a minute later.
 */
export class ResourceWatch {
  readonly #deps: WatchDeps
  readonly #listeners = new Set<(state: SaverState, before: SaverState) => void>()
  #state: SaverState = { pressure: 'normal', onBattery: false }
  #timer: ReturnType<typeof setInterval> | null = null
  #offPower: (() => void) | null = null
  #busy = false

  constructor(deps: WatchDeps) {
    this.#deps = deps
  }

  start(intervalMs = 30_000): void {
    if (this.#timer) return
    this.#set({ ...this.#state, onBattery: this.#battery() })
    this.#offPower = this.#deps.onPower(() => this.#set({ ...this.#state, onBattery: this.#battery() }))
    this.#timer = setInterval(() => void this.check(), intervalMs)
    this.#timer.unref?.()
    void this.check()
  }

  state(): SaverState {
    return this.#state
  }

  onChange(listener: (state: SaverState, before: SaverState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Reads the pressure now (the timer does this; tests call it). */
  async check(): Promise<SaverState> {
    if (this.#busy) return this.#state
    this.#busy = true
    try {
      this.#set({ ...this.#state, pressure: await this.#deps.pressure().catch(() => 'normal' as const) })
    } finally {
      this.#busy = false
    }
    return this.#state
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#offPower?.()
    this.#offPower = null
    this.#listeners.clear()
  }

  #battery(): boolean {
    try {
      return this.#deps.onBattery()
    } catch {
      return false
    }
  }

  #set(next: SaverState): void {
    const before = this.#state
    if (before.pressure === next.pressure && before.onBattery === next.onBattery) return
    this.#state = next
    if (before.pressure !== next.pressure) log.info('resources', 'Memory pressure changed', { from: before.pressure, to: next.pressure })
    for (const listener of this.#listeners) {
      try {
        listener(next, before)
      } catch (err) {
        log.warn('resources', 'A saver listener failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

let shared: ResourceWatch | null = null

/** The app's one watch (index.ts starts it); before that, and in tests, a state where no saver applies. */
export function resourceState(): SaverState {
  return shared?.state() ?? { pressure: 'normal', onBattery: false }
}

export function onResourceChange(listener: (state: SaverState, before: SaverState) => void): () => void {
  return shared?.onChange(listener) ?? (() => undefined)
}

export function setResourceWatch(watch: ResourceWatch | null): void {
  shared = watch
}
