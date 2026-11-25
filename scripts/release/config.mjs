/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Release configuration from the environment. One
// place decides what electron-vite defines for the app (RELEASE in
// src/shared/release.ts) and what electron-builder
// signs, notarizes and publishes. Pure: tests/release.test.ts runs it
// against any env without building anything.
//
// Nothing secret or personal lives here or in electron-builder.yml. The Team
// ID, certificate, provisioning profile, notarization credentials, support
// email, website and GitHub repo all come from env at build time;
// docs/release.md lists every variable. Only the bundle id has a default
// (bundle.mjs). The release scripts' entry points first lay the maintainer's
// private internal/release.env under the environment (loadReleaseEnv); anyone
// else just sets the variables.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describeBranding, officialBranding } from '../branding.mjs'
import { bundleIdFrom } from './bundle.mjs'
import { REPO } from './paths.mjs'

/** @type {readonly ['dev', 'beta', 'stable']} */
export const CHANNELS = ['dev', 'beta', 'stable']

const flag = (v) => v === '1' || v === 'true'
const text = (env, key) => (typeof env[key] === 'string' ? env[key].trim() : '')
const present = (env, ...keys) => keys.every((k) => text(env, k) !== '')

const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,}$/
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** An https URL with a host, or ''. Other schemes never reach a link in the app. */
function website(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname ? url.href : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// The private values file: official builds keep their identity (ATELIER_TEAM_ID,
// ATELIER_SIGN_IDENTITY, APPLE_KEYCHAIN_PROFILE and the like) in the gitignored
// internal/ folder, so the public code carries none of it.

/** Where the maintainer's private values live. Optional: without it, the environment alone decides. */
export const RELEASE_ENV = join(REPO, 'internal', 'release.env')

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

/**
 * A release.env's variables: KEY=VALUE lines, with blank lines and # comments
 * skipped, an optional `export `, and matching quotes around a value removed.
 * An unquoted value ends at " #". Any other line is an error naming it.
 */
export function parseReleaseEnv(source, file = 'release.env') {
  const out = {}
  for (const [i, raw] of String(source ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = ENV_LINE.exec(line)
    if (!m) throw new Error(`${file}:${i + 1} isn't a KEY=VALUE line`)
    let value = m[2].trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    out[m[1]] = value
  }
  return out
}

/**
 * Lays `file` (internal/release.env) under `env`, process.env by default: each
 * of its variables that `env` doesn't have yet is added, so a real environment
 * variable always wins, even an empty one (`ATELIER_SIGN_IDENTITY= npm run
 * package` builds unsigned). No file, no change. Returns the names it added,
 * never their values.
 */
export function loadReleaseEnv(env = process.env, { file = RELEASE_ENV, read = readFileSync, exists = existsSync } = {}) {
  if (!exists(file)) return []
  const added = []
  for (const [key, value] of Object.entries(parseReleaseEnv(read(file, 'utf8'), file))) {
    if (env[key] !== undefined) continue
    env[key] = value
    added.push(key)
  }
  return added
}

/**
 * Which credentials this build can sign and notarize with, per platform.
 * `identity` names the source, never the identity itself.
 */
export function signingPlan(env, platform) {
  if (platform === 'darwin') {
    // ATELIER_SIGN_IDENTITY and CSC_NAME name a keychain identity (by SHA-1 or name; identity.mjs resolves it).
    const identity = present(env, 'ATELIER_SIGN_IDENTITY') || present(env, 'CSC_NAME') ? 'name' : present(env, 'CSC_LINK') ? 'certificate' : null
    const notarize = !identity
      ? null
      : present(env, 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER')
        ? 'api-key'
        : present(env, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')
          ? 'apple-id'
          : // A notarytool profile saved with `xcrun notarytool store-credentials <notary-profile> …`.
            present(env, 'APPLE_KEYCHAIN_PROFILE')
            ? 'keychain-profile'
            : null
    return { platform, identity, notarize }
  }
  if (platform === 'win32') {
    const azure = present(env, 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'ATELIER_AZURE_ENDPOINT', 'ATELIER_AZURE_ACCOUNT', 'ATELIER_AZURE_CERT_PROFILE', 'ATELIER_AZURE_PUBLISHER')
    const identity = azure ? 'azure' : present(env, 'WIN_CSC_LINK') || present(env, 'CSC_LINK') ? 'certificate' : null
    return { platform, identity, notarize: null }
  }
  return { platform, identity: null, notarize: null }
}

/** The whole release configuration for one build on one platform. */
export function releaseSettings(env = process.env, platform = process.platform) {
  const channel = CHANNELS.find((c) => c === text(env, 'ATELIER_CHANNEL')) ?? 'dev'
  const publicRelease = flag(text(env, 'ATELIER_PUBLIC_RELEASE'))
  const owner = text(env, 'ATELIER_RELEASE_OWNER')
  const name = text(env, 'ATELIER_RELEASE_REPO')
  const repo = REPO_PART.test(owner) && REPO_PART.test(name) ? { owner, name } : null
  const signing = signingPlan(env, platform)
  // Squirrel.Mac and Windows only install signed updates; an AppImage needs no
  // signature (a deb can't self-update at all, which the update machine reports at runtime).
  const canInstallUpdates = platform === 'linux' || signing.identity !== null
  const email = text(env, 'ATELIER_SUPPORT_EMAIL')
  const checksForUpdates = repo !== null && channel !== 'dev' && text(env, 'ATELIER_UPDATES') !== '0'
  return {
    channel,
    // A public build is one anyone may download: it takes updates from the public repo.
    publicRelease,
    updatesEnabled: checksForUpdates && canInstallUpdates,
    // An unsigned macOS or Windows build can't install an update, so it only says a newer release is out.
    updateNotices: checksForUpdates && !canInstallUpdates,
    supportEmail: EMAIL.test(email) ? email : '',
    website: website(text(env, 'ATELIER_WEBSITE')),
    repo,
    signing,
    // The app id (bundle.mjs): com.sennechin.atelier unless ATELIER_BUNDLE_ID says otherwise.
    bundleId: bundleIdFrom(env),
  }
}

/** electron-vite `define` entries: string literals, read by src/shared/release.ts. */
export function viteDefines(settings) {
  return {
    __ATELIER_CHANNEL__: JSON.stringify(settings.channel),
    __ATELIER_PUBLIC_RELEASE__: JSON.stringify(settings.publicRelease ? '1' : '0'),
    __ATELIER_UPDATES__: JSON.stringify(settings.updatesEnabled ? '1' : settings.updateNotices ? 'notify' : '0'),
    __ATELIER_SUPPORT_EMAIL__: JSON.stringify(settings.supportEmail),
    __ATELIER_WEBSITE__: JSON.stringify(settings.website),
    __ATELIER_RELEASE_REPO__: JSON.stringify(settings.repo ? `${settings.repo.owner}/${settings.repo.name}` : ''),
    __ATELIER_BUNDLE_ID__: JSON.stringify(settings.bundleId),
  }
}

/**
 * What release.mjs lays over electron-builder.yml: the publish target and the
 * signing sources. The yml keeps `mac.identity: null`, so a plain
 * `npm run package` never signs with whatever the keychain holds.
 */
export function builderOverrides(settings, env = process.env) {
  const config = {}
  if (settings.repo) {
    config.publish = { provider: 'github', owner: settings.repo.owner, repo: settings.repo.name, releaseType: 'draft' }
  }
  const { identity, platform } = settings.signing
  // '' lets electron-builder pick the certificate CSC_LINK imports. A name is
  // resolved to one SHA-1 by electron-builder.config.mjs (identity.mjs).
  if (platform === 'darwin' && identity) config.mac = { identity: text(env, 'ATELIER_SIGN_IDENTITY') || text(env, 'CSC_NAME') }
  if (platform === 'win32' && identity === 'azure') {
    config.win = {
      azureSignOptions: {
        publisherName: text(env, 'ATELIER_AZURE_PUBLISHER'),
        endpoint: text(env, 'ATELIER_AZURE_ENDPOINT'),
        codeSigningAccountName: text(env, 'ATELIER_AZURE_ACCOUNT'),
        certificateProfileName: text(env, 'ATELIER_AZURE_CERT_PROFILE'),
      },
    }
  }
  return config
}

/** The environment for the build tools: the release's choices, and no accidental signing. */
export function buildEnv(settings, env = process.env) {
  const out = { ...env }
  out.ATELIER_CHANNEL = settings.channel
  out.ATELIER_PUBLIC_RELEASE = settings.publicRelease ? '1' : '0'
  if (!settings.updatesEnabled && !settings.updateNotices) out.ATELIER_UPDATES = '0'
  if (!settings.signing.identity) out.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  delete out.ELECTRON_RUN_AS_NODE
  return out
}

/** Why `version` can't ship on `channel`, or null when it can. */
export function versionProblem(version, channel) {
  const m = SEMVER.exec(version ?? '')
  if (!m) return `package.json's version "${version}" is not x.y.z`
  const pre = m[4] ?? null
  if (channel === 'dev') return 'a dev build is never released: set ATELIER_CHANNEL to beta or stable'
  if (channel === 'stable' && pre) return `a stable release can't carry a pre-release tag (${version})`
  if (channel === 'beta' && !/^beta\.\d+$/.test(pre ?? '')) return `a beta release needs a version like ${m[1]}.${m[2]}.${m[3]}-beta.1 (got ${version})`
  return null
}

/**
 * Why a release (anything release.mjs builds without --package-only, and so
 * every publish) can't be made under `env`'s branding, or null when it can.
 * Only official builds are released: they carry the Atelier marks, which only the
 * Atelier project ships (TRADEMARKS.md), and a release with the unofficial
 * branding would put Summit on the update feed official builds read. A
 * branding switch that isn't 1 or 0 is a problem too, never read as either.
 */
/**
 * Why a release can't be built, or null. A build that updates itself from a release repo goes to other people, so it
 * must be a public release: engines from the private internal/ folder only ever ship in personal builds, which keep
 * the updater off.
 */
export function releaseFeedProblem(settings) {
  if (settings.repo && !settings.publicRelease) return 'a build with an update feed (ATELIER_RELEASE_OWNER/ATELIER_RELEASE_REPO) must be a public release: set ATELIER_PUBLIC_RELEASE=1'
  return null
}

export function releaseBrandingProblem(env = process.env, repo = REPO) {
  let official
  try {
    official = officialBranding(env, repo)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  if (official) return null
  return `releases are made with the official branding only, and this build is ${describeBranding(env, repo)}. Official releases set ATELIER_OFFICIAL_BRANDING=1 (docs/release.md); to build an installer of your own, use --package-only or npm run package`
}

/** The versions src/shared/whatsNew.ts has entries for, read from its source. */
export function whatsNewVersions(source) {
  return [...source.matchAll(/\bversion:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
}

/** Compares two x.y.z versions (pre-release tags ignored): -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
