/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/log', () => ({ log: { warn: () => undefined, debug: () => undefined, info: () => undefined } }))

import type { StepPageItem } from '../src/shared/browserSteps'
import { CONTROL_JOBS, CONTROL_LANGS } from '../src/shared/visionControls'
import { controlCheck, controlLang, controlQuestion, nameUnnamed, PICTURE_SURE, PICTURE_YES, type PictureModel } from '../src/main/agent/tools/browserSteps'
import { DeviceDecisions, deviceVisionDir, type DeviceProcess, type LookAnswer } from '../src/main/decisions/device'
import { answer, probabilities, RAW } from '../src/main/decisions/device/visionDecide'
import { clean, encodeText, labels, MAX_TOKENS, texts, unanswerable, type Question } from '../src/main/decisions/device/visionFormat'
import { VISION_FILES } from '../src/main/decisions/device/visionFiles'
import { VISION_MANIFEST } from '../src/main/decisions/device/visionManifest'
import { checksum, preprocess, SIZE, type Picture } from '../src/main/decisions/device/visionPreprocess'
import { MiniInstaller, type Download, type MiniManifest } from '../src/main/decisions/deviceMini'
import { pictureKey, pictureOf, type CapturedImage } from '../src/main/decisions/pictures'

// atelier-vision on this computer (docs/decisions.md › Pictures): its folder, its requests through the decision helper,
// its download, the pictures Atelier hands it, the buttons it names for browser tasks, and (with
// ATELIER_VISION_PARITY=<model folder>) the same numbers as the project that trained it.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-vision-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const red: Picture = { data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]), width: 2, height: 2, channels: 3 }
const question: Record<string, Question> = { kind: { type: 'choice', criteria: { receipt: 'A till receipt', photo: 'An ordinary photo' } } }

class FakeHelper extends EventEmitter implements DeviceProcess {
  sent: unknown[] = []
  postMessage(message: unknown): void {
    this.sent.push(message)
    const m = message as { id: number; look?: unknown; embed?: { texts?: string[] } }
    const reply = m.look
      ? { model: 'atelier-vision', answers: { kind: { type: 'choice', choice: 'receipt', probabilities: { receipt: 0.9, photo: 0.1 }, confidence: 0.8 } }, vector: [0.6, 0.8], ms: 4 }
      : { model: 'atelier-vision', texts: (m.embed?.texts ?? []).map((t) => (t === 'собака' ? null : [1, 0])), picture: [0, 1] }
    queueMicrotask(() => this.emit('message', { id: m.id, type: 'result', reply }))
  }
  kill(): boolean {
    return true
  }
}

