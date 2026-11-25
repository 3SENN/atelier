/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join, normalize, sep } from 'node:path'
import type { MiniStatus } from '@shared/decisions'
import { deviceMiniDir } from './device'

// atelier-mini as an optional download (docs/decisions.md › On this computer). The small model ships with Atelier;
// the mini (1.3 GB: the model and llama.cpp's server for this platform) is fetched only when you ask for it in
// Settings › Quick decisions. Every file is listed in the manifest that ships with Atelier (device/miniManifest.ts)
// with its size and SHA-256, so what lands on disk is exactly what was built and measured, whoever serves it.
//
// Files go to <folder>.partial first, are checked as they stream in, and the folder is swapped in whole only when
// every one matches: a broken or stopped download never leaves a half-installed model. A stopped download resumes
// where it stopped (an HTTP range request) the next time.

export interface MiniFile {
  /** Where it goes, relative to the folder (a server's files under server/), with forward slashes. */
  path: string
  /** Where it is, relative to the manifest's base. */
  url: string
  size: number
  sha256: string
}

export interface MiniManifest {
  version: string
  /** Where the files are: base + url is each one's address. Empty while there is no download location. */
  base: string
  /** The model's files, for every platform. */
  model: MiniFile[]
  /** Each platform's server (as `${process.platform}-${process.arch}`), in server/. */
  servers: Record<string, MiniFile[]>
}

/** A Response-like download: the status and the body as a stream of bytes. */
export type Download = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; body: AsyncIterable<Uint8Array> | null }>

export interface MiniInstallerOptions {
  /** Where the mini lives once installed. */
  dir: string
  manifest: MiniManifest
  download: Download
  /** Before the folder is swapped or removed: stop whatever has its files open (the helper and its server). */
  release(): void
  platform?: string
  /** A folder set from outside (ATELIER_DECISION_MINI): used as it is, never downloaded into or removed. */
  external?: boolean
  /** Overrides the manifest's base (ATELIER_DECISION_MINI_URL), for testing a download location. */
  base?: string
  /** A download of model files only, with no server for this platform (atelier-step, deviceStep.ts). Default true. */
  needsServer?: boolean
  /** The installed folder when every file is there (default: the mini's files and its server, deviceMiniDir). */
  installed?: (dir: string) => string | null
}

/** Bytes of headroom beyond the download itself, so installing never fills the disk. */
const SPARE = 200 * 1024 * 1024

export class MiniInstaller {
  readonly #o: MiniInstallerOptions

  /** The version this downloads (its manifest's), as Settings names it. */
  get version(): string {
    return this.#o.manifest.version
  }
  #job: { abort: AbortController; received: number; total: number } | null = null
  #error: string | null = null

  constructor(o: MiniInstallerOptions) {
    this.#o = o
  }

