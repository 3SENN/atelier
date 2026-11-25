/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/log', () => ({ log: { warn: () => undefined, debug: () => undefined, info: () => undefined } }))

import type { FetchLike } from '../src/main/decisions/client'
import { DeviceDecisions, deviceMiniDir, type DeviceProcess } from '../src/main/decisions/device'
import { cascade, unsettled, type CascadeParts, type Decided } from '../src/main/decisions/device/cascade'
import { MINI_FILES } from '../src/main/decisions/device/miniFiles'
import type { Answer } from '../src/main/decisions/device/nano'
import { verdict } from '../src/main/decisions/device/readers'
import { MiniInstaller, type Download, type MiniManifest } from '../src/main/decisions/deviceMini'

// atelier-mini, the on-device model's optional larger half (docs/decisions.md › On this computer): the cascade
// (small model first, the mini for what it leaves open, the rule last), its download, and its server's lifetime.

const WAITS = 'This is the end of an assistant’s reply. Is it waiting on you?'
const noul = (p: number): Answer => ({ type: 'noul', noul: p })
const usage = { input_tokens: 10, output_tokens: 0 }

function parts(nano: Record<string, Answer>, mini: Record<string, Answer> | 'fails' | null): CascadeParts & { asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    nano: { decide: async () => ({ answers: nano, usage }) },
    mini:
      mini === null
        ? null
        : async () => {
            if (mini === 'fails') throw new Error('llama-server did not start')
            return {
              decide: async (request: { questions: Record<string, unknown> }): Promise<Decided> => {
                asked.push(Object.keys(request.questions))
                return { answers: Object.fromEntries(Object.keys(request.questions).map((k) => [k, mini[k] ?? noul(0.5)])), usage }
              },
            }
          },
  }
}

describe('the on-device cascade', () => {
  const request = {
    state: 'Here is the summary you asked for.',
    questions: {
      waits: { type: 'noul' as const, instructions: WAITS },
      label: { type: 'noul' as const, instructions: 'Is this email a receipt?' },
    },
  }

  it('keeps the small model’s sure answers and sends the rest to the mini', async () => {
    const p = parts({ waits: noul(0.02), label: { type: 'refusal', reason: 'an open question' } }, { label: noul(0.97) })
    const out = await cascade(p, request)
    expect(p.asked).toEqual([['label']])
    expect(out.routes).toEqual({ waits: 'nano', label: 'mini' })
    expect(out.answers.waits).toEqual(noul(0.02))
    expect(out.answers.label).toEqual(noul(0.97))
    expect(out.usage.input_tokens).toBe(20)
  })

  it('reads sure the way Atelier’s readers do: waits needs 0.75 or 0.25, an open yes/no 0.7 or 0.3', () => {
    expect(unsettled(request, { waits: noul(0.8), label: noul(0.72) })).toEqual([])
    expect(unsettled(request, { waits: noul(0.7), label: noul(0.72) })).toEqual(['waits'])
    expect(unsettled(request, { waits: noul(0.2), label: noul(0.35) })).toEqual(['label'])
    expect(verdict('dictation', ['false', 'true'], [0.05, 0.95])).toBe(true)
    expect(verdict('dictation', ['false', 'true'], [0.95, 0.05])).toBeNull()
    expect(verdict('open', ['0', '1', '2'], [0.1, 0.7, 0.2])).toBe(1)
    expect(verdict('open', ['a', 'b'], [0.6, 0.4])).toBeNull()
  })

  it('asks nothing more when every answer is sure, or when the mini is not installed', async () => {
    const sure = parts({ waits: noul(0.9), label: noul(0.1) }, {})
    expect((await cascade(sure, request)).routes).toEqual({ waits: 'nano', label: 'nano' })
    expect(sure.asked).toEqual([])
    const without = parts({ waits: noul(0.5), label: { type: 'refusal', reason: 'x' } }, null)
    const out = await cascade(without, request)
    expect(out.answers.label).toEqual({ type: 'refusal', reason: 'x' })
  })

  it('keeps the small model’s answers when the mini fails or the request was stopped', async () => {
    const failing = parts({ waits: noul(0.5), label: { type: 'refusal', reason: 'x' } }, 'fails')
    const out = await cascade(failing, request)
    expect(out.routes).toEqual({ waits: 'nano', label: 'nano' })
    expect(out.answers.label).toEqual({ type: 'refusal', reason: 'x' })
    const stopped = parts({ waits: noul(0.5), label: noul(0.5) }, {})
    await cascade(stopped, request, () => true)
    expect(stopped.asked).toEqual([])
  })
})

