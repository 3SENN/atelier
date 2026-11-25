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

import { DeviceDecisions, deviceStepDir, type DeviceProcess } from '../src/main/decisions/device'
import { STEP_FILES } from '../src/main/decisions/device/step'
import { encodeStep, type StepInput } from '../src/main/decisions/device/stepFormat'
import { STEP_MANIFEST } from '../src/main/decisions/device/stepManifest'
import { MiniInstaller, type Download, type MiniManifest } from '../src/main/decisions/deviceMini'

// atelier-step on this computer (docs/decisions.md › Browser tasks): its folder, its requests through the decision
// helper, its download, and (with ATELIER_STEP_PARITY=<model folder>) the same token ids and answers as training.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-step-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const step: StepInput = { goal: 'Order it', values: [{ name: 'size', value: '43' }], before: [], page: 'Shop (/p/1)', elements: [{ role: 'field', label: 'Size', value: '' }, { role: 'button', label: 'Add to cart' }] }

class FakeHelper extends EventEmitter implements DeviceProcess {
  sent: unknown[] = []
  postMessage(message: unknown): void {
    this.sent.push(message)
    const m = message as { id: number; step?: StepInput }
    queueMicrotask(() => this.emit('message', { id: m.id, type: 'result', reply: { op: { click: 0, type: 1, done: 0, blocked: 0 }, click: [null, 1], type: [1, null], values: [[0, 1], null], tokens: 40, ms: 3 } }))
  }
  kill(): boolean {
    return true
  }
}

describe('atelier-step on this computer', () => {
  it('is installed only when every file is in its folder', () => {
    expect(deviceStepDir(dir)).toBeNull()
    for (const f of STEP_FILES.slice(0, -1)) writeFileSync(join(dir, f), 'x')
    expect(deviceStepDir(dir)).toBeNull()
    writeFileSync(join(dir, STEP_FILES.at(-1)!), 'x')
    expect(deviceStepDir(dir)).toBe(dir)
  })

  it('answers browser steps in the decision helper, with or without the small decision model', async () => {
    const spawned: Array<[string, string | null, string | null]> = []
    let stepDir: string | null = null
    const helper = new FakeHelper()
    const device = new DeviceDecisions({ modelDir: () => null, stepDir: () => stepDir, spawner: (d, m, s) => (spawned.push([d, m, s]), helper) })
    expect(device.stepAvailable()).toBe(false)
    await expect(device.step(step, new AbortController().signal)).rejects.toThrow(/not installed/)
    stepDir = dir
    expect(device.stepAvailable()).toBe(true)
    // Decisions still read the small model as missing: only steps are answered.
    expect(device.available()).toBe(false)
    const answer = await device.step(step, new AbortController().signal)
    expect(answer.op.type).toBe(1)
    expect(spawned).toEqual([['', null, dir]])
    expect(helper.sent).toEqual([{ id: 1, step }])
    device.dispose()
  })

  it('starts a new helper when atelier-step is installed or removed', async () => {
    const spawned: Array<string | null> = []
    let stepDir: string | null = null
    const device = new DeviceDecisions({ modelDir: () => dir, stepDir: () => stepDir, spawner: (_d, _m, s) => (spawned.push(s), new FakeHelper()) })
    device.warm()
    await new Promise((r) => setTimeout(r, 0))
    stepDir = join(dir, 'step')
    await device.step(step, new AbortController().signal)
    expect(spawned).toEqual([null, join(dir, 'step')])
    device.dispose()
  })
})

