#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Writes src/renderer/public/licenses.json for Settings › About (ST-56): one
// entry per package Atelier ships ({name, version, license, text}), the native
// helpers' third-party packages included (NATIVE_PACKAGES), and the companion
// art, which Atelier ships under its own licence (ART-LICENSE.md). With a
// package-lock.json the shipped set is the lock's
// production tree, as installed on this machine; without one it walks
// `dependencies` from package.json. Either way it adds the packages the
// renderer bundles from devDependencies (React) and Electron itself (which
// carries Chromium). Offline: reads the lock and node_modules only.
//
//   node scripts/licenses.mjs [--out <file>]   write the list
//   node scripts/licenses.mjs --check          fail when the written list is
//     stale, malformed, or carries a licence Atelier can't ship (release.mjs)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Bundled into the renderer or the app, though listed as devDependencies. */
export const EXTRA_ROOTS = ['react', 'react-dom', 'electron', '@huggingface/tokenizers']

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`
const mit = (copyright, note = '') => `The MIT License (MIT)\n\n${copyright}\n\n${MIT_TERMS}${note ? `\n\n${note}` : ''}`
const DOTNET_COPYRIGHT = 'Copyright (c) .NET Foundation and Contributors\n\nAll rights reserved.'

/**
 * Third-party code the native helpers compile in (native/): not npm packages
 * of the app, so the lock doesn't list them. Kept here with their licence
 * text, so the list is the same on every machine; tests/release.test.ts checks
 * the versions against native/speech-win/AtelierSpeech.csproj and
 * native/haptics/package.json. The Swift helpers use Apple's frameworks only.
 */
export const NATIVE_PACKAGES = [
  // The trackpad haptics addon (macOS) compiles in node-addon-api's headers.
  { name: 'node-addon-api', version: '8.9.2', license: 'MIT', text: mit('Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators)') },
  // The Windows speech helper (native/speech-win) is one self-contained .NET 8 file: NAudio, System.Speech and the .NET runtime.
  { name: 'NAudio.Core', version: '2.2.1', license: 'MIT', text: mit('Copyright 2020 Mark Heath') },
  { name: 'NAudio.Wasapi', version: '2.2.1', license: 'MIT', text: mit('Copyright 2020 Mark Heath') },
  { name: 'System.Speech', version: '8.0.0', license: 'MIT', text: mit(DOTNET_COPYRIGHT) },
  { name: '.NET Runtime', version: '8.0', license: 'MIT', text: mit(DOTNET_COPYRIGHT, 'The .NET runtime\'s third-party notices: https://github.com/dotnet/runtime/blob/main/THIRD-PARTY-NOTICES.TXT') },
]
const APACHE = 'Licensed under the Apache License, Version 2.0 (the "License"); you may not use these files except in compliance with the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.'
/**
 * Atelier's own decision models (docs/decisions.md › On this computer), from the atelier-decisions project
 * (https://huggingface.co/3SENN/atelier-decisions): atelier-nano ships with Atelier, atelier-mini and atelier-step
 * are downloads. Listed with what they are built from, so About shows where every model comes from.
 */
export const MODEL_LICENSES = [
  {
    name: 'atelier-nano (decision model)',
    version: '0.3',
    license: 'Apache-2.0',
    text: `Atelier's on-device decision model, from the atelier-decisions project (v0.6). ${APACHE}\n\nBuilt from mmBERT-small (https://huggingface.co/jhu-clsp/mmBERT-small), Johns Hopkins University CLSP, under the MIT License:\n\n${mit('Copyright (c) Johns Hopkins University CLSP')}\n\nDistilled from pplx-decider-v1.3 and pplx-decider-flash-v1.3 (https://huggingface.co/perplexity-ai), Perplexity, Apache License 2.0; none of their weights are in it.`,
  },
  {
    name: 'atelier-step (browser tasks, a download)',
    version: '0.1',
    license: 'Apache-2.0',
    text: `atelier-step, an optional download in Settings › Quick decisions, from the atelier-decisions project (step-v0.1). ${APACHE}\n\nBuilt from atelier-nano (above). Trained on steps from Mind2Web (https://huggingface.co/datasets/osunlp/Mind2Web), The Ohio State University, CC BY 4.0, and on generated flows.`,
  },
  {
    name: 'atelier-mini (decision model, a download)',
    version: '0.6',
    license: 'Apache-2.0',
    text: `atelier-mini, an optional download in Settings › Quick decisions, from the atelier-decisions project (v0.6). ${APACHE}\n\nBuilt from Qwen3.5-2B (https://huggingface.co/Qwen/Qwen3.5-2B), Alibaba Cloud, Apache License 2.0: attention made non-causal, adapters trained by distillation and merged into the weights, a new readout, converted to GGUF and quantized. Run by llama.cpp's llama-server (https://github.com/ggml-org/llama.cpp, the ggml authors, MIT License), whose licence comes with the download.`,
  },
]