// The training code's own token ids for 600-odd questions (parity.jsonl in the mini's runtime folder, from the
// atelier-decisions project's student/export_mini.py): the mini reads text exactly as it learned it. Needs the
// 20 MB tokenizer, so it runs when ATELIER_MINI_PARITY names that folder.
describe.skipIf(!process.env.ATELIER_MINI_PARITY)('the mini’s prompts', () => {
  it('are the same token ids the training code makes', async () => {
    const { MiniDecider } = await import('../src/main/decisions/device/mini')
    const folder = process.env.ATELIER_MINI_PARITY ?? ''
    const mini = await MiniDecider.load(folder, { serve: false })
    let same = 0
    let total = 0
    for (const line of readFileSync(join(folder, 'parity.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const { request, ids, mapped } = JSON.parse(line) as { request: { state: never; questions: Record<string, never> }; ids: Record<string, number[]>; mapped?: Record<string, number[]> }
      for (const [key, q] of Object.entries(request.questions)) {
        total++
        const ours = mini.ids(request.state, q)
        // With a trimmed vocabulary (vocab.json), the ids as sent must match the training code's mapping too.
        if (JSON.stringify(ours) === JSON.stringify(ids[key]) && (!mapped || JSON.stringify(mini.sent(ours)) === JSON.stringify(mapped[key]))) same++
      }
    }
    expect(total).toBeGreaterThan(500)
    expect(same).toBe(total)
  })
})

// ── The download ──

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function fixture(): { manifest: MiniManifest; bodies: Map<string, Buffer> } {
  const bodies = new Map<string, Buffer>()
  const file = (path: string, url: string, bytes: Buffer): { path: string; url: string; size: number; sha256: string } => {
    bodies.set(url, bytes)
    return { path, url, size: bytes.length, sha256: sha(bytes) }
  }
  const model = MINI_FILES.map((f, i) => file(f, `model/${f}`, Buffer.alloc(1000 + i * 337, i + 1)))
  return {
    bodies,
    manifest: {
      version: 'v-test',
      base: 'https://models.example/atelier-mini/',
      model,
      servers: { 'linux-x64': [file('llama-server', 'server/linux-x64/llama-server', Buffer.from('#!/bin/sh\necho server\n')), file('libllama.so', 'server/linux-x64/libllama.so', Buffer.alloc(4000, 7))] },
    },
  }
}

/** Serves the fixture's files in chunks of 256 bytes; honours ranges unless told not to. */
function server(bodies: Map<string, Buffer>, opts: { ranges?: boolean; breakAfter?: number; corrupt?: string } = {}): Download & { requests: Array<{ url: string; range?: string }> } {
  const requests: Array<{ url: string; range?: string }> = []
  let sent = 0
  const download = async (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => {
    const key = url.replace('https://models.example/atelier-mini/', '')
    requests.push({ url: key, range: init.headers.range })
    let body = bodies.get(key)
    if (!body) return { status: 404, body: null }
    if (opts.corrupt === key) body = Buffer.concat([body.subarray(0, -1), Buffer.from([body[body.length - 1]! ^ 1])])
    let status = 200
    const m = /^bytes=(\d+)-$/.exec(init.headers.range ?? '')
    if (m && opts.ranges !== false) {
      body = body.subarray(Number(m[1]))
      status = 206
    }
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < body!.length; i += 256) {
        if (init.signal.aborted) throw new Error('aborted')
        if (opts.breakAfter !== undefined && sent >= opts.breakAfter) throw new Error('connection reset')
        const chunk = body!.subarray(i, i + 256)
        sent += chunk.length
        yield chunk
      }
    }
    return { status, body: chunks() }
  }
  return Object.assign(download, { requests })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-mini-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the mini’s download', () => {
  const target = (): string => join(dir, 'decision-model-mini')

  it('downloads every file, checks it and swaps the folder in whole', async () => {
    const { manifest, bodies } = fixture()
    const release = vi.fn()
    const mini = new MiniInstaller({ dir: target(), manifest, download: server(bodies), release, platform: 'linux-x64' })
    expect(mini.status()).toEqual({ state: 'absent', total: [...bodies.values()].reduce((s, b) => s + b.length, 0) })
    await mini.install()
    expect(mini.status()).toEqual({ state: 'ready', external: false })
    expect(mini.dir()).toBe(target())
    expect(deviceMiniDir(target(), 'linux')).toBe(target())
    expect(readFileSync(join(target(), 'server', 'libllama.so')).length).toBe(4000)
    expect(existsSync(`${target()}.partial`)).toBe(false)
    expect(release).toHaveBeenCalledOnce()
  })

  it('throws away a file that does not match its checksum and installs nothing', async () => {
    const { manifest, bodies } = fixture()
    const mini = new MiniInstaller({ dir: target(), manifest, download: server(bodies, { corrupt: 'model/readout.f32' }), release: () => undefined, platform: 'linux-x64' })
    await mini.install()
    const s = mini.status()
    expect(s.state).toBe('failed')
    expect(s.state === 'failed' && s.error).toMatch(/readout\.f32 did not match its checksum/)
    expect(existsSync(target())).toBe(false)
    expect(existsSync(join(`${target()}.partial`, 'readout.f32'))).toBe(false)
  })

  it('resumes a broken download where it stopped, with a range request', async () => {
    const { manifest, bodies } = fixture()
    const first = new MiniInstaller({ dir: target(), manifest, download: server(bodies, { breakAfter: 1500 }), release: () => undefined, platform: 'linux-x64' })
    await first.install()
    expect(first.status().state).toBe('failed')
    const again = server(bodies)
    const second = new MiniInstaller({ dir: target(), manifest, download: again, release: () => undefined, platform: 'linux-x64' })
    await second.install()
    expect(second.status()).toEqual({ state: 'ready', external: false })
    expect(again.requests.some((r) => r.range !== undefined)).toBe(true)
    // The file that finished before the break is not fetched again.
    expect(again.requests.map((r) => r.url)).not.toContain('model/mini.gguf')
  })

  it('starts a file over when the server ignores the range', async () => {
    const { manifest, bodies } = fixture()
    await new MiniInstaller({ dir: target(), manifest, download: server(bodies, { breakAfter: 1500 }), release: () => undefined, platform: 'linux-x64' }).install()
    const mini = new MiniInstaller({ dir: target(), manifest, download: server(bodies, { ranges: false }), release: () => undefined, platform: 'linux-x64' })
    await mini.install()
    expect(mini.status()).toEqual({ state: 'ready', external: false })
    expect(readFileSync(join(target(), 'readout.f32')).equals(bodies.get('model/readout.f32')!)).toBe(true)
  })

  it('stops without an error, and removes what it installed', async () => {
    const { manifest, bodies } = fixture()
    const mini = new MiniInstaller({ dir: target(), manifest, download: server(bodies), release: () => undefined, platform: 'linux-x64' })
    const running = mini.install()
    expect(mini.status().state).toBe('downloading')
    mini.cancel()
    await running
    expect(mini.status().state).toBe('absent')
    await mini.install()
    expect(mini.status().state).toBe('ready')
    const release = vi.fn()
    const removing = new MiniInstaller({ dir: target(), manifest, download: server(bodies), release, platform: 'linux-x64' })
    removing.remove()
    expect(release).toHaveBeenCalledOnce()
    expect(existsSync(target())).toBe(false)
    expect(removing.status().state).toBe('absent')
  })

  it('offers no download without a location or a build for this platform, and never touches a folder set from outside', async () => {
    const { manifest, bodies } = fixture()
    expect(new MiniInstaller({ dir: target(), manifest: { ...manifest, base: '' }, download: server(bodies), release: () => undefined, platform: 'linux-x64' }).status()).toEqual({ state: 'unavailable' })
    expect(new MiniInstaller({ dir: target(), manifest, download: server(bodies), release: () => undefined, platform: 'freebsd-x64' }).status()).toEqual({ state: 'unavailable' })
    const outside = join(dir, 'dev-mini')
    mkdirSync(join(outside, 'server'), { recursive: true })
    for (const f of MINI_FILES) writeFileSync(join(outside, f), 'x')
    writeFileSync(join(outside, 'server', 'llama-server'), 'x')
    const external = new MiniInstaller({ dir: outside, manifest, download: server(bodies), release: () => undefined, platform: 'linux-x64', external: true })
    expect(external.status()).toEqual({ state: 'ready', external: true })
    external.remove()
    expect(existsSync(outside)).toBe(true)
  })

  it('refuses a manifest path that leaves the folder', async () => {
    const { manifest, bodies } = fixture()
    bodies.set('model/evil', Buffer.from('x'))
    const evil = { ...manifest, model: [...manifest.model, { path: '../escaped', url: 'model/evil', size: 1, sha256: sha(Buffer.from('x')) }] }
    const mini = new MiniInstaller({ dir: target(), manifest: evil, download: server(bodies), release: () => undefined, platform: 'linux-x64' })
    await mini.install()
    expect(mini.status().state).toBe('failed')
    expect(existsSync(join(dir, 'escaped'))).toBe(false)
  })
})