// ── The download: model files only, checked against the manifest compiled into Atelier ──

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('atelier-step’s download', () => {
  it('lists every file the runtime needs, pinned to the version’s tag', () => {
    expect(STEP_MANIFEST.model.map((f) => f.path).sort()).toEqual([...STEP_FILES].sort())
    expect(STEP_MANIFEST.base).toMatch(/\/resolve\/step-v0\.1\/releases\/step-v0\.1\/model\/$/)
    expect(STEP_MANIFEST.model.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0)).toBe(true)
  })

  it('downloads the model files with no server, checks them and swaps the folder in', async () => {
    const bodies = new Map<string, Buffer>(STEP_FILES.map((f, i) => [f, Buffer.alloc(500 + i * 101, i + 1)]))
    const manifest: MiniManifest = { version: 'step-test', base: 'https://models.example/step/', model: STEP_FILES.map((f) => ({ path: f, url: f, size: bodies.get(f)!.length, sha256: sha(bodies.get(f)!) })), servers: {} }
    const requests: string[] = []
    const download: Download = async (url) => {
      const key = url.replace('https://models.example/step/', '')
      requests.push(key)
      const body = bodies.get(key)
      return body ? { status: 200, body: (async function* () { yield body })() } : { status: 404, body: null }
    }
    let released = 0
    const target = join(dir, 'decision-model-step')
    const installer = new MiniInstaller({ dir: target, manifest, download, release: () => released++, needsServer: false, installed: deviceStepDir, platform: 'plan9-x64' })
    expect(installer.status()).toEqual({ state: 'absent', total: [...bodies.values()].reduce((s, b) => s + b.length, 0) })
    await installer.install()
    expect(installer.status()).toEqual({ state: 'ready', external: false })
    expect(requests.sort()).toEqual([...STEP_FILES].sort())
    expect(readFileSync(join(target, 'step.json'))).toEqual(bodies.get('step.json'))
    expect(released).toBe(1)
    // A newer Atelier expects a newer version: the old folder counts as not installed, and is replaced by its download.
    const next = new MiniInstaller({ dir: target, manifest: { ...manifest, version: 'step-test-2' }, download, release: () => released++, needsServer: false, installed: deviceStepDir })
    expect(next.dir()).toBeNull()
    expect(next.status().state).toBe('absent')
    await next.install()
    expect(next.dir()).toBe(target)
    expect(JSON.parse(readFileSync(join(target, 'version.json'), 'utf8'))).toEqual({ version: 'step-test-2' })
    expect(existsSync(join(target, 'downloading.json'))).toBe(false)
    next.remove()
    expect(existsSync(target)).toBe(false)
    expect(next.status().state).toBe('absent')
  })

  it('leaves a folder set from outside alone', () => {
    mkdirSync(join(dir, 'mine'))
    for (const f of STEP_FILES) writeFileSync(join(dir, 'mine', f), 'x')
    const installer = new MiniInstaller({ dir: join(dir, 'mine'), manifest: STEP_MANIFEST, download: async () => ({ status: 500, body: null }), release: () => undefined, needsServer: false, installed: deviceStepDir, external: true })
    expect(installer.status()).toEqual({ state: 'ready', external: true })
    installer.remove()
    expect(deviceStepDir(join(dir, 'mine'))).toBe(join(dir, 'mine'))
  })
})

// The atelier-decisions project's parity fixtures (releases/step-v0.1/model/parity.jsonl): the same token ids and marker
// positions from the same step, and the same logits from the same model file. Needs the model, so it runs when
// ATELIER_STEP_PARITY names a folder with model.int8.onnx and parity.jsonl.
describe.skipIf(!process.env.ATELIER_STEP_PARITY)('atelier-step’s parity with its training code', () => {
  it('encodes and answers every fixture as PyTorch and the exported file did', async () => {
    const { StepDecider } = await import('../src/main/decisions/device/step')
    const folder = process.env.ATELIER_STEP_PARITY ?? ''
    const model = await StepDecider.load(folder, { file: 'model.int8.onnx', raw: true })
    const rows = readFileSync(join(folder, 'parity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { step: StepInput; ids: number[]; els: number[]; vals: number[]; op: number[]; el: number[]; val: number[][] })
    let same = 0
    let worst = 0
    for (const r of rows) {
      const enc = encodeStep(model.tok, r.step)
      if (JSON.stringify([enc.ids, enc.els, enc.vals]) === JSON.stringify([r.ids, r.els, r.vals])) same++
      const out = await model.logits(r.ids, r.els, r.vals)
      worst = Math.max(worst, ...out.op.map((x, i) => Math.abs(x - r.op[i]!)), ...out.el.map((x, i) => Math.abs(x - r.el[i]!)), ...out.val.flat().map((x, i) => Math.abs(x - r.val.flat()[i]!)))
    }
    await model.release()
    expect(rows.length).toBeGreaterThan(100)
    expect(same).toBe(rows.length)
    expect(worst).toBeLessThan(1e-3)
  }, 120_000)
})