describe('atelier-vision on this computer', () => {
  it('is installed only when every file is in its folder', () => {
    expect(deviceVisionDir(dir)).toBeNull()
    for (const f of VISION_FILES.slice(0, -1)) writeFileSync(join(dir, f), 'x')
    expect(deviceVisionDir(dir)).toBeNull()
    writeFileSync(join(dir, VISION_FILES.at(-1)!), 'x')
    expect(deviceVisionDir(dir)).toBe(dir)
  })

  it('looks at pictures in the decision helper, with or without the small decision model', async () => {
    const spawned: Array<[string, string | null, string | null, string | null]> = []
    let visionDir: string | null = null
    const helper = new FakeHelper()
    const device = new DeviceDecisions({ modelDir: () => null, visionDir: () => visionDir, spawner: (d, m, s, v) => (spawned.push([d, m, s, v]), helper) })
    expect(device.visionAvailable()).toBe(false)
    await expect(device.look({ picture: red }, question, new AbortController().signal)).rejects.toThrow(/not installed/)
    visionDir = dir
    expect(device.visionAvailable()).toBe(true)
    // Decisions still read the small model as missing: only pictures are looked at.
    expect(device.available()).toBe(false)
    const out: LookAnswer = await device.look({ picture: red }, question, new AbortController().signal)
    expect(out.answers.kind).toMatchObject({ type: 'choice', choice: 'receipt' })
    // The picture's vector comes back, to ask again without a second pass through the image tower.
    expect(out.vector).toBeInstanceOf(Float32Array)
    expect(Array.from(out.vector)).toEqual([Math.fround(0.6), Math.fround(0.8)])
    expect(spawned).toEqual([['', null, null, dir]])
    expect(helper.sent).toEqual([{ id: 1, look: { picture: red, vector: undefined, questions: question } }])
    await device.look({ vector: out.vector }, question, new AbortController().signal)
    expect(helper.sent[1]).toEqual({ id: 2, look: { picture: undefined, vector: out.vector, questions: question } })
    device.dispose()
  })

  it('gives vectors to search by, and none for a text it can’t read', async () => {
    const device = new DeviceDecisions({ modelDir: () => null, visionDir: () => dir, spawner: () => new FakeHelper() })
    const out = await device.embed({ texts: ['a dog on a beach', 'собака'], picture: red }, new AbortController().signal)
    expect(out.texts[0]).toBeInstanceOf(Float32Array)
    expect(out.texts[1]).toBeNull()
    expect(Array.from(out.picture ?? [])).toEqual([0, 1])
    device.dispose()
  })

  it('starts a new helper when atelier-vision is installed or removed', async () => {
    const spawned: Array<string | null> = []
    let visionDir: string | null = null
    const device = new DeviceDecisions({ modelDir: () => dir, visionDir: () => visionDir, spawner: (_d, _m, _s, v) => (spawned.push(v), new FakeHelper()) })
    device.warm()
    await new Promise((r) => setTimeout(r, 0))
    visionDir = join(dir, 'vision')
    await device.look({ picture: red }, question, new AbortController().signal)
    expect(spawned).toEqual([null, join(dir, 'vision')])
    device.dispose()
  })
})

// ── The download: model files only, checked against the manifest compiled into Atelier ──

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('atelier-vision’s download', () => {
  it('lists every file the runtime needs, pinned to the version’s tag', () => {
    expect(VISION_MANIFEST.model.map((f) => f.path).sort()).toEqual([...VISION_FILES].sort())
    expect(VISION_MANIFEST.base).toMatch(/\/resolve\/vision-v0\.1\/releases\/vision-v0\.1\/model\/$/)
    expect(VISION_MANIFEST.model.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0)).toBe(true)
  })

  it('downloads the model files with no server, checks them and swaps the folder in', async () => {
    const bodies = new Map<string, Buffer>(VISION_FILES.map((f, i) => [f, Buffer.alloc(400 + i * 97, i + 1)]))
    const manifest: MiniManifest = { version: 'vision-test', base: 'https://models.example/vision/', model: VISION_FILES.map((f) => ({ path: f, url: f, size: bodies.get(f)!.length, sha256: sha(bodies.get(f)!) })), servers: {} }
    const download: Download = async (url) => {
      const body = bodies.get(url.replace('https://models.example/vision/', ''))
      return body ? { status: 200, body: (async function* () { yield body })() } : { status: 404, body: null }
    }
    let released = 0
    const target = join(dir, 'decision-model-vision')
    const installer = new MiniInstaller({ dir: target, manifest, download, release: () => released++, needsServer: false, installed: deviceVisionDir, platform: 'plan9-x64' })
    expect(installer.status().state).toBe('absent')
    await installer.install()
    expect(installer.status()).toEqual({ state: 'ready', external: false })
    expect(deviceVisionDir(target)).toBe(target)
    expect(readFileSync(join(target, 'vision.json'))).toEqual(bodies.get('vision.json'))
    expect(released).toBe(1)
    installer.remove()
    expect(existsSync(target)).toBe(false)
  })
})

// ── What the helper is handed ──

