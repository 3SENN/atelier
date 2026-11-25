/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for config.mjs, so electron.vite.config.ts and the tests stay checked.

export type Channel = 'dev' | 'beta' | 'stable'
export const CHANNELS: readonly Channel[]

export type Env = Record<string, string | undefined>

export interface SigningPlan {
  platform: string
  /** Where the identity comes from; never the identity itself. */
  identity: 'name' | 'certificate' | 'azure' | null
  notarize: 'api-key' | 'apple-id' | 'keychain-profile' | null
}

export interface ReleaseSettings {
  channel: Channel
  publicRelease: boolean
  updatesEnabled: boolean
  /** Unsigned with a release repo: the app announces new releases instead of installing them. */
  updateNotices: boolean
  supportEmail: string
  website: string
  repo: { owner: string; name: string } | null
  signing: SigningPlan
  /** The app id: com.sennechin.atelier unless ATELIER_BUNDLE_ID says otherwise. */
  bundleId: string
}

export const RELEASE_ENV: string
export function parseReleaseEnv(source: string, file?: string): Record<string, string>
export function loadReleaseEnv(
  env?: Env,
  options?: { file?: string; read?: (path: string, encoding: 'utf8') => string; exists?: (path: string) => boolean },
): string[]
export function signingPlan(env: Env, platform: string): SigningPlan
export function releaseSettings(env?: Env, platform?: string): ReleaseSettings
export function viteDefines(settings: ReleaseSettings): Record<string, string>
export function builderOverrides(settings: ReleaseSettings, env?: Env): {
  publish?: { provider: 'github'; owner: string; repo: string; releaseType: 'draft' }
  mac?: { identity: string }
  win?: { azureSignOptions: { publisherName: string; endpoint: string; codeSigningAccountName: string; certificateProfileName: string } }
}
export function buildEnv(settings: ReleaseSettings, env?: Env): Env
export function versionProblem(version: string | undefined, channel: Channel): string | null
/** Why a release can't be made with env's branding (only official builds are released), or null. */
export function releaseFeedProblem(settings: { repo: { owner: string; name: string } | null; publicRelease: boolean }): string | null
export function releaseBrandingProblem(env?: Env, repo?: string): string | null
export function whatsNewVersions(source: string): string[]
export function compareVersions(a: string, b: string): -1 | 0 | 1
