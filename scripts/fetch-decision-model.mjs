/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Puts the on-device decision model (docs/decisions.md › On this computer) in native/decisions/build, where
// development runs read it and electron-builder takes it from (to Resources/decision-model):
//
//   node scripts/fetch-decision-model.mjs                                  # the pinned version, from Hugging Face
//   ATELIER_DECISION_MODEL_SRC=<folder> node scripts/fetch-decision-model.mjs   # a local export instead
//
// The pinned version is atelier-nano v0.3 as saved in the atelier-decisions project's v0.6 (its MANIFEST.json):
// every file is checked against the size and SHA-256 below, so a build from source ships exactly what was measured.
// A local folder (student/export.py) is copied as it is. Exits non-zero when neither works, so `npm run package`
// ships without the model and says so.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://huggingface.co/3SENN/atelier-decisions/resolve/v0.6/releases/v0.6/model/'
const PINNED = {
  'model.emb4.int8.onnx': [54249484, 'a9ef98890592908760d14e27bf0d009eea5b700f811995347ca00ce3a382041a'],
  'tokenizer.json': [2235313, '5a976b6650b911c2f57da96c73c4c93bf388e7cb53eeff65005719e90717ae34'],
  'tokenizer_config.json': [46440, 'ea349495764b24570b4560fe2e4a557e5c0a47e6bce782c2409b1d6445cf8633'],
  'vocab.json': [294971, '9d836ff3d79188b12fdd8a9a2c3877ace79ed7bcc8ef0a7a0a153e6ca99533e7'],
  'calibration.json': [174, '3df20afc0d6fde58475eb329cc1c09a1a24b3d18ee66aaebc521fea6e214b03b'],
}
const FILES = ['model.emb4.int8.onnx', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json']
const OPTIONAL = ['calibration.json']
const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(repo, 'native', 'decisions', 'build')
const source = process.env.ATELIER_DECISION_MODEL_SRC

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const matches = (path, [bytes, hash]) => existsSync(path) && statSync(path).size === bytes && sha256(path) === hash

mkdirSync(out, { recursive: true })
let bytes = 0
if (source) {
  if (!existsSync(source)) {
    console.error(`ATELIER_DECISION_MODEL_SRC: ${source} doesn't exist`)
    process.exit(1)
  }
  const missing = FILES.filter((f) => !existsSync(join(source, f)))
  if (missing.length) {
    console.error(`${source} has no ${missing.join(', ')}`)
    process.exit(1)
  }
  for (const f of [...FILES, ...OPTIONAL.filter((f) => existsSync(join(source, f)))]) {
    copyFileSync(join(source, f), join(out, f))
    bytes += statSync(join(out, f)).size
  }
} else {
  for (const [f, pin] of Object.entries(PINNED)) {
    const path = join(out, f)
    if (!matches(path, pin)) {
      const res = await fetch(BASE + f).catch((err) => ({ ok: false, status: err.message }))
      if (!res.ok) {
        console.error(`Couldn't download ${f} (${res.status}).`)
        process.exit(1)
      }
      writeFileSync(`${path}.part`, Buffer.from(await res.arrayBuffer()))
      if (!matches(`${path}.part`, pin)) {
        console.error(`${f} doesn't match its pinned size and SHA-256.`)
        process.exit(1)
      }
      renameSync(`${path}.part`, path)
    }
    bytes += pin[0]
  }
}
console.log(`On-device decision model: ${(bytes / 1e6).toFixed(1)} MB in ${out}`)