function captured(width: number, height: number, scale: number, pixel: [number, number, number, number]): CapturedImage & { resized: Array<{ width: number; height: number }> } {
  const resized: Array<{ width: number; height: number }> = []
  const bitmap = (w: number, h: number): Buffer => Buffer.from(Array.from({ length: w * h }, () => pixel).flat())
  return {
    resized,
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap(width * scale, height * scale),
    resize: (o) => (resized.push({ width: o.width, height: o.height }), { ...captured(o.width, o.height, 1, pixel), resized }),
  }
}

describe('a picture for atelier-vision', () => {
  it('is the capture’s own pixels as RGB, at the scale the display drew them', () => {
    // Electron's bitmap is BGRA; a capture on a 2x display has four times the pixels its size says.
    const picture = pictureOf(captured(3, 2, 2, [10, 20, 30, 255]))
    expect(picture).toMatchObject({ width: 6, height: 4, channels: 3 })
    expect(Array.from(picture!.data.slice(0, 6))).toEqual([30, 20, 10, 30, 20, 10])
    expect(picture!.data.length).toBe(6 * 4 * 3)
  })

  it('is made smaller before it crosses to the helper when it is larger than the model can use', () => {
    const image = captured(2400, 1200, 1, [0, 0, 0, 255])
    const picture = pictureOf(image)
    expect(image.resized).toEqual([{ width: 768, height: 384 }])
    expect(picture).toMatchObject({ width: 768, height: 384 })
  })

  it('is nothing when there is nothing to see', () => {
    expect(pictureOf({ ...captured(4, 4, 1, [0, 0, 0, 0]), isEmpty: () => true })).toBeNull()
  })

  it('has a fingerprint of its pixels and size', () => {
    const other: Picture = { ...red, data: Uint8Array.from(red.data).fill(9) }
    expect(pictureKey(red)).toBe(pictureKey({ ...red, data: Uint8Array.from(red.data) }))
    expect(pictureKey(red)).not.toBe(pictureKey(other))
    expect(pictureKey(red)).not.toBe(pictureKey({ ...red, width: 4, height: 1 }))
  })

  it('becomes the square the image tower reads: transparent parts over white, values in -1..1, channels first', () => {
    const x = preprocess(red)
    expect(x.length).toBe(3 * SIZE * SIZE)
    expect(x[0]).toBeCloseTo(1, 5)
    expect(x[SIZE * SIZE]).toBeCloseTo(-1, 5)
    const clear: Picture = { data: new Uint8Array([0, 0, 0, 0]), width: 1, height: 1, channels: 4 }
    expect(Array.from(preprocess(clear).slice(0, 2))).toEqual([1, 1])
    expect(Number.isFinite(checksum(x))).toBe(true)
    expect(() => preprocess({ ...red, width: 3 })).toThrow(/values/)
  })
})

