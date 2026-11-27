/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The on-device decision model's utility process (out/main/decisionsDevice.js, started by device.ts with the
// model's folder as its argument, the mini's folder as the second, atelier-step's as the third and atelier-vision's as
// the fourth when those optional downloads are here; '' when one isn't). One message in per request
// ({ id, request, nanoOnly? }), browser step ({ id, step }), look at a picture ({ id, look }), vectors to search by
// ({ id, embed }) or cancel ({ cancel: id }), one reply out per id. It loads
// the small model on the first request and the mini on the first question the small one leaves open
// (device/cascade.ts); device.ts stops this process, and the mini's server with it, after a quiet spell.
import os from 'node:os'
import { cascade } from './device/cascade'
import { MiniDecider } from './device/mini'
import { NanoDecider } from './device/nano'
import { StepDecider } from './device/step'
import type { StepInput } from './device/stepFormat'
import { VisionDecider, type Picture, type VisionQuestion } from './device/vision'

const dir = process.argv[2] ?? ''
const miniDir = process.argv[3] || null
const stepDir = process.argv[4] || null
const visionDir = process.argv[5] || null
/** Two threads for the small model: answers in a few milliseconds, and leaves the rest of the CPU to the browser. */
const THREADS = 2
/** The mini needs more, still leaving half the cores to everything else. */
const MINI_THREADS = Math.max(2, Math.min(6, Math.floor(os.availableParallelism() / 2)))
let model: Promise<NanoDecider> | null = null
let mini: Promise<MiniDecider> | null = null
let stepModel: Promise<StepDecider> | null = null
let visionModel: Promise<VisionDecider> | null = null
const cancelled = new Set<number>()

/** A picture as it crosses to this process: decoded pixels, RGB or RGBA, row by row. */
interface PictureMessage {
  data: Uint8Array
  width: number
  height: number
  channels: number
}
/** What device.ts sends for a look ({ picture or vector, questions }) and for vectors ({ texts?, picture? }). */
interface LookMessage {
  picture?: PictureMessage
  vector?: number[] | Float32Array
  questions?: Record<string, VisionQuestion>
}
interface EmbedMessage {
  texts?: string[]
  picture?: PictureMessage
}

process.parentPort.on('message', (event) => {
  const data = (event.data ?? {}) as {
    id?: number
    cancel?: number
    nanoOnly?: boolean
    request?: { state?: unknown; questions?: unknown }
    step?: StepInput
    look?: LookMessage
    embed?: EmbedMessage
  }
  if (typeof data.cancel === 'number') {
    // A cancel that crossed its answer stays behind; an upper bound keeps those few from adding up.
    if (cancelled.size > 1000) cancelled.clear()
    cancelled.add(data.cancel)
    return
  }
  if (typeof data.id !== 'number') return
  if (data.step) void answerStep(data.id, data.step)
  else if (data.look) void answerLook(data.id, data.look)
  else if (data.embed) void answerEmbed(data.id, data.embed)
  else void answer(data.id, data.request, data.nanoOnly === true)
})

function loadVision(): Promise<VisionDecider> {
  if (!visionDir) return Promise.reject(new Error('atelier-vision is not installed'))
  // Two threads, like the other small models: a picture takes a fraction of a second, and the browser keeps the rest.
  visionModel ??= VisionDecider.load(visionDir, { threads: THREADS }).catch((err: unknown) => {
    visionModel = null
    throw err
  })
  return visionModel
}

function pictureOf(p: PictureMessage | undefined): Picture | undefined {
  if (!p) return undefined
  const { data, width, height, channels } = p
  if (!(data instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || (channels !== 3 && channels !== 4) || data.length !== width * height * channels) {
    throw new Error('bad request: a picture is its pixels (RGB or RGBA, 8 bits each) with its width and height')
  }
  return { data, width, height, channels }
}

/** System One questions about one picture (device/vision.ts); the picture's vector comes back to ask again or search by. */
async function answerLook(id: number, look: LookMessage): Promise<void> {
  try {
    const picture = pictureOf(look.picture)
    const vector = look.vector ? Float32Array.from(look.vector) : undefined
    if (!picture && !vector) throw new Error('bad request: a look needs a picture or a vector')
    const questions = look.questions ?? {}
    if (typeof questions !== 'object') throw new Error('bad request: the questions are an object')
    const model = await loadVision()
    if (cancelled.has(id)) return
    const out = await model.look({ picture, vector }, questions)
    process.parentPort.postMessage({ id, type: 'result', reply: { model: 'atelier-vision', answers: out.answers, vector: out.vector, ms: out.ms } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.parentPort.postMessage({ id, type: 'error', message: message.slice(0, 500) })
  } finally {
    cancelled.delete(id)
  }
}

/** Vectors to search pictures by: a text's nearest pictures are the ones it describes. A text it can't read gives null. */
async function answerEmbed(id: number, embed: EmbedMessage): Promise<void> {
  try {
    const picture = pictureOf(embed.picture)
    const texts = Array.isArray(embed.texts) ? embed.texts.filter((t): t is string => typeof t === 'string').slice(0, 200) : []
    if (!picture && texts.length === 0) throw new Error('bad request: vectors are made of texts or a picture')
    const model = await loadVision()
    const vectors: Array<Float32Array | null> = []
    for (const text of texts) {
      if (cancelled.has(id)) return
      vectors.push(model.unreadable(text) ? null : await model.text(text))
    }
    process.parentPort.postMessage({ id, type: 'result', reply: { model: 'atelier-vision', texts: vectors, picture: picture ? await model.image(picture) : undefined } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.parentPort.postMessage({ id, type: 'error', message: message.slice(0, 500) })
  } finally {
    cancelled.delete(id)
  }
}

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