/**
 * Atelier's own licences besides the MPL: the companion art (ART-LICENSE.md),
 * listed with its text so About shows it next to the packages. None when the
 * checkout has no ART-LICENSE.md (a fork with art of its own).
 */
export function ownLicenses(root) {
  let text
  try {
    text = readFileSync(join(root, 'ART-LICENSE.md'), 'utf8')
  } catch {
    return []
  }
  const version = /^Version (\d+(?:\.\d+)*)\s*$/m.exec(text)?.[1] ?? ''
  return [{ name: 'Atelier Companion Art', version, license: 'LicenseRef-Atelier-Companion-Art', text: text.slice(0, MAX_TEXT) }]
}

const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i
const MAX_TEXT = 100_000

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The SPDX expression from a package.json, old shapes included. */
export function licenseOf(pkg) {
  if (!pkg) return 'UNKNOWN'
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim()
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean)
    if (types.length) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`
  }
  return 'UNKNOWN'
}

/** The licence text shipped in the package folder, or '' when it has none. */
export function licenseText(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return ''
  }
  const file = names.filter((n) => LICENSE_FILE.test(n)).sort((a, b) => a.length - b.length)[0]
  if (!file) return ''
  try {
    return readFileSync(join(dir, file), 'utf8').slice(0, MAX_TEXT)
  } catch {
    return ''
  }
}

/** Node's lookup: the nearest node_modules/<name> from `fromDir` upwards, stopping at `root`. */
function resolvePackage(name, fromDir, root) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (resolve(dir) === resolve(root)) return null
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** Every package reachable from `start` through `dependencies` and `optionalDependencies`. */
function walk(root, start, seen) {
  const queue = start.map((name) => ({ name, from: root }))
  while (queue.length) {
    const { name, from } = queue.shift()
    const dir = resolvePackage(name, from, root)
    if (!dir) continue
    const pkg = readJson(join(dir, 'package.json'))
    if (!pkg?.name) continue
    const key = `${pkg.name}@${pkg.version ?? ''}`
    if (seen.has(key)) continue
    seen.set(key, entryFor(pkg, dir))
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) queue.push({ name: dep, from: dir })
  }
}

const entryFor = (pkg, dir) => ({ name: pkg.name, version: String(pkg.version ?? ''), license: licenseOf(pkg), text: licenseText(dir) })

/**
 * The packages a packaged Atelier ships, from package-lock.json (v2 or v3): every
 * entry that isn't dev-only, linked or extraneous, and (with `root`) is
 * installed, so optional packages for other platforms drop out. Once per name
 * and version, sorted by name.
 */
export function productionPackages(lock, root) {
  const seen = new Map()
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (!path.includes('node_modules/') || !entry || entry.dev || entry.link || entry.extraneous) continue
    if (root && !existsSync(join(root, path, 'package.json'))) continue
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const key = `${name}@${entry.version}`
    if (!seen.has(key)) seen.set(key, { name, version: String(entry.version ?? ''), path })
  }
  return [...seen.values()].sort(byNameVersion)
}

const byNameVersion = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)

/**
 * licenses.json's entries, sorted by name. With a package-lock.json (and no
 * explicit `roots`) the production tree comes from the lock; otherwise from
 * the roots (package.json's dependencies by default). `extra` packages are
 * walked from node_modules either way, and the `native` helpers' packages and
 * Atelier's `own` licences (the companion art's) are added as they are.
 */
export function collectLicenses(root, { roots, extra = EXTRA_ROOTS, native = NATIVE_PACKAGES, own = ownLicenses(root), models = MODEL_LICENSES } = {}) {
  const seen = new Map()
  const lock = roots ? null : readJson(join(root, 'package-lock.json'))
  if (lock?.packages) {
    for (const { path } of productionPackages(lock, root)) {
      const dir = join(root, path)
      const pkg = readJson(join(dir, 'package.json'))
      if (pkg?.name) seen.set(`${pkg.name}@${pkg.version ?? ''}`, entryFor(pkg, dir))
    }
    walk(root, extra, seen)
  } else {
    const top = readJson(join(root, 'package.json')) ?? {}
    walk(root, roots ?? [...Object.keys(top.dependencies ?? {}), ...extra], seen)
  }
  for (const entry of [...native, ...own, ...models]) {
    const key = `${entry.name}@${entry.version}`
    if (!seen.has(key)) seen.set(key, { ...entry })
  }
  return [...seen.values()].sort(byNameVersion)
}

// Licence policy: MIT, Apache-2.0, BSD, ISC and MS-PL are fine; GPL, AGPL
// and patron licences are not. File-level copyleft (MPL-2.0) and font
// licences (OFL-1.1) ship unmodified with their notices, so they pass.
const DENIED = /\b(A?GPL|LGPL|SSPL|BUSL|EUPL|CC-BY-NC|CC-BY-ND|Commons[- ]Clause|Elastic|PolyForm|Patron|Sustainable-Use)/i

/** 'ok', 'denied' or 'unknown' for an SPDX expression: one shippable side of an OR is enough, every side of an AND must be. */
export function licenseVerdict(expression) {
  const expr = String(expression ?? '').trim().replace(/^\((.*)\)$/, '$1').trim()
  if (!expr || expr === 'UNKNOWN' || /^SEE LICEN[CS]E/i.test(expr)) return 'unknown'
  if (/\sOR\s/i.test(expr)) {
    const sides = expr.split(/\s+OR\s+/i).map(licenseVerdict)
    return sides.includes('ok') ? 'ok' : sides.includes('unknown') ? 'unknown' : 'denied'
  }
  if (/\sAND\s/i.test(expr)) {
    const sides = expr.split(/\s+AND\s+/i).map(licenseVerdict)
    return sides.includes('denied') ? 'denied' : sides.includes('unknown') ? 'unknown' : 'ok'
  }
  return DENIED.test(expr) ? 'denied' : 'ok'
}

const isEntry = (e) => !!e && typeof e === 'object' && typeof e.name === 'string' && e.name !== '' && typeof e.version === 'string' && typeof e.license === 'string' && typeof e.text === 'string'

/**
 * What stops a licence list from shipping (`errors`: a malformed entry, a
 * shipped package it leaves out, a licence Atelier can't ship) and what only
 * needs a look (`warnings`: no declared licence, or no licence text).
 */
export function licenseListProblems(list, shipped) {
  if (!Array.isArray(list)) return { errors: ['licenses.json is not an array'], warnings: [] }
  const errors = []
  const warnings = []
  const listed = new Set()
  for (const e of list) {
    if (!isEntry(e)) {
      errors.push(`licenses.json has a malformed entry: ${JSON.stringify(e)?.slice(0, 120)}`)
      continue
    }
    const id = `${e.name}@${e.version}`
    listed.add(id)
    const verdict = licenseVerdict(e.license)
    if (verdict === 'denied') errors.push(`${id} is ${e.license}, which Atelier can't ship`)
    else if (verdict === 'unknown') warnings.push(`${id} declares no licence; check it by hand`)
    else if (!e.text) warnings.push(`${id} (${e.license}) ships no licence text`)
  }
  for (const p of shipped) if (!listed.has(`${p.name}@${p.version}`)) errors.push(`licenses.json leaves out ${p.name}@${p.version}`)
  return { errors, warnings }
}

function check(root, file) {
  const written = readJson(file)
  const current = collectLicenses(root)
  const { errors, warnings } = licenseListProblems(written, current)
  if (!errors.length && JSON.stringify(written) !== JSON.stringify(current)) errors.push('licenses.json is stale: run npm run licenses')
  const textless = warnings.filter((w) => w.endsWith('ships no licence text'))
  for (const w of warnings) if (!textless.includes(w)) console.warn(`licenses: ! ${w}`)
  if (textless.length) console.warn(`licenses: ! ${textless.length} packages ship no licence file; About lists their licence by name`)
  for (const e of errors) console.error(`licenses: ✗ ${e}`)
  if (errors.length) process.exitCode = 1
  else console.log(`licenses: ${current.length} packages, all shippable`)
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '..')
  const at = process.argv.indexOf('--out')
  const out = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(root, 'src/renderer/public/licenses.json')
  if (process.argv.includes('--check')) return check(root, out)
  const entries = collectLicenses(root)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(entries))
  const unknown = entries.filter((e) => e.license === 'UNKNOWN').length
  console.log(`licenses: ${entries.length} packages written to ${out}${unknown ? ` (${unknown} without a declared licence)` : ''}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