describe('a question about a picture', () => {
  const tok = { encode: (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0)) }

  it('gives one text per answer: an option’s description or its name, a level, what a yes looks like', () => {
    const choice: Question = { type: 'choice', criteria: { beach: 'A day at the beach', food: null } }
    expect(labels(choice)).toEqual(['beach', 'food'])
    expect(texts(choice)).toEqual(['A day at the beach', 'food'])
    expect(texts({ type: 'score', criteria: ['Sharp', 'Blurred'] })).toEqual(['Sharp', 'Blurred'])
    expect(texts({ type: 'noul', instructions: 'Is this a receipt?' })).toEqual([null, 'Is this a receipt?'])
    expect(texts({ type: 'noul', instructions: 'Is this a receipt?', criteria: { true: 'A till receipt.', false: 'Anything else.' } })).toEqual(['Anything else.', 'A till receipt.'])
  })

  it('says why a question can’t be asked of a picture', () => {
    expect(unanswerable({ type: 'choice', criteria: { only: 'one' } })).toMatch(/two or more options/)
    expect(unanswerable({ type: 'score', criteria: ['one'] })).toMatch(/two or more levels/)
    expect(unanswerable({ type: 'noul' })).toMatch(/what a yes looks like/)
    expect(unanswerable({ type: 'noul', instructions: 'Is this a receipt?' })).toBeNull()
    expect(unanswerable({ type: 'other' } as unknown as Question)).toMatch(/unknown question type/)
  })

  it('reads a text lowercased, on one line, in 64 tokens that end the same way', () => {
    expect(clean('  A  Till\n Receipt  ')).toBe('a till receipt')
    const short = encodeText(tok, 'Dog')
    expect(short.ids.length).toBe(MAX_TOKENS)
    expect(short.ids.slice(0, 5)).toEqual([100, 111, 103, 1, 0])
    expect(short.cut).toBe(false)
    const long = encodeText(tok, 'x'.repeat(200))
    expect(long.cut).toBe(true)
    expect(long.ids[MAX_TOKENS - 1]).toBe(1)
  })

  it('turns matches into System One answers', () => {
    // A choice is a softmax over the matches; the bias cancels.
    const p = probabilities('choice', [0.1, 0.05], 100, -17, RAW)
    expect(p[0]! + p[1]!).toBeCloseTo(1, 9)
    expect(p[0]).toBeGreaterThan(0.99)
    expect(answer({ type: 'choice', criteria: { a: 'x', b: 'y' } }, ['a', 'b'], p)).toMatchObject({ type: 'choice', choice: 'a' })
    // A yes/no question without a "false" text reads the "true" text's match alone; with one, both.
    const cal = { ...RAW, noul: { pair: { a: 0.5, b: 0.25, c: 2 }, single: { a: 0.5, c: 2 } } }
    expect(probabilities('noul', [null, 0.17], 100, -17, cal)[1]).toBeCloseTo(1 / (1 + Math.exp(-2)), 6)
    expect(probabilities('noul', [0.17, 0.17], 100, -17, cal)[1]).toBeCloseTo(1 / (1 + Math.exp(-2)), 6)
    expect(probabilities('noul', [0.21, 0.17], 100, -17, cal)[1]).toBeLessThan(probabilities('noul', [0.17, 0.17], 100, -17, cal)[1]!)
    expect(answer({ type: 'noul' }, ['false', 'true'], [0.2, 0.8])).toEqual({ type: 'noul', noul: 0.8 })
  })
})

// ── Browser tasks: a button with only an icon gets its name from its picture ──

