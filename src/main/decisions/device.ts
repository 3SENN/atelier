/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEVICE_SCHEME } from '@shared/decisions'
import type { FetchLike } from './client'
import { MINI_FILES, miniServer } from './device/miniFiles'
import { log } from '../log'

// The on-device decision model's main side (docs/decisions.md › On this device). Atelier's own small
// decision model (an ONNX file of 34 MB, distilled from large decision models for exactly these
// questions) answers in a few milliseconds on the CPU, and nothing leaves this computer. It runs in a
// utility process (deviceHelper.ts) that starts on the first question and stops after a quiet spell,
// so a crash there is a failed request (the rule decides), never a crash of the browser.
//
// It speaks to the rest of the decider as a provider like any other: requests to atelier-device://
// go through route() instead of the network, so timeouts, compare mode, comparisons and the readers'
// cutoffs work exactly as for a hosted model.

/** The model files a usable folder holds (the student export of the atelier-decisions project). */
export const DEVICE_MODEL_FILES = ['model.emb4.int8.onnx', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json'] as const
export const DEVICE_MODEL_ID = 'atelier-nano'

export function deviceModelDir(o: { packaged: boolean; resourcesPath: string; appPath: string; env?: NodeJS.ProcessEnv }): string | null {
  const env = o.env ?? process.env
  const dir = env.ATELIER_DECISION_MODEL || (o.packaged ? join(o.resourcesPath, 'decision-model') : join(o.appPath, 'native', 'decisions', 'build'))
  return DEVICE_MODEL_FILES.every((f) => existsSync(join(dir, f))) ? dir : null
}

/** The mini's folder (an optional download, deviceMini.ts) when its files and server are all here, else null. */
export function deviceMiniDir(dir: string, platform: NodeJS.Platform = process.platform): string | null {
  return MINI_FILES.every((f) => existsSync(join(dir, f))) && existsSync(miniServer(dir, platform)) ? dir : null
}

/** What the helper sends back: one reply per request id, and the mini's server once it runs. */
type HelperReply = { id: number; type: 'result'; reply: unknown } | { id: number; type: 'error'; message: string } | { type: 'server'; pid: number }

export interface DeviceProcess {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'exit', listener: () => void): unknown
  kill(): boolean | void
}

/** Starts the helper: Electron's utility process in the app, anything with the same shape in tests. */
export type DeviceSpawner = (modelDir: string, miniDir: string | null) => DeviceProcess

const TIMEOUT_MS = 10_000
/** With the mini: loading it takes a few seconds cold, and a request of many questions a few tenths each. Callers' own timeouts are shorter for most decisions. */
const MINI_TIMEOUT_MS = 30_000
const IDLE_MS = 5 * 60_000
/** Crashes in a row before the model counts as unavailable until Atelier restarts. */
const CRASHES_MAX = 3

