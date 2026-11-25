/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Build-time release configuration. The values come from electron-vite
// defines read from env at build time (ATELIER_CHANNEL, ATELIER_PUBLIC_RELEASE,
// ATELIER_SUPPORT_EMAIL, ATELIER_WEBSITE, ATELIER_RELEASE_OWNER, ATELIER_RELEASE_REPO).
// Each define is read through `typeof`, so tests and builds without them get
// the safe defaults: a dev build, not public, no updates, no contact details.
// No personal identity, email or repo is ever committed here.
//
// The defines are declared for main in src/main/defines.d.ts and for the
// renderer in src/renderer/src/env.d.ts; scripts/release/config.mjs computes
// them.

import { BRANDING } from './branding'

export type ReleaseChannel = 'dev' | 'beta' | 'stable'

export interface ReleaseConfig {
  channel: ReleaseChannel
  publicRelease: boolean
  updatesEnabled: boolean
  /** An unsigned build with a release repo: it can't update itself, so it announces new releases instead. */
  updateNotices: boolean
  supportEmail: string
  website: string
  repo: { owner: string; name: string } | null
}

const CHANNELS: readonly ReleaseChannel[] = ['dev', 'beta', 'stable']

/** Parses the raw define strings; exported for tests. */
export function releaseFrom(raw: {
  channel?: string
  publicRelease?: string
  updates?: string
  supportEmail?: string
  website?: string
  repo?: string
}): ReleaseConfig {
  const flag = (v: string | undefined): boolean => v === '1' || v === 'true'
  const channel = CHANNELS.find((c) => c === raw.channel) ?? 'dev'
  const repoMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw.repo ?? '')
  return {
    channel,
    publicRelease: flag(raw.publicRelease),
    updatesEnabled: flag(raw.updates),
    updateNotices: raw.updates === 'notify',
    supportEmail: raw.supportEmail ?? '',
    website: raw.website ?? '',
    repo: repoMatch ? { owner: repoMatch[1]!, name: repoMatch[2]! } : null,
  }
}

/**
 * Where the source code of this build is published, as the MPL-2.0 asks
 * (Settings › About, "Source code"). A fork that ships its own builds points
 * this at its own repository.
 */
export const SOURCE_URL = 'https://github.com/3SENN/atelier'

/**
 * The companion art's licence (ART-LICENSE.md), which Settings › About names
 * beside the MPL. A name, so the catalogues take it as {artLicense}.
 */
export const ART_LICENSE_NAME = 'Atelier Companion Art License'

/** PRIVACY.md there: what the app keeps on the computer and every service it can contact (Settings › About). */
export const PRIVACY_URL = `${SOURCE_URL}/blob/main/PRIVACY.md`

/**
 * Where people come together to make the project: Discord, Discussions and every
 * way to help (Settings › About and Help › Join the Community). A fork points
 * this at its own.
 */
export const COMMUNITY_URL = 'https://atelierbrowser.eu/community.html'

/** The default app id: the branding's (scripts/release/bundle.mjs decides it the same way). */
export const DEFAULT_BUNDLE_ID: string = BRANDING.bundleId

/**
 * The app id the build was packaged with (electron-builder's appId, from
 * ATELIER_BUNDLE_ID, else the branding's), so the Windows AppUserModelId and the
 * macOS own-app checks match what was packaged.
 */
export const BUNDLE_ID: string = typeof __ATELIER_BUNDLE_ID__ === 'string' && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(__ATELIER_BUNDLE_ID__) ? __ATELIER_BUNDLE_ID__ : DEFAULT_BUNDLE_ID

export const RELEASE: ReleaseConfig = releaseFrom({
  channel: typeof __ATELIER_CHANNEL__ === 'string' ? __ATELIER_CHANNEL__ : undefined,
  publicRelease: typeof __ATELIER_PUBLIC_RELEASE__ === 'string' ? __ATELIER_PUBLIC_RELEASE__ : undefined,
  updates: typeof __ATELIER_UPDATES__ === 'string' ? __ATELIER_UPDATES__ : undefined,
  supportEmail: typeof __ATELIER_SUPPORT_EMAIL__ === 'string' ? __ATELIER_SUPPORT_EMAIL__ : undefined,
  website: typeof __ATELIER_WEBSITE__ === 'string' ? __ATELIER_WEBSITE__ : undefined,
  repo: typeof __ATELIER_RELEASE_REPO__ === 'string' ? __ATELIER_RELEASE_REPO__ : undefined,
})