// ── The helper, with the mini ──

class FakeHelper extends EventEmitter implements DeviceProcess {
  sent: unknown[] = []
  killed = false
  constructor(private readonly onMessage: (m: { id?: number; request?: unknown; cancel?: number; nanoOnly?: boolean }, self: FakeHelper) => void) {
    super()
  }
  postMessage(message: unknown): void {
    this.sent.push(message)
    queueMicrotask(() => this.onMessage(message as { id?: number }, this))
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

const network: FetchLike = async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' })
const post = (body: unknown, signal = new AbortController().signal) => ({ method: 'POST', headers: {}, body: JSON.stringify(body), signal })

describe('the on-device model with the mini', () => {
  it('starts the helper with the mini’s folder, and stops the mini’s server with it', async () => {
    const spawned: Array<[string, string | null]> = []
    const killed: number[] = []
    let helper: FakeHelper | null = null
    const device = new DeviceDecisions({
      modelDir: () => '/model',
      miniDir: () => '/mini',
      spawner: (d, m) => {
        spawned.push([d, m])
        helper = new FakeHelper((msg, self) => {
          if (msg.id === undefined) return
          self.emit('message', { type: 'server', pid: 4242 })
          self.emit('message', { id: msg.id, type: 'result', reply: { model: 'atelier-nano+mini', answers: {}, usage: {} } })
        })
        return helper
      },
      kill: (pid) => killed.push(pid),
    })
    const res = await device.route(network)('atelier-device://nano/v1/systemone', post({ state: 'x', questions: { q: { type: 'noul' } } }))
    expect(res.status).toBe(200)
    expect(spawned).toEqual([['/model', '/mini']])
    device.dispose()
    expect(helper!.killed).toBe(true)
    expect(killed).toEqual([4242])
  })

  it('starts a new helper once the mini is installed or removed, when nothing is waiting', async () => {
    let mini: string | null = null
    const spawned: Array<string | null> = []
    const device = new DeviceDecisions({
      modelDir: () => '/model',
      miniDir: () => mini,
      spawner: (_d, m) => {
        spawned.push(m)
        return new FakeHelper((msg, self) => {
          if (msg.id !== undefined) self.emit('message', { id: msg.id, type: 'result', reply: {} })
        })
      },
    })
    const ask = (): Promise<unknown> => device.route(network)('atelier-device://nano/v1/systemone', post({ state: 'x', questions: { q: { type: 'noul' } } }))
    await ask()
    await ask()
    mini = '/mini'
    await ask()
    mini = null
    await ask()
    expect(spawned).toEqual([null, '/mini', null])
    device.dispose()
  })

  it('tells the helper when a request is stopped, and warms only the small model', async () => {
    let helper: FakeHelper | null = null
    const device = new DeviceDecisions({
      modelDir: () => '/model',
      miniDir: () => '/mini',
      spawner: () => {
        helper = new FakeHelper(() => undefined) // never answers
        return helper
      },
    })
    const stop = new AbortController()
    const pending = device.route(network)('atelier-device://nano/v1/systemone', post({ state: 'x', questions: { q: { type: 'noul' } } }, stop.signal))
    await Promise.resolve()
    stop.abort()
    await expect(pending).rejects.toThrow(/stopped/)
    expect(helper!.sent).toContainEqual({ cancel: 1 })
    device.warm()
    expect(helper!.sent.at(-1)).toMatchObject({ id: 2, nanoOnly: true })
    device.dispose()
  })
})