  #files(): MiniFile[] | null {
    if (!this.#base()) return null
    if (this.#o.needsServer === false) return this.#o.manifest.model.length ? [...this.#o.manifest.model] : null
    const server = this.#o.manifest.servers[this.#o.platform ?? `${process.platform}-${process.arch}`]
    if (!server?.length) return null
    return [...this.#o.manifest.model, ...server.map((f) => ({ ...f, path: `server/${f.path}` }))]
  }

  #base(): string {
    return this.#o.base || this.#o.manifest.base
  }

  /**
   * The installed folder, or null. A folder of another version than the manifest's (Atelier updated, the model not
   * yet) counts as not installed, so it is never run with code that expects the new one, and Settings offers the
   * download again. A folder set from outside is used as it is.
   */
  dir(): string | null {
    const found = this.#o.installed ? this.#o.installed(this.#o.dir) : deviceMiniDir(this.#o.dir, (this.#o.platform?.split('-')[0] as NodeJS.Platform | undefined) ?? process.platform)
    if (!found || this.#o.external) return found
    return versionOf(found) === this.#o.manifest.version ? found : null
  }

  status(): MiniStatus {
    if (this.#o.external) return this.dir() ? { state: 'ready', external: true } : { state: 'unavailable' }
    if (this.#job)
      return {
        state: 'downloading',
        received: this.#job.received,
        total: this.#job.total,
      }
    if (this.dir()) return { state: 'ready', external: false }
    const files = this.#files()
    if (!files) return { state: 'unavailable' }
    const total = files.reduce((s, f) => s + f.size, 0)
    return this.#error ? { state: 'failed', error: this.#error, total } : { state: 'absent', total }
  }

  /** Downloads and checks every file, then swaps the folder in. Resolves when done, stopped or failed (see status()). */
  async install(): Promise<void> {
    const files = this.#files()
    if (this.#o.external || this.#job || !files) return
    const total = files.reduce((s, f) => s + f.size, 0)
    const job = { abort: new AbortController(), received: 0, total }
    this.#job = job
    this.#error = null
    const staging = `${this.#o.dir}.partial`
    try {
      // What a stopped download of another version left is no use to this one: start it over.
      if (versionOf(staging, PARTIAL_VERSION) !== this.#o.manifest.version) rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, PARTIAL_VERSION), JSON.stringify({ version: this.#o.manifest.version }))
      const free = freeBytes(staging)
      const have = files.reduce((s, f) => s + Math.min(f.size, sizeOf(join(staging, f.path))), 0)
      if (free !== null && free < total - have + SPARE) throw new Error(`Not enough free disk space (${Math.ceil((total - have + SPARE) / 1e6)} MB needed)`)
      for (const f of files) {
        await this.#fetch(f, staging, job)
        if (process.platform !== 'win32' && f.path.startsWith('server/')) chmodSync(join(staging, f.path), 0o755)
      }
      writeFileSync(join(staging, 'version.json'), JSON.stringify({ version: this.#o.manifest.version }))
      rmSync(join(staging, PARTIAL_VERSION), { force: true })
      this.#o.release()
      rmSync(this.#o.dir, { recursive: true, force: true })
      renameSync(staging, this.#o.dir)
    } catch (err) {
      // Stopped: no error to show, and the staged files stay for the next try.
      if (!job.abort.signal.aborted) this.#error = err instanceof Error ? err.message.slice(0, 300) : String(err)
    } finally {
      this.#job = null
    }
  }

  cancel(): void {
    this.#job?.abort.abort()
  }

  /** Removes the mini (and anything staged); the small model goes on alone. */
  remove(): void {
    if (this.#o.external) return
    this.cancel()
    this.#o.release()
    rmSync(`${this.#o.dir}.partial`, { recursive: true, force: true })
    rmSync(this.#o.dir, { recursive: true, force: true })
    this.#error = null
  }

  async #fetch(f: MiniFile, staging: string, job: { abort: AbortController; received: number }): Promise<void> {
    const path = normalize(join(staging, f.path))
    if (!path.startsWith(normalize(staging) + sep)) throw new Error(`A file outside the folder: ${f.path}`)
    mkdirSync(dirname(path), { recursive: true })
    let start = sizeOf(path)
    if (start > f.size) {
      rmSync(path, { force: true })
      start = 0
    }
    const hash = createHash('sha256')
    if (start > 0) for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    job.received += start
    if (start < f.size) {
      const res = await this.#o.download(this.#base() + f.url, {
        signal: job.abort.signal,
        headers: start > 0 ? { range: `bytes=${start}-` } : {},
      })
      if (res.status !== 200 && res.status !== 206) throw new Error(`${f.path}: HTTP ${res.status}`)
      if (start > 0 && res.status === 200) {
        // The server sent it whole instead of the rest: start this file over.
        job.received -= start
        return this.#fetchWhole(f, path, res, job)
      }
      await write(path, res.body, start > 0, hash, job, f.size - start)
    }
    const digest = hash.digest('hex')
    if (sizeOf(path) !== f.size || digest !== f.sha256) {
      rmSync(path, { force: true })
      throw new Error(`${f.path} did not match its checksum`)
    }
  }

  async #fetchWhole(f: MiniFile, path: string, res: { body: AsyncIterable<Uint8Array> | null }, job: { received: number }): Promise<void> {
    const hash = createHash('sha256')
    await write(path, res.body, false, hash, job, f.size)
    if (sizeOf(path) !== f.size || hash.digest('hex') !== f.sha256) {
      rmSync(path, { force: true })
      throw new Error(`${f.path} did not match its checksum`)
    }
  }
}

async function write(
  path: string,
  body: AsyncIterable<Uint8Array> | null,
  append: boolean,
  hash: ReturnType<typeof createHash>,
  job: { received: number },
  most: number,
): Promise<void> {
  if (!body) throw new Error('An empty reply')
  const out = createWriteStream(path, { flags: append ? 'a' : 'w' })
  let written = 0
  try {
    for await (const chunk of body) {
      written += chunk.byteLength
      if (written > most) throw new Error('More bytes than the manifest lists')
      hash.update(chunk)
      job.received += chunk.byteLength
      if (!out.write(chunk)) await once(out, 'drain')
    }
  } finally {
    out.end()
    await once(out, 'close')
  }
}

/** Which version a staged download is for (removed once it is swapped in). */
const PARTIAL_VERSION = 'downloading.json'

/** The version an installed (or staged) folder says it holds, from its version.json; null when it says none. */
function versionOf(dir: string, file = 'version.json'): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function freeBytes(path: string): number | null {
  try {
    const s = statfsSync(path)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}
