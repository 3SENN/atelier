/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The on-device decision model's utility process (out/main/decisionsDevice.js, started by device.ts with the
// model's folder as its argument, the mini's folder as the second and atelier-step's as the third when those optional
// downloads are here; '' when one isn't). One message in per request ({ id, request, nanoOnly? }), browser step
// ({ id, step }) or cancel ({ cancel: id }), one reply out per id. It loads
// the small model on the first request and the mini on the first question the small one leaves open
// (device/cascade.ts); device.ts stops this process, and the mini's server with it, after a quiet spell.
import os from 'node:os'
import { cascade } from './device/cascade'
import { MiniDecider } from './device/mini'
import { NanoDecider } from './device/nano'
import { StepDecider } from './device/step'
import type { StepInput } from './device/stepFormat'

const dir = process.argv[2] ?? ''
const miniDir = process.argv[3] || null
const stepDir = process.argv[4] || null
/** Two threads for the small model: answers in a few milliseconds, and leaves the rest of the CPU to the browser. */
const THREADS = 2
/** The mini needs more, still leaving half the cores to everything else. */
const MINI_THREADS = Math.max(2, Math.min(6, Math.floor(os.availableParallelism() / 2)))
let model: Promise<NanoDecider> | null = null
let mini: Promise<MiniDecider> | null = null
let stepModel: Promise<StepDecider> | null = null
const cancelled = new Set<number>()

process.parentPort.on('message', (event) => {
  const data = (event.data ?? {}) as { id?: number; cancel?: number; nanoOnly?: boolean; request?: { state?: unknown; questions?: unknown }; step?: StepInput }
  if (typeof data.cancel === 'number') {
    // A cancel that crossed its answer stays behind; an upper bound keeps those few from adding up.
    if (cancelled.size > 1000) cancelled.clear()
    cancelled.add(data.cancel)
    return
  }
  if (typeof data.id !== 'number') return
  if (data.step) void answerStep(data.id, data.step)
  else void answer(data.id, data.request, data.nanoOnly === true)
})

async function answerStep(id: number, input: StepInput): Promise<void> {
  try {
    if (!stepDir) throw new Error('atelier-step is not installed')
    if (!input || typeof input.goal !== 'string' || !Array.isArray(input.elements) || !Array.isArray(input.values) || !Array.isArray(input.before)) {
      throw new Error('bad request: a browser step needs a goal, values, what was done and the page')
    }
    // Two threads, like the small model: a page takes about a tenth of a second, and the browser keeps the rest.
    stepModel ??= StepDecider.load(stepDir, { threads: THREADS }).catch((err: unknown) => {
      stepModel = null
      throw err
    })
    const model = await stepModel
    if (cancelled.has(id)) return
    process.parentPort.postMessage({ id, type: 'result', reply: await model.decide(input) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.parentPort.postMessage({ id, type: 'error', message: message.slice(0, 500) })
  } finally {
    cancelled.delete(id)
  }
}

function loadMini(): Promise<MiniDecider> {
  // A load that failed is tried again on the next open question, not kept.
  mini ??= MiniDecider.load(miniDir ?? '', {
    threads: MINI_THREADS,
    // device.ts stops the server with this process (a killed utility process would leave it running on Windows).
    onServer: (pid) => process.parentPort.postMessage({ type: 'server', pid }),
  }).catch((err: unknown) => {
    mini = null
    throw err
  })
  return mini
}

async function answer(id: number, request: { state?: unknown; questions?: unknown } | undefined, nanoOnly: boolean): Promise<void> {
  try {
    const questions = request?.questions
    if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) throw new Error('bad request: a request needs at least one question')
    // A load that failed (a file missing or damaged) is tried again on the next question, not kept.
    model ??= NanoDecider.load(dir, { threads: THREADS, file: 'model.emb4.int8.onnx' }).catch((err: unknown) => {
      model = null
      throw err
    })
    const nano = await model
    const out = await cascade(
      { nano, mini: miniDir && !nanoOnly ? loadMini : null },
      { state: (request?.state ?? '') as never, questions: questions as never },
      () => cancelled.has(id),
    )
    const usedMini = Object.values(out.routes).includes('mini')
    process.parentPort.postMessage({ id, type: 'result', reply: { model: usedMini ? 'atelier-nano+mini' : 'atelier-nano', answers: out.answers, usage: out.usage, routes: out.routes } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.parentPort.postMessage({ id, type: 'error', message: message.slice(0, 500) })
  } finally {
    cancelled.delete(id)
  }
}