describe('controls the page gave no name', () => {
  const items: StepPageItem[] = [
    { ref: 'ref_1', role: 'link', label: 'Home', group: 'header-1' },
    { ref: 'ref_2', role: 'button', label: '', group: 'header-1', box: { x: 900, y: 10, width: 40, height: 40 } },
    { ref: 'ref_3', role: 'button', label: '', group: 'header-1', box: { x: 950, y: 10, width: 40, height: 40 } },
    { ref: '', role: 'text', label: 'Trailrunner 2', group: '' },
    { ref: 'ref_4', role: 'field', label: '', value: '', group: 'form-2' },
  ]
  const cart: Picture = { ...red }
  const blur: Picture = { ...red, data: Uint8Array.from(red.data).fill(127) }
  /** A model that gives the cart picture `sure` of its weight for "cart", and says `yes` to "is it a button for that?". */
  const model = (sure: number, yes = 0.95): PictureModel & { asked: number; checks: Array<Record<string, Question>> } => {
    const m = {
      asked: 0,
      checks: [] as Array<Record<string, Question>>,
      visionAvailable: () => true,
      look: async (input: { picture?: Picture; vector?: Float32Array }, questions: Record<string, Question>): Promise<LookAnswer> => {
        if (questions.is) {
          // The second question comes with the vector the first one gave back, not with the picture again.
          expect(input.picture).toBeUndefined()
          expect(Array.from(input.vector ?? [])).toEqual([1, 0])
          m.checks.push(questions)
          return { model: 'atelier-vision', answers: { is: { type: 'noul', noul: yes } }, vector: new Float32Array([1, 0]), ms: 1 }
        }
        m.asked++
        const p = input.picture === cart ? sure : 0.2
        return { model: 'atelier-vision', answers: { does: { type: 'choice', choice: 'cart', probabilities: { cart: p, search: 1 - p }, confidence: p } }, vector: new Float32Array([1, 0]), ms: 1 }
      },
    }
    return m
  }

  it('asks which of all its jobs a button has, named in the page’s language when it knows it', () => {
    expect(controlLang('nl-NL')).toBe('nl')
    expect(controlLang('pt-BR')).toBe('en')
    expect(controlLang(undefined)).toBe('en')
    const q = controlQuestion('nl')
    expect(q.type).toBe('choice')
    expect(Object.keys(q.criteria as object)).toEqual(CONTROL_JOBS.map((j) => j.key))
    expect((q.criteria as Record<string, string>).cart).toBe('winkelwagen')
    // Every job has a name in every language, and no two jobs share one within a language.
    for (const lang of CONTROL_LANGS) expect(new Set(CONTROL_JOBS.map((j) => j.names[lang])).size).toBe(CONTROL_JOBS.length)
  })

  it('names a control when the model is sure of its picture, and leaves it out when it isn’t', async () => {
    const m = model(0.93)
    const seen = new Map<string, string | null>()
    const out = await nameUnnamed(items, { ref_2: cart, ref_3: blur }, 'nl', m, seen, new AbortController().signal)
    expect(out.map((i) => [i.ref, i.label, i.seen ?? false])).toEqual([['ref_1', 'Home', false], ['ref_2', 'winkelwagen', true], ['', 'Trailrunner 2', false], ['ref_4', '', false]])
    expect(m.asked).toBe(2)
    // The same pixels on the next page are not looked at again, whichever way the answer went.
    await nameUnnamed(items, { ref_2: cart, ref_3: blur }, 'nl', m, seen, new AbortController().signal)
    expect(m.asked).toBe(2)
    expect(PICTURE_SURE).toBeGreaterThanOrEqual(0.75)
    expect((await nameUnnamed(items, { ref_2: cart }, 'nl', model(PICTURE_SURE - 0.01), new Map(), new AbortController().signal)).some((i) => i.ref === 'ref_2')).toBe(false)
  })

  it('asks a second time whether it really is a button for that job, and leaves it out on anything but a sure yes', async () => {
    // Among 63 jobs something always looks likeliest: a logo or an anchor is none of them.
    const sure = model(0.99, PICTURE_YES)
    expect((await nameUnnamed(items, { ref_2: cart }, 'nl', sure, new Map(), new AbortController().signal)).find((i) => i.ref === 'ref_2')?.label).toBe('winkelwagen')
    expect(sure.checks).toEqual([{ is: controlCheck('nl', 'winkelwagen') }])
    expect(controlCheck('nl', 'winkelwagen')).toEqual({ type: 'noul', instructions: 'Is dit een knop voor winkelwagen?', criteria: { true: 'Een knop voor: winkelwagen.' } })
    const logo = model(0.99, PICTURE_YES - 0.01)
    expect((await nameUnnamed(items, { ref_2: cart }, 'nl', logo, new Map(), new AbortController().signal)).some((i) => i.ref === 'ref_2')).toBe(false)
    // A picture it wasn't sure of in the first place is not asked about again.
    const unsure = model(0.4)
    await nameUnnamed(items, { ref_2: cart }, 'en', unsure, new Map(), new AbortController().signal)
    expect(unsure.checks).toEqual([])
  })

  it('leaves unnamed controls out without the model, without a picture, or when the model fails', async () => {
    const named = (list: StepPageItem[]): string[] => list.map((i) => i.ref)
    const signal = new AbortController().signal
    expect(named(await nameUnnamed(items, { ref_2: cart }, 'en', null, new Map(), signal))).toEqual(['ref_1', '', 'ref_4'])
    expect(named(await nameUnnamed(items, undefined, 'en', model(0.99), new Map(), signal))).toEqual(['ref_1', '', 'ref_4'])
    const failing: PictureModel = { visionAvailable: () => true, look: async () => Promise.reject(new Error('the helper stopped')) }
    expect(named(await nameUnnamed(items, { ref_2: cart }, 'en', failing, new Map(), signal))).toEqual(['ref_1', '', 'ref_4'])
    const off: PictureModel = { visionAvailable: () => false, look: async () => Promise.reject(new Error('never asked')) }
    expect(named(await nameUnnamed(items, { ref_2: cart }, 'en', off, new Map(), signal))).toEqual(['ref_1', '', 'ref_4'])
  })
})

