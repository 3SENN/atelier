/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import type { ClientToolContext, ToolSetup } from '../src/main/agent/tools/registry'
import type { PictureModel } from '../src/main/agent/tools/browserSteps'
import { createLabelPicturesTool, LABEL_PICTURES_MAX, LABEL_PICTURES_TOOL } from '../src/main/agent/tools/labelPictures'
import { clientToolLines } from '../src/main/agent/prompt'
import type { LookAnswer } from '../src/main/decisions/device'
import type { Answer } from '../src/main/decisions/device/visionDecide'
import type { Picture } from '../src/main/decisions/device/visionPreprocess'

// label_pictures (docs/decisions.md › Pictures): the companion's way to hand many small judgment calls about pictures
// on a page to atelier-vision, on this computer.

const SETUP: ToolSetup = { companionId: 'pip', browser: true, memory: true, routine: false, private: false, flags: {}, workspace: { folders: false, tables: false, apps: false, calendar: false, activity: false } }

function context(extra: Partial<ClientToolContext> = {}): ClientToolContext {
  return { chatId: 'c1', companionId: 'pip', isPrivate: false, isRoutine: false, signal: new AbortController().signal, emit: () => undefined, ask: () => Promise.reject(new Error('no')), ...extra }
}

const picture = (shade: number): Picture => ({ data: new Uint8Array(12).fill(shade), width: 2, height: 2, channels: 3 })

/** A page whose elements are pictures of one shade each, and a model that answers by the shade. */
function harness(answers: Record<number, Record<string, Answer>>, options: { available?: boolean; missing?: string[] } = {}) {
  const taken: Array<[string | null, string | null]> = []
  const looked: number[] = []
  const shades: Record<string, number> = { ref_1: 1, ref_2: 2, ref_3: 3 }
  const browser = {
    picture: async (tabId: string | null | undefined, ref: string | null) => {
      taken.push([tabId ?? null, ref])
      if (ref && options.missing?.includes(ref)) throw new Error(`${ref} is not visible on the page.`)
      return { tabId: 't7', picture: picture(ref ? (shades[ref] ?? 9) : 0), name: ref ?? 'the page' }
    },
  }
  const model: PictureModel = {
    visionAvailable: () => options.available ?? true,
    look: async (input): Promise<LookAnswer> => {
      const shade = input.picture?.data[0] ?? -1
      looked.push(shade)
      return { model: 'atelier-vision', answers: answers[shade] ?? {}, vector: new Float32Array(2), ms: 1 }
    },
  }
  return { tool: createLabelPicturesTool({ browser: () => browser, pictures: () => model }), taken, looked }
}

const album = { type: 'choice' as const, instructions: 'Which album fits this photo?', criteria: { beach: 'A day at the beach or by the sea', food: 'Food or a meal' } }
const receipt = { type: 'noul' as const, instructions: 'Is this a receipt?', criteria: { true: 'A receipt from a shop or a restaurant.' } }
const choice = (name: string, p: number): Answer => ({ type: 'choice', choice: name, probabilities: { [name]: p, other: 1 - p }, confidence: p })

