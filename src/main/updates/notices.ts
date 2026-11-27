/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import type { UpdaterBackend, UpdaterBackendEvents } from './backend'
import { compareVersions, parseVersion } from './supportFeed'

// Update notices (UP-01): a build that can't install updates itself (an
// unsigned macOS or Windows build) still looks for a newer release, and says
// so. It reads the same feed electron-updater would, the latest GitHub
// release's latest.yml, and only compares versions: nothing is downloaded or
// installed. The person gets the release page and runs the installer.

type Repo = { owner: string; name: string }

const base = (repo: Repo): string => `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/releases`

/** This platform's update feed on the latest release (the file electron-builder writes for it). */
export function releaseFeedUrl(repo: Repo, platform: NodeJS.Platform): string {
  const file = platform === 'darwin' ? 'latest-mac.yml' : platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'
  return `${base(repo)}/latest/download/${file}`
}

/** The page a version's installers are on. */
export function releasePageUrl(repo: Repo, version: string): string {
  return `${base(repo)}/tag/v${encodeURIComponent(version)}`
}

/** The feed's top-level `version:`, or null when there is none or it isn't x.y.z. */
export function parseFeedVersion(text: string): string | null {
  const m = /^version:[ \t]*['"]?([^\s'"#]+)['"]?[ \t]*(?:#.*)?\r?$/m.exec(text)
  return m && parseVersion(m[1]!) ? m[1]!.replace(/^v/, '') : null
}

export const RELEASE_FEED_MAX_BYTES = 64 * 1024

export interface ReleaseNoticeOptions {
  repo: Repo
  platform: NodeJS.Platform
  currentVersion: string
  fetcher?: typeof fetch
  timeoutMs?: number
}

/**
 * Checks only. A release with no build for this platform (no feed file) is
 * "up to date": there is nothing to offer. download() and quitAndInstall()
 * are never reached, because the controller opens the release page instead.
 */
export class ReleaseNoticeBackend extends EventEmitter<UpdaterBackendEvents> implements UpdaterBackend {
  readonly #o: ReleaseNoticeOptions

  constructor(options: ReleaseNoticeOptions) {
    super()
    this.#o = options
  }

  async check(): Promise<void> {
    this.emit('checking')
    let res: Response
    let text = ''
    try {
      // Plain fetch, as for the support feed: no cookies, no referrer and no Atelier identifiers.
      res = await (this.#o.fetcher ?? fetch)(releaseFeedUrl(this.#o.repo, this.#o.platform), {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
      })
      if (res.ok) text = await res.text()
    } catch (err) {
      // Whatever stopped the request, the feed wasn't reached: the controller retries it as a network failure.
      this.emit('error', new Error(`network: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    if (res.status === 404) return void this.emit('not-available')
    if (!res.ok) return void this.emit('error', new Error(`HttpError: ${res.status}`))
    const version = text.length <= RELEASE_FEED_MAX_BYTES ? parseFeedVersion(text) : null
    if (!version) return void this.emit('error', new Error('The release feed has no version.'))
    if (compareVersions(version, this.#o.currentVersion) > 0) this.emit('available', { version, size: 0 })
    else this.emit('not-available')
  }

  async download(): Promise<void> {
    this.emit('error', new Error('This build announces updates; it does not download them.'))
  }

  quitAndInstall(): void {
    // Nothing was downloaded.
  }
}