// The atelier-decisions project's parity fixtures (releases/vision-v0.1/model/parity.jsonl): the same tower input from
// the same pixels, the same token ids from the same text, the same vectors from the same files, and the same answers
// and refusals. Needs the model, so it runs when ATELIER_VISION_PARITY names its folder.
describe.skipIf(!process.env.ATELIER_VISION_PARITY)('atelier-vision’s parity with its training code', () => {
  it('reads every picture and text, and answers every question, as the export did', async () => {
    const { VisionDecider, dot } = await import('../src/main/decisions/device/vision')
    const folder = process.env.ATELIER_VISION_PARITY ?? ''
    const model = await VisionDecider.load(folder)
    type Row = {
      picture?: { w: number; h: number; channels: 3 | 4; pixels: string }
      checksum?: number
      embedding?: number[]
      text?: string
      ids?: number[]
      cut?: boolean
      unreadable?: string | null
      look?: { picture: number; questions: Record<string, Question> }
      answers?: Record<string, { type: string; reason?: string; choice?: string; noul?: number; probabilities?: Record<string, number> }>
    }
    const rows = readFileSync(join(folder, 'parity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row)
    const vectors: Float32Array[] = []
    let lowest = 1
    let worstInput = 0
    let worstP = 0
    let counted = { pictures: 0, texts: 0, answers: 0 }
    for (const r of rows) {
      if (r.picture) {
        const picture: Picture = { data: new Uint8Array(Buffer.from(r.picture.pixels, 'base64')), width: r.picture.w, height: r.picture.h, channels: r.picture.channels }
        worstInput = Math.max(worstInput, Math.abs(checksum(preprocess(picture, model.size)) - (r.checksum ?? 0)) / Math.max(1, Math.abs(r.checksum ?? 0)))
        const v = await model.image(picture)
        vectors.push(v)
        lowest = Math.min(lowest, dot(v, Float32Array.from(r.embedding ?? [])))
        counted.pictures++
      } else if (typeof r.text === 'string') {
        expect(model.ids(r.text)).toEqual({ ids: r.ids, cut: r.cut })
        expect(model.unreadable(r.text)).toBe(r.unreadable)
        lowest = Math.min(lowest, dot(await model.text(r.text), Float32Array.from(r.embedding ?? [])))
        counted.texts++
      } else if (r.look) {
        const out = await model.look({ vector: vectors[r.look.picture] }, r.look.questions)
        for (const [key, want] of Object.entries(r.answers ?? {})) {
          const got = out.answers[key] as typeof want | undefined
          expect(got?.type).toBe(want.type)
          if (want.type === 'refusal') expect(got?.reason).toBe(want.reason)
          if (want.type === 'choice') expect(got?.choice).toBe(want.choice)
          const p = (a: typeof want | undefined): number[] => (a?.type === 'noul' ? [a.noul ?? 0] : Object.values(a?.probabilities ?? {}))
          worstP = Math.max(worstP, ...p(want).map((x, i) => Math.abs(x - (p(got)[i] ?? 9))), 0)
          counted.answers++
        }
      }
    }
    await model.release()
    expect(counted.pictures).toBeGreaterThan(8)
    expect(counted.texts).toBeGreaterThan(30)
    expect(counted.answers).toBeGreaterThan(8)
    expect(worstInput).toBeLessThan(1e-5)
    expect(lowest).toBeGreaterThan(0.9999)
    expect(worstP).toBeLessThan(1e-3)
  }, 180_000)
})
