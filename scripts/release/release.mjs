#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Builds, packages and verifies an Atelier release. docs/release.md is the runbook.
//
//   node scripts/release/release.mjs                  release for this machine's platform
//   node scripts/release/release.mjs --publish        and upload to the GitHub draft release
//   node scripts/release/release.mjs --package-only   just package (npm run package:mac and friends)
//   options: --mac | --win | --linux (must match this machine), --skip-verify
//
// A release (not --package-only):
//   1. refuses any branding but the official one (ATELIER_OFFICIAL_BRANDING=1;
//      TRADEMARKS.md), then checks the version against ATELIER_CHANNEL, the tag
//      (in CI), and that src/shared/whatsNew.ts has an entry for it (the
//      what's-new card);
//   2. builds the app with the release defines, the native helpers and the
//      licence list, then packages with electron-builder, signing and
//      notarizing only with the credentials in env;
//   3. writes SHA256SUMS and atelier-support.json next to the installers;
//   4. runs verify.mjs: signatures, fuses, Info.plist, resources, and the smoke
//      test inside the packaged app (which must prove a public build offers
//      your Claude subscription and the API key);
//   5. with --publish, and only once all of that passed, uploads the
//      installers and update feeds to the draft release for the tag v<version>
//      (gh; the draft is opened when missing, but only for a tag that is
//      already pushed).
// It never runs git: tagging and pushing stay with the person.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { describeBranding, loadBranding } from '../branding.mjs'
import { ofVersion, refreshFeed, uploadsFrom } from './checks.mjs'
import { writeChecksums } from './checksums.mjs'
import { builderConfig } from './builderConfig.mjs'
import { buildEnv, loadReleaseEnv, releaseBrandingProblem, releaseFeedProblem, releaseSettings, versionProblem, whatsNewVersions } from './config.mjs'
import { DIST, REPO, packageJson } from './paths.mjs'
import { writeSupportFeed } from './support-feed.mjs'
import { verify } from './verify.mjs'

const require = createRequire(import.meta.url)
const PLATFORM_FLAGS = { '--mac': 'darwin', '--win': 'win32', '--linux': 'linux' }

class ReleaseError extends Error {}
const fail = (message) => {
  throw new ReleaseError(message)
}

function parseArgs(argv) {
  const opts = { platform: process.platform, packageOnly: false, publish: false, verify: true }
  for (const a of argv) {
    if (a in PLATFORM_FLAGS) opts.platform = PLATFORM_FLAGS[a]
    else if (a === '--package-only') opts.packageOnly = true
    else if (a === '--publish') opts.publish = true
    else if (a === '--skip-verify') opts.verify = false
    else fail(`unknown option ${a}`)
  }
  // The native helpers build only on their own OS (swiftc, dotnet), so no cross-builds.
  if (opts.platform !== process.platform) fail(`build ${opts.platform} on ${opts.platform}; this machine is ${process.platform}`)
  if (opts.packageOnly && opts.publish) fail('--package-only and --publish do not go together')
  if (opts.publish && !opts.verify) fail('--skip-verify never publishes: an unverified build stays in dist/')
  return opts
}

function step(title) {
  console.log(`\n▸ ${title}`)
}

function run(cmd, args, env, { optional = false } = {}) {
  // Windows runs .cmd shims only through a shell.
  const r = spawnSync(cmd, args, { cwd: REPO, env, stdio: 'inherit', shell: cmd.endsWith('.cmd') })
  if (r.status === 0) return true
  const message = `${[cmd, ...args].join(' ')} exited with ${r.status ?? r.signal}`
  if (!optional) fail(message)
  console.warn(`  ! ${message}`)
  return false
}

const node = (script, env, options) => run(process.execPath, [join(REPO, script)], env, options)
const bin = (name) => join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)