interface Pending {
  resolve(reply: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface DeviceDecisionsOptions {
  /** The model's folder, read on each start (null: not installed). */
  modelDir(): string | null
  /** The mini's folder (deviceMiniDir), read on each start (null or absent: not installed, the small model alone). */
  miniDir?(): string | null
  spawner: DeviceSpawner
  idleMs?: number
  /** Stops the mini's server (default process.kill). */
  kill?(pid: number): void
}

export class DeviceDecisions {
  readonly #opts: DeviceDecisionsOptions
  #proc: DeviceProcess | null = null
  /** The mini's folder the running helper was started with. */
  #procMini: string | null = null
  /** The mini's server, started by the helper. */
  #server: number | null = null
  #nextId = 1
  readonly #pending = new Map<number, Pending>()
  #idle: ReturnType<typeof setTimeout> | null = null
  #crashes = 0

  constructor(opts: DeviceDecisionsOptions) {
    this.#opts = opts
  }

  /** Its files are here and it hasn't kept crashing. */
  available(): boolean {
    return this.#crashes < CRASHES_MAX && this.#opts.modelDir() !== null
  }

  /** `next` for every address but atelier-device://, which this computer answers. */
  route(next: FetchLike): FetchLike {
    return async (url, init) => {
      if (!url.startsWith(DEVICE_SCHEME)) return next(url, init)
      const reply = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      })
      if (!this.available()) return reply(503, 'The on-device decision model is not installed.')
      if (init.method === 'GET' && url.endsWith('/models')) return reply(200, { data: [{ id: DEVICE_MODEL_ID }] })
      if (init.method !== 'POST' || !url.endsWith('/systemone')) return reply(404, 'Not found')
      let body: { state?: unknown; questions?: unknown }
      try {
        body = JSON.parse(init.body ?? '')
      } catch {
        return reply(400, 'The request is not JSON.')
      }
      try {
        const answer = await this.#request({ state: body.state, questions: body.questions }, init.signal)
        return reply(200, answer)
      } catch (err) {
        if (init.signal.aborted) throw err
        return reply(err instanceof RequestError ? 422 : 503, err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** Loads the small model ahead of the first question (it takes up to a second cold), so that one is answered in time too. The mini loads on its first question, not here: it needs up to 2 GB of memory. */
  warm(): void {
    if (!this.available()) return
    this.#request({ state: '', questions: { warm: { type: 'noul', instructions: 'warm-up' } } }, new AbortController().signal, true).catch(() => undefined)
  }

  /** Stops the helper now (pending questions fail, so the rule decides); the next question starts it again. Before the mini's files are swapped or removed. */
  restart(): void {
    this.#stop()
  }

  dispose(): void {
    this.#stop()
  }

  #request(request: { state: unknown; questions: unknown }, signal: AbortSignal, nanoOnly = false): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new Error('The decision was stopped.'))
    const proc = this.#ensure()
    if (!proc) return Promise.reject(new Error('The on-device decision model is not available.'))
    const id = this.#nextId++
    // A stopped request also stops the helper working on it, so the mini's queue moves on.
    const cancel = (): void => {
      try {
        proc.postMessage({ cancel: id })
      } catch {
        // Gone already.
      }
    }
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer)
        this.#pending.delete(id)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        done()
        cancel()
        reject(new Error('The decision was stopped.'))
      }
      const timer = setTimeout(
        () => {
          done()
          cancel()
          reject(new Error('The on-device decision model took too long.'))
        },
        this.#procMini ? MINI_TIMEOUT_MS : TIMEOUT_MS,
      )
      signal.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        resolve: (value) => {
          done()
          resolve(value)
        },
        reject: (err) => {
          done()
          reject(err)
        },
        timer,
      })
      try {
        proc.postMessage(nanoOnly ? { id, request, nanoOnly } : { id, request })
      } catch (err) {
        done()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      this.#touch()
    })
  }

  #ensure(): DeviceProcess | null {
    const mini = this.#opts.miniDir?.() ?? null
    // The mini was installed or removed since the helper started: a new one picks that up, once nothing is waiting on this one.
    if (this.#proc && mini !== this.#procMini && this.#pending.size === 0) this.#stop()
    if (this.#proc) return this.#proc
    const dir = this.#opts.modelDir()
    if (!dir || this.#crashes >= CRASHES_MAX) return null
    let proc: DeviceProcess
    try {
      proc = this.#opts.spawner(dir, mini)
    } catch (err) {
      log.warn('decisions', 'Could not start the on-device decision model', { error: err instanceof Error ? err.message : String(err) })
      this.#crashes = CRASHES_MAX
      return null
    }
    this.#proc = proc
    this.#procMini = mini
    proc.on('message', (message) => this.#read(message))
    proc.once('exit', () => {
      if (this.#proc !== proc) return
      const hadWork = this.#pending.size > 0
      this.#proc = null
      this.#procMini = null
      this.#killServer()
      if (hadWork) this.#crashes++
      for (const [, p] of this.#pending) p.reject(new Error('The on-device decision model stopped.'))
      this.#pending.clear()
    })
    return proc
  }

  #read(message: unknown): void {
    const m = message as HelperReply
    if (!m || typeof m !== 'object') return
    if (m.type === 'server') {
      if (typeof m.pid === 'number') this.#server = m.pid
      return
    }
    if (typeof m.id !== 'number') return
    const p = this.#pending.get(m.id)
    if (!p) return
    this.#crashes = 0
    if (m.type === 'result') p.resolve(m.reply)
    else p.reject(m.type === 'error' && /^bad request:/i.test(m.message) ? new RequestError(m.message) : new Error(m.type === 'error' ? m.message : 'Unexpected reply'))
  }

  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = setTimeout(() => {
      if (this.#pending.size === 0) this.#stop()
      else this.#touch()
    }, this.#opts.idleMs ?? IDLE_MS)
    this.#idle.unref?.()
  }

  #stop(): void {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = null
    const proc = this.#proc
    this.#proc = null
    this.#procMini = null
    for (const [, p] of this.#pending) p.reject(new Error('The on-device decision model was stopped.'))
    this.#pending.clear()
    try {
      proc?.kill()
    } catch {
      // Already gone.
    }
    this.#killServer()
  }

  /** The mini's server outlives a killed helper on Windows (no process groups there), so it is stopped by its id. */
  #killServer(): void {
    const pid = this.#server
    this.#server = null
    if (pid === null) return
    try {
      ;(this.#opts.kill ?? ((p: number) => process.kill(p)))(pid)
    } catch {
      // Already gone.
    }
  }
}

/** A request the model can't take (no questions, a malformed question): the client reads it as a bad request. */
class RequestError extends Error {}
