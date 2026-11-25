/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-step on ONNX Runtime (CPU), in the decision helper (docs/decisions.md › Browser tasks). One pass per
// page of a browser task gives the operation (click, type, done, blocked), a score for every control, and for every
// field which of the task's named values goes in. It never writes text: what is typed is always one of the values
// the task was given. The model folder is an optional download (deviceStep.ts) from the atelier-decisions project.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import * as ort from 'onnxruntime-node'
import { CLICKABLE, EDITABLE, encodeStep, OPS, type StepInput, type StepOp, type StepTokenize } from './stepFormat'

/** The files a usable step model folder holds. */
export const STEP_FILES = ['model.emb4.int8.onnx', 'step.json', 'tokenizer.json', 'tokenizer_config.json'] as const

export interface StepAnswer {
  /** Probability of each operation. */
  op: Record<StepOp, number>
  /** Per element of the input: its probability as the click target (among clickable ones) or as the field to type
   *  into (among editable ones); null for text lines and for elements cut off the end of a long page. */
  click: Array<number | null>
  type: Array<number | null>
  /** Per editable element: probabilities over [none of these, value 1, value 2, …]; null otherwise. */
  values: Array<number[] | null>
  tokens: number
  ms: number
}

const softmax = (xs: number[]): number[] => {
  const m = Math.max(...xs)
  const e = xs.map((x) => Math.exp(x - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((x) => x / s)
}

interface Temperatures {
  op: number
  el: number
  val: number
}

export class StepDecider {
  private readonly session: ort.InferenceSession
  readonly tok: StepTokenize
  /** The version's calibration (step.json): a probability of 0.9 is right about 9 times in 10 on held-out steps. */
  private readonly temps: Temperatures

  private constructor(session: ort.InferenceSession, tok: StepTokenize, temps: Temperatures) {
    this.session = session
    this.tok = tok
    this.temps = temps
  }

  /** `file` picks another exported file (parity checks use model.int8.onnx, whose logits the fixtures hold); `raw` skips the temperatures. */
  static async load(dir: string, options: { threads?: number; raw?: boolean; file?: string } = {}): Promise<StepDecider> {
    const json = (name: string): object => JSON.parse(readFileSync(join(dir, name), 'utf8')) as object
    const info = json('step.json') as { format?: number; temperatures?: Temperatures }
    if (info.format !== 1) throw new Error(`step model format ${String(info.format)} is not one this version of Atelier reads`)
    const tokenizer = new Tokenizer(json('tokenizer.json'), json('tokenizer_config.json'))
    const one = (token: string): number => {
      const ids = tokenizer.encode(token, { add_special_tokens: false }).ids
      const id = ids[0]
      if (ids.length !== 1 || id === undefined) throw new Error(`${token} is not one token`)
      return id
    }
    const tok: StepTokenize = { encode: (text) => tokenizer.encode(text, { add_special_tokens: false }).ids, id: one, bos: one('<bos>'), eos: one('<eos>') }
    const file = options.file ?? (existsSync(join(dir, 'model.emb4.int8.onnx')) ? 'model.emb4.int8.onnx' : 'model.int8.onnx')
    const session = await ort.InferenceSession.create(join(dir, file), { executionProviders: ['cpu'], intraOpNumThreads: options.threads ?? 2, graphOptimizationLevel: 'all' })
    return new StepDecider(session, tok, options.raw ? { op: 1, el: 1, val: 1 } : (info.temperatures ?? { op: 1, el: 1, val: 1 }))
  }

  async release(): Promise<void> {
    await this.session.release()
  }

  /** The raw logits for already-encoded input (parity checks use this). */
  async logits(ids: number[], els: number[], vals: number[]): Promise<{ op: number[]; el: number[]; val: number[][] }> {
    const t = (xs: number[], dims: number[]): ort.Tensor => new ort.Tensor('int64', BigInt64Array.from(xs.map((x) => BigInt(x))), dims)
    const out = await this.session.run({ input_ids: t(ids, [1, ids.length]), attention_mask: t(ids.map(() => 1), [1, ids.length]), els: t(els, [els.length]), vals: t(vals, [vals.length]) })
    const flat = (name: string): number[] => {
      const tensor = out[name]
      if (!tensor) throw new Error(`the step model gave no ${name}`)
      return Array.from(tensor.data as Float32Array)
    }
    const val = flat('val')
    const m = vals.length
    return { op: flat('op'), el: flat('el'), val: els.map((_, i) => val.slice(i * m, (i + 1) * m)) }
  }

  async decide(input: StepInput): Promise<StepAnswer> {
    const t0 = performance.now()
    const enc = encodeStep(this.tok, input)
    const n = input.elements.length
    const empty = (): Array<null> => Array.from({ length: n }, () => null)
    if (enc.els.length === 0) {
      return { op: { click: 0, type: 0, done: 0.5, blocked: 0.5 }, click: empty(), type: empty(), values: empty(), tokens: enc.ids.length, ms: performance.now() - t0 }
    }
    const raw = await this.logits(enc.ids, enc.els, enc.vals)
    const t = this.temps
    const op = softmax(raw.op.map((x) => x / t.op))
    // The target is chosen among the controls of the operation's kind, as in training.
    const among = (kinds: Set<string>): Array<number | null> => {
      const idx = enc.elIndex.map((i, k) => (kinds.has(input.elements[i]?.role ?? '') ? k : -1)).filter((k) => k >= 0)
      const p = idx.length ? softmax(idx.map((k) => (raw.el[k] ?? 0) / t.el)) : []
      const out: Array<number | null> = empty()
      idx.forEach((k, j) => {
        const i = enc.elIndex[k]
        if (i !== undefined) out[i] = p[j] ?? null
      })
      return out
    }
    const values: Array<number[] | null> = empty()
    enc.elIndex.forEach((i, k) => {
      const row = raw.val[k]
      if (EDITABLE.has(input.elements[i]?.role ?? '') && row) values[i] = softmax(row.map((x) => x / t.val))
    })
    return {
      op: Object.fromEntries(OPS.map((o, i) => [o, op[i] ?? 0])) as Record<StepOp, number>,
      click: among(CLICKABLE),
      type: among(EDITABLE),
      values,
      tokens: enc.ids.length,
      ms: performance.now() - t0,
    }
  }
}