/** Refuses a release that can't ship, before anything is built. */
function preflight(version, settings, opts, env) {
  // Only official builds are released or published (TRADEMARKS.md); --package-only builds any branding.
  const branding = releaseBrandingProblem(env)
  if (branding) fail(branding)
  const problem = versionProblem(version, settings.channel)
  if (problem) fail(problem)
  const notes = readFileSync(join(REPO, 'src', 'shared', 'whatsNew.ts'), 'utf8')
  if (!whatsNewVersions(notes).includes(version)) fail(`src/shared/whatsNew.ts has no entry for ${version}; add one before releasing`)
  const feed = releaseFeedProblem(settings)
  if (feed) fail(feed)
  const tag = env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : null
  if (tag && tag !== `v${version}`) fail(`the tag ${tag} doesn't match package.json's version ${version}`)
  if (!opts.publish) return
  if (!settings.repo) fail('publishing needs ATELIER_RELEASE_OWNER and ATELIER_RELEASE_REPO')
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) fail('publishing needs GH_TOKEN')
  if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).status !== 0) fail('publishing uploads with the GitHub CLI (gh); install it first')
  // An unsigned macOS or Windows build can't update itself and alarms Gatekeeper and SmartScreen.
  if (opts.platform !== 'linux' && !settings.signing.identity) fail('a published macOS or Windows build must be signed (docs/release.md, Signing)')
  if (opts.platform === 'darwin' && !settings.signing.notarize) fail('a published macOS build must be notarized (APPLE_API_KEY…, APPLE_ID… or APPLE_KEYCHAIN_PROFILE)')
}

function describe(settings) {
  const s = settings.signing
  console.log(`  channel ${settings.channel}${settings.publicRelease ? ', public' : ''}, app id ${settings.bundleId}`)
  console.log(`  updates ${settings.updatesEnabled ? `on, from ${settings.repo.owner}/${settings.repo.name}` : 'off'}`)
  console.log(`  signing ${s.identity ? `from ${s.identity}` : 'off (unsigned)'}${s.platform === 'darwin' ? `, notarization ${s.notarize ? `with ${s.notarize}` : 'skipped'}` : ''}`)
  if (!s.identity && s.platform !== 'linux') console.warn('  ! unsigned: fine for testing on this machine, not for anyone else')
  if (s.platform === 'darwin' && s.identity && !s.notarize) console.warn('  ! signed but not notarized: Gatekeeper will block it on other Macs')
}

function buildNative(platform, env) {
  if (platform === 'darwin') {
    node('scripts/build-speech-helper.mjs', env)
    // Haptics are a nicety with a no-op fallback, so a failed addon build only warns.
    if (!node('scripts/build-native.mjs', env, { optional: true })) console.warn('  ! shipping without trackpad haptics')
    if (existsSync(join(REPO, 'scripts', 'build-calendar-helper.mjs'))) node('scripts/build-calendar-helper.mjs', env)
    // On-device page translation (TR-05) needs Apple's Translation SDK; without it pages still translate with the companion when allowed.
    if (!node('scripts/build-translate-helper.mjs', env, { optional: true })) console.warn('  ! shipping without on-device translation')
  }
  // The win32 branch of the same script publishes atelier-speech.exe with the
  // .NET 8 SDK, which the Windows CI job has.
  if (platform === 'win32') node('scripts/build-speech-helper.mjs', env)
  // The internal folder's packaging steps, when this build takes it (scripts/internal.mjs, internal/build.json).
  run(process.execPath, [join(REPO, 'scripts', 'internal.mjs'), 'prepackage'], env)
}

/**
 * electron-builder's config for this env (builderConfig.mjs, the same one
 * `npm run package` uses). On macOS this is the signing preflight: the mode,
 * the identity resolved to one hash, and in the passkeys mode the profile
 * checked. Run before anything is built, so a bad profile fails in seconds.
 */
function signingPreflight(env) {
  try {
    return builderConfig(env, { log: (m) => console.log(`  signing mode ${m}`) })
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

async function packageApp(opts, env) {
  const { build, Platform } = require('electron-builder')
  const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[opts.platform]
  // electron-builder reads signing and notarization credentials from process.env.
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  await build({
    projectDir: REPO,
    targets: platform.createTarget(),
    // The config file itself: an object here would be merged over electron-builder.yml,
    // and electron-builder merges arrays by concatenating them.
    config: join(REPO, 'electron-builder.config.mjs'),
    // Nothing is uploaded before verify.mjs passes; uploadToDraft does that.
    // The update feeds (latest*.yml) are written either way.
    publish: 'never',
  })
}

const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')

/**
 * Stapling changes a dmg's bytes after electron-builder hashed it, so the
 * macOS feeds get its new sha512 and size, and its stale blockmap goes.
 */
function refreshMacFeeds(dmgs) {
  if (!dmgs.length) return
  const changed = dmgs.map((name) => ({ name, sha512: sha512(join(DIST, name)), size: statSync(join(DIST, name)).size }))
  for (const name of readdirSync(DIST).filter((n) => /-mac\.yml$/.test(n))) {
    const file = join(DIST, name)
    writeFileSync(file, refreshFeed(readFileSync(file, 'utf8'), changed))
  }
  for (const name of dmgs) rmSync(join(DIST, `${name}.blockmap`), { force: true })
}

/** Staples the notarization ticket to this version's dmgs (electron-builder staples the app). */
function notarizeDmgs(settings, version, env) {
  if (settings.signing.platform !== 'darwin' || !settings.signing.notarize) return
  const auth =
    settings.signing.notarize === 'api-key'
      ? ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER]
      : settings.signing.notarize === 'keychain-profile'
        ? ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : [])]
        : ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID]
  const dmgs = ofVersion(readdirSync(DIST), version).filter((n) => n.endsWith('.dmg'))
  for (const dmg of dmgs) {
    run('xcrun', ['notarytool', 'submit', join(DIST, dmg), '--wait', ...auth], env)
    run('xcrun', ['stapler', 'staple', join(DIST, dmg)], env)
  }
  refreshMacFeeds(dmgs)
}