describe('label_pictures', () => {
  it('answers each picture’s questions, and says “unsure” where the model isn’t sure', async () => {
    const { tool, taken, looked } = harness({
      1: { album: choice('beach', 0.92), receipt: { type: 'noul', noul: 0.04 } },
      2: { album: choice('food', 0.55), receipt: { type: 'noul', noul: 0.5 } },
      3: { album: choice('food', 0.9), receipt: { type: 'noul', noul: 0.97 } },
    })
    const args = tool.parse.parse({ pictures: [{ ref: 'ref_1' }, { id: 'lunch', ref: 'ref_2' }, { ref: 'ref_3' }], questions: { album, receipt } })
    const result = await tool.run(args, context())
    expect(result.isError).toBeUndefined()
    const out = JSON.parse(result.content) as { model: string; pictures: Array<{ id: string; answers: Record<string, { answer: string; p: number; leaning?: string }> }>; note: string }
    expect(out.model).toBe('atelier-vision')
    expect(out.pictures.map((p) => p.id)).toEqual(['ref_1', 'lunch', 'ref_3'])
    expect(out.pictures[0]!.answers).toEqual({ album: { answer: 'beach', p: 0.92 }, receipt: { answer: 'no', p: 0.04 } })
    // The same cutoffs as label_items: a choice at 0.75, yes at 0.7 and no at 0.3.
    expect(out.pictures[1]!.answers).toEqual({ album: { answer: 'unsure', p: 0.55, leaning: 'food' }, receipt: { answer: 'unsure', p: 0.5 } })
    expect(out.pictures[2]!.answers.receipt).toEqual({ answer: 'yes', p: 0.97 })
    expect(out.note).toMatch(/1 picture\(s\) have an “unsure” answer/)
    // One after another, in the tab the first picture was found in.
    expect(taken).toEqual([[null, 'ref_1'], ['t7', 'ref_2'], ['t7', 'ref_3']])
    expect(looked).toEqual([1, 2, 3])
  })

  it('looks at the page as it shows when a picture names no element', async () => {
    const { tool, taken } = harness({ 0: { receipt: { type: 'noul', noul: 0.9 } } })
    const result = await tool.run(tool.parse.parse({ pictures: [{}], questions: { receipt }, tab_id: 't3' }), context())
    expect(taken).toEqual([['t3', null]])
    expect(JSON.parse(result.content).pictures).toEqual([{ id: '1', answers: { receipt: { answer: 'yes', p: 0.9 } } }])
  })

  it('says why a question wasn’t answered, and goes on after a picture it couldn’t take', async () => {
    const { tool } = harness({ 1: { album: { type: 'refusal', reason: 'mostly not Latin script (0% Latin)' } }, 3: { album: choice('beach', 0.8) } }, { missing: ['ref_2'] })
    const result = await tool.run(tool.parse.parse({ pictures: [{ ref: 'ref_1' }, { ref: 'ref_2' }, { ref: 'ref_3' }], questions: { album } }), context())
    const out = JSON.parse(result.content) as { pictures: Array<{ id: string; answers?: unknown; error?: string }>; note: string }
    expect(out.pictures[0]).toEqual({ id: 'ref_1', answers: { album: { answer: 'unsure', p: 0, why: 'mostly not Latin script (0% Latin)' } } })
    expect(out.pictures[1]).toEqual({ id: 'ref_2', error: 'ref_2 is not visible on the page.' })
    expect(out.pictures[2]).toEqual({ id: 'ref_3', answers: { album: { answer: 'beach', p: 0.8 } } })
    expect(out.note).toMatch(/1 picture\(s\) were not looked at/)
  })

  it('hands everything back when no picture could be looked at, or the model isn’t here', async () => {
    const none = harness({}, { missing: ['ref_1'] })
    const failed = await none.tool.run(none.tool.parse.parse({ pictures: [{ ref: 'ref_1' }], questions: { album } }), context())
    expect(failed.isError).toBe(true)
    expect(failed.content).toMatch(/Look at them yourself/)
    const off = harness({}, { available: false })
    const result = await off.tool.run(off.tool.parse.parse({ pictures: [{ ref: 'ref_1' }], questions: { album } }), context())
    expect(result.content).toMatch(/atelier-vision is not installed/)
    expect(off.taken).toEqual([])
    const unloaded = createLabelPicturesTool({ browser: () => null, pictures: () => null })
    expect((await unloaded.run(unloaded.parse.parse({ pictures: [{}], questions: { album } }), context())).isError).toBe(true)
  })

  it('finds pictures by a description: how likely it fits each, and the pictures best first', async () => {
    const asked: Array<Record<string, unknown>> = []
    const shades: Record<string, number> = { ref_1: 0.12, ref_2: 0.91, ref_3: 0.47 }
    const model: PictureModel = {
      visionAvailable: () => true,
      look: async (input, questions): Promise<LookAnswer> => {
        asked.push(questions)
        const p = (input.picture?.data[0] ?? 0) / 100
        return { model: 'atelier-vision', answers: { '~find': { type: 'noul', noul: p } }, vector: new Float32Array(2), ms: 1 }
      },
    }
    const browser = { picture: async (_tab: string | null | undefined, ref: string | null) => ({ tabId: 't1', picture: picture(Math.round((shades[ref ?? ''] ?? 0) * 100)), name: ref ?? 'the page' }) }
    const tool = createLabelPicturesTool({ browser: () => browser, pictures: () => model })
    const result = await tool.run(tool.parse.parse({ pictures: [{ ref: 'ref_1' }, { ref: 'ref_2' }, { ref: 'ref_3' }], find: 'the red sofa' }), context())
    const out = JSON.parse(result.content) as { best_first: string[]; pictures: Array<{ id: string; match: number; answers: Record<string, unknown> }>; note: string }
    expect(out.best_first).toEqual(['ref_2', 'ref_3', 'ref_1'])
    expect(out.pictures.map((p) => p.match)).toEqual([0.12, 0.91, 0.47])
    // The description is asked as what a yes looks like, and is not one of the companion's own answers.
    expect(asked[0]).toEqual({ '~find': { type: 'noul', instructions: 'the red sofa', criteria: { true: 'the red sofa' } } })
    expect(out.pictures[0]!.answers).toEqual({})
    expect(out.note).toMatch(/best_first lists the pictures/)
    // A description the model can't read ranks nothing and says so.
    const foreign: PictureModel = { visionAvailable: () => true, look: async () => ({ model: 'atelier-vision', answers: { '~find': { type: 'refusal', reason: 'mostly not Latin script (0% Latin)' } }, vector: new Float32Array(2), ms: 1 }) }
    const other = createLabelPicturesTool({ browser: () => browser, pictures: () => foreign })
    const refused = JSON.parse((await other.run(other.parse.parse({ pictures: [{ ref: 'ref_1' }], find: 'красный диван' }), context())).content) as { best_first?: string[]; note: string }
    expect(refused.best_first).toBeUndefined()
    expect(refused.note).toMatch(/couldn’t be read \(mostly not Latin script/)
    // Questions or a description: one of them is needed.
    expect(tool.parse.safeParse({ pictures: [{ ref: 'ref_1' }] }).success).toBe(false)
    expect(tool.parse.safeParse({ pictures: [{ ref: 'ref_1' }], find: 'a' }).success).toBe(false)
  })

  it('stops when the chat is stopped', async () => {
    const stop = new AbortController()
    const { tool, looked } = harness({ 1: { album: choice('beach', 0.9) } })
    stop.abort()
    await expect(tool.run(tool.parse.parse({ pictures: [{ ref: 'ref_1' }], questions: { album } }), context({ signal: stop.signal }))).rejects.toThrow()
    expect(looked).toEqual([])
  })

  it('takes 1 to 40 pictures and 1 to 5 questions in the System One shape', () => {
    const { tool } = harness({})
    expect(tool.parse.safeParse({ pictures: [], questions: { album } }).success).toBe(false)
    expect(tool.parse.safeParse({ pictures: Array.from({ length: LABEL_PICTURES_MAX + 1 }, () => ({})), questions: { album } }).success).toBe(false)
    expect(tool.parse.safeParse({ pictures: [{}], questions: {} }).success).toBe(false)
    expect(tool.parse.safeParse({ pictures: [{}], questions: { album: { type: 'choice', instructions: 'Which?', criteria: { only: 'one' } } } }).success).toBe(false)
    expect(tool.parse.safeParse({ pictures: [{ ref: 'ref_1', url: 'https://example.test/a.jpg' }], questions: { album } }).success).toBe(false)
    expect(tool.parse.safeParse({ pictures: [{ ref: 'ref_1' }], questions: { album, receipt } }).success).toBe(true)
  })

  it('is offered while atelier-vision is here and the chat has the browser, private chats too, never in routines', () => {
    const on = harness({}).tool
    expect(on.name).toBe(LABEL_PICTURES_TOOL)
    expect(on.enabled(SETUP)).toBe(true)
    // It runs on this computer: nothing of a private chat leaves it.
    expect(on.enabled({ ...SETUP, private: true })).toBe(true)
    expect(on.enabled({ ...SETUP, browser: false })).toBe(false)
    expect(on.enabled({ ...SETUP, routine: true })).toBe(false)
    expect(harness({}, { available: false }).tool.enabled(SETUP)).toBe(false)
    expect(clientToolLines([LABEL_PICTURES_TOOL], () => 'chat')).toMatch(/- label_pictures answers the same .* look yourself at the ones it marks "unsure"/)
  })
})
