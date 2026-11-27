/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/log', () => ({ log: { warn: () => undefined, debug: () => undefined, info: () => undefined } }))

import type { FetchLike } from '../src/main/decisions/client'
import { DEVICE_MODEL_FILES, DeviceDecisions, deviceModelDir, type DeviceProcess } from '../src/main/decisions/device'

// The on-device decision model's main side (docs/decisions.md › On this device): requests to atelier-device://
// go to a helper process instead of the network, which starts on the first one, and a helper that keeps
// crashing makes the model unavailable (so the rule decides).

class FakeHelper extends EventEmitter implements DeviceProcess {
  sent: Array<{ id: number; request: unknown }> = []
  killed = false
  constructor(private readonly answer: (request: { questions?: unknown }) => unknown) {
    super()
  }
  postMessage(message: unknown): void {
    const m = message as { id: number; request: { questions?: unknown } }
    this.sent.push(m)
    queueMicrotask(() => {
      const reply = this.answer(m.request)
      if (reply === 'crash') this.emit('exit')
      else if (reply !== 'silent') this.emit('message', { id: m.id, ...(reply as object) })
    })
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

const network: FetchLike = async () => ({ status: 200, ok: true, json: async () => ({ network: true }), text: async () => 'network' })
const post = (body: unknown, signal = new AbortController().signal) => ({ method: 'POST', headers: {}, body: JSON.stringify(body), signal })
const request = { state: 'thanks!', questions: { waits: { type: 'noul' } } }
const reply = { model: 'atelier-nano', answers: { waits: { type: 'noul', noul: 0.04 } }, usage: { input_tokens: 9, output_tokens: 0 } }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-device-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the on-device decision model', () => {
  it('is installed only when every file of the model is in its folder', () => {
    const model = join(dir, 'decision-model')
    mkdirSync(model)
    const where = { packaged: true, resourcesPath: dir, appPath: dir, env: {} }
    expect(deviceModelDir(where)).toBeNull()
    for (const f of DEVICE_MODEL_FILES.slice(0, -1)) writeFileSync(join(model, f), 'x')
    expect(deviceModelDir(where)).toBeNull()
    writeFileSync(join(model, DEVICE_MODEL_FILES.at(-1)!), 'x')
    expect(deviceModelDir(where)).toBe(model)
    expect(deviceModelDir({ ...where, env: { ATELIER_DECISION_MODEL: join(dir, 'elsewhere') } })).toBeNull()
  })

  it('answers atelier-device:// in its helper, started on the first question, and leaves every other address to the network', async () => {
    let started = 0
    const helper = new FakeHelper(() => ({ type: 'result', reply }))
    const device = new DeviceDecisions({ modelDir: () => dir, spawner: () => (started++, helper) })
    const fetch = device.route(network)
    expect(await (await fetch('https://api.typesafe.ai/v1/systemone', post(request))).json()).toEqual({ network: true })
    expect(started).toBe(0)
    const models = await fetch('atelier-device://nano/v1/models', { method: 'GET', headers: {}, signal: new AbortController().signal })
    expect(await models.json()).toEqual({ data: [{ id: 'atelier-nano' }] })
    const res = await fetch('atelier-device://nano/v1/systemone', post({ model: 'atelier-nano', ...request }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(reply)
    expect(helper.sent).toEqual([{ id: 1, request }])
    await fetch('atelier-device://nano/v1/systemone', post(request))
    expect(started).toBe(1)
    device.dispose()
    expect(helper.killed).toBe(true)
  })

  it('loads ahead of the first question when asked to, and only when its files are here', async () => {
    let started = 0
    const helper = new FakeHelper(() => ({ type: 'result', reply }))
    new DeviceDecisions({ modelDir: () => null, spawner: () => (started++, helper) }).warm()
    expect(started).toBe(0)
    const device = new DeviceDecisions({ modelDir: () => dir, spawner: () => (started++, helper) })
    device.warm()
    expect(started).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(helper.sent).toHaveLength(1)
    device.dispose()
  })

  it('lets the helper go when memory is short, unless a question is waiting on it', async () => {
    let started = 0
    let answers = false
    const helpers: FakeHelper[] = []
    const device = new DeviceDecisions({ modelDir: () => dir, spawner: () => (started++, helpers.push(new FakeHelper(() => (answers ? { type: 'result', reply } : 'silent'))), helpers.at(-1)!) })
    expect(device.releaseIdle()).toBe(false) // nothing runs yet
    device.warm()
    expect(device.releaseIdle()).toBe(false) // the warm-up is still waiting
    expect(helpers[0]!.killed).toBe(false)
    device.restart()
    answers = true
    device.warm()
    await new Promise((r) => setTimeout(r, 0))
    expect(device.releaseIdle()).toBe(true)
    expect(helpers[1]!.killed).toBe(true)
    device.warm() // the next question starts it again
    expect(started).toBe(3)
    device.dispose()
  })

  it('reads as not installed without its files: nothing starts and the provider says so', async () => {
    let started = 0
    const device = new DeviceDecisions({ modelDir: () => null, spawner: () => (started++, new FakeHelper(() => ({}))) })
    expect(device.available()).toBe(false)
    const res = await device.route(network)('atelier-device://nano/v1/systemone', post(request))
    expect(res.status).toBe(503)
    expect(started).toBe(0)
  })

  it('turns a request the model cannot take into a bad request, and anything else it reports into a failure', async () => {
    const helper = new FakeHelper((r) =>
      r.questions && Object.keys(r.questions as object).length ? { type: 'error', message: 'out of memory' } : { type: 'error', message: 'bad request: a request needs at least one question' },
    )
    const fetch = new DeviceDecisions({ modelDir: () => dir, spawner: () => helper }).route(network)
    expect((await fetch('atelier-device://nano/v1/systemone', post({ state: 'x', questions: {} }))).status).toBe(422)
    expect((await fetch('atelier-device://nano/v1/systemone', post(request))).status).toBe(503)
    expect((await fetch('atelier-device://nano/v1/systemone', { ...post(request), body: '{nope' })).status).toBe(400)
  })

  it('gives up on a helper that keeps crashing while it works, until Atelier restarts', async () => {
    let started = 0
    const device = new DeviceDecisions({ modelDir: () => dir, spawner: () => (started++, new FakeHelper(() => 'crash')) })
    const fetch = device.route(network)
    for (let i = 0; i < 3; i++) expect((await fetch('atelier-device://nano/v1/systemone', post(request))).status).toBe(503)
    expect(started).toBe(3)
    expect(device.available()).toBe(false)
    expect((await fetch('atelier-device://nano/v1/systemone', post(request))).status).toBe(503)
    expect(started).toBe(3)
  })

  it('stops waiting when the decision is cancelled, as a hosted model would', async () => {
    const device = new DeviceDecisions({ modelDir: () => dir, spawner: () => new FakeHelper(() => 'silent') })
    const controller = new AbortController()
    const pending = device.route(network)('atelier-device://nano/v1/systemone', post(request, controller.signal))
    controller.abort()
    await expect(pending).rejects.toThrow('stopped')
    device.dispose()
  })
})