/**
 * Uploads this platform's installers and update feeds to the draft release.
 * The release workflow opens the draft first; run by hand, this opens it, but
 * `--verify-tag` keeps gh from creating a tag: tagging stays with the person.
 */
function uploadToDraft(settings, version, env) {
  const tag = `v${version}`
  const repo = `${settings.repo.owner}/${settings.repo.name}`
  const files = uploadsFrom(ofVersion(readdirSync(DIST), version))
  if (!files.length) fail(`nothing to upload in ${DIST}`)
  const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { env, stdio: 'ignore' }).status === 0
  if (!exists) {
    const pre = settings.channel === 'beta' ? ['--prerelease'] : []
    const name = loadBranding(env).name
    run('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', ...pre, '--title', `${name} ${version}`, '--notes', `${name} ${version}. The highlights are in src/shared/whatsNew.ts.`], env)
  }
  run('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...files.map((f) => join(DIST, f))], env)
  console.log(`  uploaded ${files.length} files to the draft ${tag} on ${repo}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { version } = packageJson()
  // The maintainer's private values (internal/release.env) go under the real
  // environment before anything reads it; a variable that is set always wins.
  const fromFile = loadReleaseEnv()
  const settings = releaseSettings(process.env, opts.platform)
  const env = buildEnv(settings, process.env)
  console.log(`${describeBranding(env)} ${version}: ${opts.packageOnly ? 'packaging' : 'release'} for ${opts.platform}`)
  if (fromFile.length) console.log(`  ${fromFile.join(', ')} from internal/release.env`)
  describe(settings)
  if (!opts.packageOnly) preflight(version, settings, opts, process.env)
  signingPreflight(env)

  step('Building the app')
  run(bin('electron-vite'), ['build'], env)
  // The Atelier kit apps load (docs/apps.md › The kit), into out/kit/.
  node('scripts/kit/build.mjs', env)
  step('Building the native helpers')
  buildNative(opts.platform, env)
  // Atelier's own decision model (docs/decisions.md › On this computer), pinned and checked by size and SHA-256.
  step('Fetching the on-device decision model')
  node('scripts/fetch-decision-model.mjs', env)
  step('Writing the licence list')
  node('scripts/licenses.mjs', env)
  // A release refuses a list that misses a shipped package or carries a licence Atelier can't ship.
  run(process.execPath, [join(REPO, 'scripts/licenses.mjs'), '--check'], env, { optional: opts.packageOnly })

  step('Packaging')
  await packageApp(opts, env)
  // electron-builder notarizes and staples the app; the dmgs go to Apple here, also for --package-only.
  notarizeDmgs(settings, version, env)
  if (opts.packageOnly) {
    console.log(`\nPackaged under ${DIST}. Run npm run smoke:packaged to test it.`)
    return
  }

  step('Writing SHA256SUMS and atelier-support.json')
  const { out } = await writeChecksums(DIST, version)
  console.log(`  ${out}`)
  console.log(`  ${writeSupportFeed().out}`)

  if (opts.verify) {
    step('Verifying the packaged app')
    const problems = await verify({ settings, version })
    if (problems.length) fail(`the packaged app failed verification:\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`)
  }
  if (opts.publish) {
    step('Uploading to the draft release')
    uploadToDraft(settings, version, env)
  }
  console.log(`\n${loadBranding(env).name} ${version} is ready in ${DIST}.${opts.publish ? ' The installers are on the draft release; publish it on GitHub when you are ready.' : ''}`)
}

try {
  await main()
} catch (err) {
  console.error(`\nrelease: ${err instanceof ReleaseError ? err.message : (err?.stack ?? err)}`)
  process.exitCode = 1
}
