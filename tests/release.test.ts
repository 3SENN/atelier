/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DebugLogger } from 'builder-util'
import { getConfig, validateConfiguration } from 'app-builder-lib/out/util/config/config'
import type { Configuration } from 'app-builder-lib'
import { describe, expect, it } from 'vitest'
import { RELEASE, releaseFrom } from '../src/shared/release'
import { WHATS_NEW } from '../src/shared/whatsNew'
import { resolveAppRoot, resolveResourcePath } from '../src/main/resources'
import {
  buildEnv,
  builderOverrides,
  compareVersions,
  releaseBrandingProblem,
  releaseFeedProblem,
  releaseSettings,
  versionProblem,
  viteDefines,
  whatsNewVersions,
  type Env,
} from '../scripts/release/config.mjs'
import {
  MAC_HELPERS,
  MAC_USAGE_KEYS,
  PUBLIC_FLAG_CHECK,
  checksumLines,
  codesignDetails,
  expectedFuses,
  expectedResources,
  fuseProblems,
  fusesFromWire,
  helperProblems,
  infoPlistFromOtool,
  ofVersion,
  plistProblems,
  plistStrings,
  refreshFeed,
  smokeProblems,
  smokeSummary,
  supportFeed,
  uploadsFrom,
} from '../scripts/release/checks.mjs'
import { packagedApps } from '../scripts/release/paths.mjs'
import { loadBranding, readBranding } from '../scripts/branding.mjs'
import { iconComposer } from '../scripts/release/afterPack.mjs'
import { brandedConfig } from '../scripts/release/builderConfig.mjs'
// @ts-expect-error: the plain .mjs generator has no type declarations (its own test relies on that); typed below.
import * as licenses from '../scripts/licenses.mjs'

type LicenseEntry = { name: string; version: string; license: string; text: string }
const { MODEL_LICENSES, NATIVE_PACKAGES, collectLicenses, licenseListProblems, licenseVerdict, ownLicenses, productionPackages } = licenses as {
  MODEL_LICENSES: LicenseEntry[]
  NATIVE_PACKAGES: LicenseEntry[]
  collectLicenses(root: string, options?: { roots?: string[]; extra?: string[]; native?: LicenseEntry[]; own?: LicenseEntry[]; models?: LicenseEntry[] }): LicenseEntry[]
  ownLicenses(root: string): LicenseEntry[]
  licenseVerdict(expression: unknown): 'ok' | 'denied' | 'unknown'
  licenseListProblems(list: unknown, shipped: Array<{ name: string; version: string }>): { errors: string[]; warnings: string[] }
  productionPackages(lock: unknown, root?: string): Array<{ name: string; version: string; path: string }>
}

// The release configuration, electron-builder.yml, and the checks the
// release scripts run on a packaged app. Offline: nothing here builds, signs
// or reaches a network.

const REPO = resolve(__dirname, '..')
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8')

const SIGNED_MAC: Env = {
  CSC_LINK: 'base64-p12',
  CSC_KEY_PASSWORD: 'secret',
  APPLE_API_KEY: '/tmp/key.p8',
  APPLE_API_KEY_ID: 'KEYID',
  APPLE_API_ISSUER: 'issuer',
}
const AZURE: Env = {
  AZURE_TENANT_ID: 't',
  AZURE_CLIENT_ID: 'c',
  AZURE_CLIENT_SECRET: 's',
  ATELIER_AZURE_ENDPOINT: 'https://weu.codesigning.azure.net',
  ATELIER_AZURE_ACCOUNT: 'account',
  ATELIER_AZURE_CERT_PROFILE: 'profile',
  ATELIER_AZURE_PUBLISHER: 'Publisher',
}
const PUBLISH: Env = { ATELIER_CHANNEL: 'stable', ATELIER_RELEASE_OWNER: 'someone', ATELIER_RELEASE_REPO: 'atelier' }

/** RELEASE as the app would read it, after the defines went through electron-vite. */
function appRelease(env: Env, platform: string) {
  const d = viteDefines(releaseSettings(env, platform))
  const v = (k: string): string => JSON.parse(d[k]!) as string
  return {
    release: releaseFrom({
      channel: v('__ATELIER_CHANNEL__'),
      publicRelease: v('__ATELIER_PUBLIC_RELEASE__'),
      updates: v('__ATELIER_UPDATES__'),
      supportEmail: v('__ATELIER_SUPPORT_EMAIL__'),
      website: v('__ATELIER_WEBSITE__'),
      repo: v('__ATELIER_RELEASE_REPO__'),
    }),
  }
}

describe('release settings from env', () => {
  it('defaults to a safe dev build', () => {
    // The official branding, stated, so the result doesn't depend on whether this checkout has internal/.
    const OFFICIAL = { ATELIER_OFFICIAL_BRANDING: '1' }
    expect(releaseSettings({ ATELIER_OFFICIAL_BRANDING: '0' }, 'darwin').bundleId).toBe('dev.summit.browser')
    const s = releaseSettings(OFFICIAL, 'darwin')
    expect(s).toEqual({
      channel: 'dev',
      publicRelease: false,
      updatesEnabled: false,
      supportEmail: '',
      website: '',
      repo: null,
      signing: { platform: 'darwin', identity: null, notarize: null },
      bundleId: 'com.sennechin.atelier',
    })
    expect(appRelease(OFFICIAL, 'darwin').release).toEqual(RELEASE)
  })

  it('round-trips through the defines into RELEASE', () => {
    const env = { ...PUBLISH, ...SIGNED_MAC, ATELIER_SUPPORT_EMAIL: 'help@example.org', ATELIER_WEBSITE: 'https://example.org/atelier' }
    expect(appRelease(env, 'darwin').release).toEqual({
      channel: 'stable',
      publicRelease: false,
      updatesEnabled: true,
      supportEmail: 'help@example.org',
      website: 'https://example.org/atelier',
      repo: { owner: 'someone', name: 'atelier' },
    })
  })

  it('marks a public release, which the build tools see too (tests/internal.test.ts: only the API key engine)', () => {
    expect(appRelease({ ATELIER_PUBLIC_RELEASE: '1' }, 'darwin').release.publicRelease).toBe(true)
    expect(appRelease({ ATELIER_PUBLIC_RELEASE: 'true' }, 'linux').release.publicRelease).toBe(true)
    expect(appRelease({}, 'darwin').release.publicRelease).toBe(false)
    expect(buildEnv(releaseSettings({ ATELIER_PUBLIC_RELEASE: '1' }, 'darwin'), { ATELIER_PUBLIC_RELEASE: '1' }).ATELIER_PUBLIC_RELEASE).toBe('1')
  })

  it('turns updates on only with a publish target, a release channel and a signature', () => {
    expect(releaseSettings({ ...PUBLISH, ...SIGNED_MAC }, 'darwin').updatesEnabled).toBe(true)
    expect(releaseSettings({ ...PUBLISH }, 'darwin').updatesEnabled).toBe(false)
    expect(releaseSettings({ ...SIGNED_MAC, ATELIER_CHANNEL: 'stable' }, 'darwin').updatesEnabled).toBe(false)
    expect(releaseSettings({ ...PUBLISH, ...SIGNED_MAC, ATELIER_CHANNEL: 'dev' }, 'darwin').updatesEnabled).toBe(false)
    expect(releaseSettings({ ...PUBLISH, ...SIGNED_MAC, ATELIER_UPDATES: '0' }, 'darwin').updatesEnabled).toBe(false)
    expect(releaseSettings({ ...PUBLISH, ...AZURE }, 'win32').updatesEnabled).toBe(true)
    expect(releaseSettings({ ...PUBLISH }, 'win32').updatesEnabled).toBe(false)
    // An AppImage updates without code signing.
    expect(releaseSettings({ ...PUBLISH }, 'linux').updatesEnabled).toBe(true)
    expect(releaseSettings({ ...PUBLISH, ATELIER_RELEASE_OWNER: 'bad owner' }, 'linux').repo).toBeNull()
  })

  it('keeps only a plausible email and an https website', () => {
    expect(releaseSettings({ ATELIER_SUPPORT_EMAIL: 'not an email' }, 'darwin').supportEmail).toBe('')
    expect(releaseSettings({ ATELIER_SUPPORT_EMAIL: ' a@b.co ' }, 'darwin').supportEmail).toBe('a@b.co')
    expect(releaseSettings({ ATELIER_WEBSITE: 'http://example.org' }, 'darwin').website).toBe('')
    expect(releaseSettings({ ATELIER_WEBSITE: 'javascript:alert(1)' }, 'darwin').website).toBe('')
    expect(releaseSettings({ ATELIER_WEBSITE: 'https://example.org' }, 'darwin').website).toBe('https://example.org/')
  })

  it('names where signing credentials come from, never the identity', () => {
    expect(releaseSettings({ CSC_NAME: 'Someone (TEAM)' }, 'darwin').signing).toEqual({ platform: 'darwin', identity: 'name', notarize: null })
    expect(releaseSettings(SIGNED_MAC, 'darwin').signing).toEqual({ platform: 'darwin', identity: 'certificate', notarize: 'api-key' })
    expect(releaseSettings({ CSC_LINK: 'x', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 't' }, 'darwin').signing.notarize).toBe('apple-id')
    // Notarization needs a signature first.
    expect(releaseSettings({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }, 'darwin').signing.notarize).toBeNull()
    expect(releaseSettings(AZURE, 'win32').signing.identity).toBe('azure')
    expect(releaseSettings({ ...AZURE, ATELIER_AZURE_PUBLISHER: '' }, 'win32').signing.identity).toBeNull()
    expect(releaseSettings({ WIN_CSC_LINK: 'x' }, 'win32').signing.identity).toBe('certificate')
    expect(releaseSettings(SIGNED_MAC, 'linux').signing.identity).toBeNull()
  })

  it('lays publish and signing over the yml only when env asks', () => {
    expect(builderOverrides(releaseSettings({}, 'darwin'), {})).toEqual({})
    const mac = builderOverrides(releaseSettings({ ...PUBLISH, ...SIGNED_MAC }, 'darwin'), { ...PUBLISH, ...SIGNED_MAC })
    expect(mac).toEqual({ publish: { provider: 'github', owner: 'someone', repo: 'atelier', releaseType: 'draft' }, mac: { identity: '' } })
    expect(builderOverrides(releaseSettings({ CSC_NAME: 'Someone' }, 'darwin'), { CSC_NAME: 'Someone' }).mac).toEqual({ identity: 'Someone' })
    expect(builderOverrides(releaseSettings(AZURE, 'win32'), AZURE).win?.azureSignOptions).toEqual({
      publisherName: 'Publisher',
      endpoint: 'https://weu.codesigning.azure.net',
      codeSigningAccountName: 'account',
      certificateProfileName: 'profile',
    })
  })

  it('never lets electron-builder pick a keychain identity on its own', () => {
    expect(buildEnv(releaseSettings({}, 'darwin'), {}).CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
    expect(buildEnv(releaseSettings(SIGNED_MAC, 'darwin'), SIGNED_MAC).CSC_IDENTITY_AUTO_DISCOVERY).toBeUndefined()
    expect(buildEnv(releaseSettings({}, 'darwin'), { ELECTRON_RUN_AS_NODE: '1' }).ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})

describe('versions and what is new', () => {
  it('checks the version against the channel', () => {
    expect(versionProblem('1.2.0', 'stable')).toBeNull()
    expect(versionProblem('1.2.0-beta.3', 'beta')).toBeNull()
    expect(versionProblem('1.2.0-beta.3', 'stable')).toMatch(/pre-release/)
    expect(versionProblem('1.2.0', 'beta')).toMatch(/beta\.1/)
    expect(versionProblem('1.2.0-rc.1', 'beta')).toMatch(/beta/)
    expect(versionProblem('1.2', 'stable')).toMatch(/x\.y\.z/)
    expect(versionProblem('1.2.0', 'dev')).toMatch(/never released/)
  })

  it('reads whatsNew.ts the way release.mjs does', () => {
    expect(whatsNewVersions(read('src/shared/whatsNew.ts'))).toEqual(WHATS_NEW.map((e) => e.version))
  })

  it('compares versions', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1)
    expect(compareVersions('1.2.0', '1.2.0-beta.1')).toBe(0)
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1)
  })
})

describe('electron-builder.yml', () => {
  const text = read('electron-builder.yml')
  const load = (overrides?: Configuration): Promise<Configuration> => getConfig(REPO, null, overrides ?? null)

  it('passes electron-builder’s own schema, alone and with release overrides', async () => {
    const logger = new DebugLogger(false)
    await validateConfiguration(await load(), logger)
    const env = { ...PUBLISH, ...SIGNED_MAC, ...AZURE }
    await validateConfiguration(await load(builderOverrides(releaseSettings(env, 'darwin'), env) as Configuration), logger)
    await validateConfiguration(await load(builderOverrides(releaseSettings(env, 'win32'), env) as Configuration), logger)
  })

  it('commits no identity, team, email, token or repo', async () => {
    const config = await load()
    expect(config.mac?.identity).toBeNull()
    const settings = text.replace(/(^|\s)#.*$/gm, '') // comments may name the env variables
    expect(settings).not.toMatch(/Developer ID|\([A-Z0-9]{10}\)|@[a-z0-9-]+\.[a-z]|ghp_|token:|owner:|repo:|azureSignOptions|CSC_/i)
    expect(config.publish).toMatchObject({ provider: 'github', releaseType: 'draft' })
    expect(config.publish).not.toHaveProperty('owner')
    for (const f of ['.github/workflows/release.yml', '.github/workflows/ci.yml', 'scripts/release/config.mjs']) {
      expect(read(f)).not.toMatch(/Developer ID Application:|\b[A-Z0-9]{10}\.com\.atelier|ghp_[A-Za-z0-9]/)
    }
  })

  it('signs macOS under the hardened runtime with the entitlements it needs', async () => {
    const mac = (await load()).mac!
    expect(mac.hardenedRuntime).toBe(true)
    expect(mac.gatekeeperAssess).toBe(false)
    const keys = (file: string): string[] => [...read(file).matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]!)
    expect(keys(mac.entitlements as string)).toEqual(expect.arrayContaining(['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera']))
    expect(keys(mac.entitlementsInherit as string)).toEqual(expect.arrayContaining(['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input']))
    for (const key of MAC_USAGE_KEYS) expect((mac.extendInfo as Record<string, string>)[key], key).toMatch(/\w{4,}/)
  })

  it('ships the zip Squirrel.Mac updates from, for both architectures', async () => {
    const targets = (await load()).mac!.target as Array<{ target: string; arch: string[] }>
    for (const t of ['dmg', 'zip']) expect(targets.find((x) => x.target === t)?.arch.sort()).toEqual(['arm64', 'x64'])
  })

  it('has a producer for every extraResources source', async () => {
    const config = await load()
    // Sources built at release time, and the script that writes each one.
    const producers: Record<string, string> = {
      'native/speech/build/atelier-speech': 'scripts/build-speech-helper.mjs',
      'native/speech-win/build/atelier-speech.exe': 'scripts/build-speech-helper.mjs',
      'native/haptics/build/atelier_haptics.node': 'scripts/build-native.mjs',
      'native/calendar/build/atelier-calendar': 'scripts/build-calendar-helper.mjs',
      'native/translate/build/atelier-translate': 'scripts/build-translate-helper.mjs',
      // The on-device decision model, downloaded and checked (docs/decisions.md › On this computer).
      'native/decisions/build': 'scripts/fetch-decision-model.mjs',
    }
    const entries = [config.extraResources, config.mac?.extraResources, config.win?.extraResources, config.linux?.extraResources]
      .flat()
      .filter((e): e is { from: string; to: string } => typeof e === 'object' && e !== null && 'from' in e)
    expect(entries.length).toBeGreaterThan(5)
    for (const { from } of entries) {
      if (existsSync(join(REPO, from)) && !(from in producers)) continue // committed (resources/, build/*.ico)
      const script = producers[from]
      expect(script, `nothing builds ${from}`).toBeDefined()
      // The calendar helper's script may be absent; the entry is skipped then.
      if (script === 'scripts/build-calendar-helper.mjs' && !existsSync(join(REPO, script))) continue
      expect(existsSync(join(REPO, script!)), script).toBe(true)
    }
    expect(read('scripts/build-native.mjs')).toContain("'atelier_haptics.node'")
    expect(read('scripts/build-speech-helper.mjs')).toContain("'atelier-speech'")
  })

  it('compiles the Icon Composer icon after packing and keeps the .icns', async () => {
    const config = await load()
    expect(config.afterPack).toBe('./scripts/release/afterPack.mjs')
    expect(existsSync(join(REPO, 'scripts/release/afterPack.mjs'))).toBe(true)
    expect(config.mac!.icon).toBe('branding/official/icon.icns')
    expect(existsSync(join(REPO, 'branding/official/Atelier.icon/icon.json'))).toBe(true)
    // The official branding compiles its Icon Composer document; the unofficial one has none and keeps icon.icns.
    expect(iconComposer(readBranding('official'))).toEqual({ dir: join(REPO, 'branding/official/Atelier.icon'), name: 'Atelier' })
    expect(iconComposer(readBranding('unofficial'))).toBeNull()
  })

  it('installs per user on Windows and registers Atelier as a browser, cleaned up on uninstall', async () => {
    const config = await load()
    expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, include: 'build/installer.nsh' })
    // GitHub renames assets with spaces, which would break latest.yml's link.
    expect(config.nsis!.artifactName).not.toMatch(/\s/)
    expect((config.win!.target as Array<{ arch: string[] }>)[0]!.arch.sort()).toEqual(['arm64', 'x64'])
    const nsh = read('build/installer.nsh')
    expect(nsh).toContain('$isForceCurrentInstall "1"')
    for (const s of ['StartMenuInternet', 'URLAssociations" "http"', 'URLAssociations" "https"', 'FileAssociations" ".html"', '.ateliercompanion', 'FileAssociations" ".atelierpack"', 'FileAssociations" ".atelierapp"', 'FileAssociations" ".atelierworld"']) expect(nsh).toContain(s)
    // Apps and worlds are packs: the uninstaller takes their keys away too.
    for (const ext of ['.atelierapp', '.atelierworld']) expect(nsh.slice(nsh.indexOf('!macro customUnInstall'))).toContain(`Software\\Classes\\${ext}`)
    const uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'))
    for (const s of ['RegisteredApplications', '${ATELIER_CAPS}', '${ATELIER_HTML}', '${ATELIER_URL}', '${ATELIER_COMPANION}', '${isUpdated}']) expect(uninstall).toContain(s)
    // Windows never takes the .html default; it only adds Atelier to "Open with".
    expect(nsh).not.toMatch(/Classes\\\.html" ""/)
  })

  it('packages Linux as an AppImage and a deb with the desktop entry and depends', async () => {
    const linux = (await load()).linux!
    expect((linux.target as Array<{ target: string }>).map((t) => t.target)).toEqual(['AppImage', 'deb'])
    expect(linux.category).toBe('Network')
    expect(linux.mimeTypes).toContain('text/html')
    expect(linux.fileAssociations).toEqual([expect.objectContaining({ mimeType: 'application/x-ateliercompanion' }), expect.objectContaining({ mimeType: 'application/x-atelierpack' }), expect.objectContaining({ mimeType: 'application/x-atelierapp' }), expect.objectContaining({ mimeType: 'application/x-atelierworld' })])
    expect(linux.desktop).toEqual({ entry: { StartupWMClass: 'Atelier' } })
    // The unofficial branding's window class is its own name.
    expect(brandedConfig({ linux }, readBranding('unofficial')).linux.desktop).toEqual({ entry: { StartupWMClass: 'Summit' } })
    expect((await load()).deb!.depends).toEqual(expect.arrayContaining(['libnotify4', 'libsecret-1-0', 'libayatana-appindicator3-1']))
    expect((await load()).protocols).toEqual([expect.objectContaining({ schemes: ['http', 'https'] })])
  })

  it('keeps the fuses the security model relies on', async () => {
    expect(expectedFuses((await load()).electronFuses as Record<string, unknown>)).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
    })
  })
})

describe('packaged-app checks', () => {
  const want = { RunAsNode: false, OnlyLoadAppFromAsar: true }

  it('compares fuses read by @electron/fuses', () => {
    const ok = fusesFromWire({ version: '1', 0: 48, 5: 49 }, { 0: 'RunAsNode', 5: 'OnlyLoadAppFromAsar' })
    expect(fuseProblems(want, ok)).toEqual([])
    const wire = fusesFromWire({ version: '1', 0: 49, 5: 49 }, { 0: 'RunAsNode', 5: 'OnlyLoadAppFromAsar' })
    expect(fuseProblems(want, wire)).toEqual(['fuse RunAsNode is enabled, electron-builder.yml says disabled'])
    expect(fuseProblems(want, [])).toHaveLength(2)
  })

  it('checks Info.plist for usage strings, schemes, documents and a matching icon', () => {
    const good: Record<string, unknown> = {
      ...Object.fromEntries(MAC_USAGE_KEYS.map((k) => [k, 'Atelier uses this for something you asked.'])),
      CFBundleURLTypes: [{ CFBundleURLSchemes: ['http', 'https'] }],
      CFBundleDocumentTypes: [{ CFBundleTypeExtensions: ['ateliercompanion'] }, { CFBundleTypeExtensions: ['atelierpack'] }, { CFBundleTypeExtensions: ['html', 'htm'] }],
      CFBundleIconFile: 'icon.icns',
      CFBundleIconName: 'Atelier',
    }
    expect(plistProblems(good, { assetCatalog: true })).toEqual([])
    expect(plistProblems(good, { assetCatalog: false })).toEqual(['CFBundleIconName is set without an Assets.car'])
    const { NSCameraUsageDescription: _gone, CFBundleIconName: _name, ...partial } = good
    expect(plistProblems({ ...partial, CFBundleURLTypes: [] }, { assetCatalog: true })).toEqual([
      'Info.plist has no NSCameraUsageDescription',
      "Info.plist doesn't claim the http scheme",
      "Info.plist doesn't claim the https scheme",
      'Assets.car is there but CFBundleIconName is null, not "Atelier"',
    ])
  })

  it('checks each native helper: signed like the app, with its own usage strings', () => {
    const xml = '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.x.speech</string><key>NSMicrophoneUsageDescription</key><string>Atelier listens when you dictate.</string></dict></plist>'
    const hex = [...Buffer.from(xml)].map((b) => b.toString(16).padStart(2, '0'))
    const lines = (at: number): string[] => Array.from({ length: Math.ceil(hex.length / 16) }, (_, i) => `${(at + i * 16).toString(16).padStart(16, '0')}\t${hex.slice(i * 16, i * 16 + 16).join(' ')} `)
    // A universal binary prints the section once per slice.
    expect(infoPlistFromOtool([...lines(0x1000), ...lines(0x2000)].join('\n'))).toBe(xml)
    expect(infoPlistFromOtool('')).toBeNull()
    expect(plistStrings(xml)).toEqual({ CFBundleIdentifier: 'com.x.speech', NSMicrophoneUsageDescription: 'Atelier listens when you dictate.' })

    expect(codesignDetails('CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1\nSignature size=9000\nTeamIdentifier=ABCDE12345\n')).toEqual({ runtime: true, team: 'ABCDE12345', adhoc: false })
    expect(codesignDetails('CodeDirectory v=20400 flags=0x2(adhoc) hashes=1\nSignature=adhoc\nTeamIdentifier=not set\n')).toEqual({ runtime: false, team: null, adhoc: true })

    const speech = MAC_HELPERS.find((h) => h.path === 'atelier-speech')!
    const signed = { runtime: true, team: 'ABCDE12345', adhoc: false }
    const ok = { plist: xml.replace('<key>NSMicrophoneUsageDescription', '<key>NSSpeechRecognitionUsageDescription</key><string>Atelier turns speech into text.</string><key>NSMicrophoneUsageDescription'), bundleId: 'com.x', verify: { ok: true, error: '' }, details: signed, signed: true, appTeam: 'ABCDE12345' }
    expect(helperProblems(speech, ok)).toEqual([])
    expect(helperProblems(speech, { ...ok, plist: xml })).toEqual(["atelier-speech's Info.plist has no NSSpeechRecognitionUsageDescription"])
    expect(helperProblems(speech, { ...ok, bundleId: 'com.y' })).toEqual(["atelier-speech's CFBundleIdentifier is \"com.x.speech\", not com.y.speech"])
    expect(helperProblems(speech, { ...ok, plist: null })).toEqual(["atelier-speech has no embedded Info.plist, so macOS can't say why it asks"])
    expect(helperProblems(speech, { ...ok, verify: { ok: false, error: 'invalid signature' }, details: { runtime: false, team: 'OTHER', adhoc: false } })).toEqual([
      'atelier-speech: codesign --verify failed: invalid signature',
      'atelier-speech is signed without the hardened runtime',
      "atelier-speech is signed by team OTHER, not the app's ABCDE12345",
    ])
    // An ad hoc build only has to verify.
    expect(helperProblems(speech, { ...ok, signed: false, appTeam: null, details: { runtime: false, team: null, adhoc: true } })).toEqual([])

    // The helpers' own Info.plists (embedded at build time) carry what the checks ask for.
    for (const h of MAC_HELPERS) {
      const source = read(`native/${h.helper}/Info.plist`)
      expect(helperProblems(h, { ...ok, plist: source, bundleId: 'com.sennechin.atelier' }), h.path).toEqual([])
    }
    expect(expectedResources('darwin').optional.map((o) => o.path)).toEqual(expect.arrayContaining(['atelier-calendar', 'atelier-translate']))
  })

  it('expects the runtime resources the app reads', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { required } = expectedResources(platform)
      // Each branding's resources/ folder is packaged as resources/ (electron-builder.yml, scripts/branding.mjs).
      for (const id of ['official', 'unofficial']) {
        for (const p of required.filter((r) => r.startsWith('resources/'))) expect(existsSync(join(REPO, 'branding', id, p)), `${id}: ${p}`).toBe(true)
      }
    }
    expect(resolveResourcePath({ packaged: true, resourcesPath: '/A/Resources', appPath: '/x', branding: 'unofficial' }, ['tray', 't.png'])).toBe(join('/A/Resources', 'resources', 'tray', 't.png'))
    expect(resolveResourcePath({ packaged: false, resourcesPath: '/A', appPath: '/repo', branding: 'unofficial' }, ['icons'])).toBe(join('/repo', 'branding', 'unofficial', 'resources', 'icons'))
  })

  it('finds the project folder in dev even when the app path is a build output folder', () => {
    const exists = (p: string): boolean => p === join('/repo', 'package.json')
    // `electron-vite dev --outDir out-dev --entry out-dev/main/index.js` makes the app path <repo>/out-dev/main.
    expect(resolveAppRoot({ packaged: false, appPath: join('/repo', 'out-dev', 'main'), exists })).toBe(join('/repo'))
    expect(resolveAppRoot({ packaged: false, appPath: '/repo', exists })).toBe('/repo')
    expect(resolveAppRoot({ packaged: false, appPath: '/elsewhere/main', exists })).toBe('/elsewhere/main')
    expect(resolveAppRoot({ packaged: true, appPath: '/A/Resources/app.asar', exists })).toBe('/A/Resources/app.asar')
  })

  it('reads the smoke output and requires the public-flag check in a public release', () => {
    const out = `PASS  one\nFAIL  two  — boom\n${'PASS  ' + PUBLIC_FLAG_CHECK}\n\n2/3 smoke checks passed\n`
    const s = smokeSummary(out)
    expect(s).toMatchObject({ failed: ['two'], passed: 2, total: 3 })
    expect(smokeProblems(s, { exitCode: 1, publicRelease: false })).toEqual(['failed checks: two'])
    const clean = smokeSummary('PASS  one\n\n1/1 smoke checks passed\n')
    expect(smokeProblems(clean, { exitCode: 0, publicRelease: false })).toEqual([])
    expect(smokeProblems(clean, { exitCode: 0, publicRelease: true })).toEqual([`a public release needs "${PUBLIC_FLAG_CHECK}" to pass`])
    expect(smokeProblems(smokeSummary(''), { exitCode: null, publicRelease: false })[0]).toMatch(/no smoke summary/)
  })

  it('names the public-flag check the way the maintenance smoke group registers it', () => {
    const name = /PUBLIC_FLAG_CHECK = '([^']+)'/.exec(read('src/main/smokeMaintenance/release.ts'))?.[1]
    expect(`MAINTENANCE: ${name}`).toBe(PUBLIC_FLAG_CHECK)
    expect(read('src/main/smokeMaintenance/index.ts')).toMatch(/import \* as release from '\.\/release'/)
  })
})

describe('release assets', () => {
  it('writes SHA256SUMS in sha256sum format', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(checksumLines([{ name: 'Atelier-1.0.0.zip', sha256: b }, { name: 'Atelier-1.0.0.dmg', sha256: a }])).toBe(`${a}  Atelier-1.0.0.dmg\n${b}  Atelier-1.0.0.zip\n`)
    expect(() => checksumLines([{ name: 'x', sha256: 'nope' }])).toThrow(/bad sha256/)
    expect(() => checksumLines([{ name: 'x\ny', sha256: a }])).toThrow(/bad file name/)
  })

  it('builds the support feed the update machine reads', () => {
    expect(supportFeed([])).toEqual({ schema: 1, unsupported: [] })
    expect(supportFeed([{ below: '0.2.0' }, { below: '0.10.0', message: ' Update, please. ' }, { below: '0.2.0', message: '' }])).toEqual({
      schema: 1,
      unsupported: [{ below: '0.10.0', message: 'Update, please.' }, { below: '0.2.0' }],
    })
    expect(() => supportFeed([{ below: '1.0' }])).toThrow(/x\.y\.z/)
    expect(() => supportFeed([{ below: '1.0.0', message: 'x'.repeat(281) }])).toThrow(/280/)
    const committed = JSON.parse(read('scripts/release/support.json')) as { unsupported: Array<{ below: string }> }
    expect(supportFeed(committed.unsupported).schema).toBe(1)
  })
})

describe('the licence list', () => {
  const temp = (): string => mkdtempSync(join(tmpdir(), 'atelier-licences-'))
  const put = (dir: string, json: Record<string, unknown>, licence?: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
    if (licence) writeFileSync(join(dir, 'LICENSE'), licence)
  }

  it('ships the lock’s installed production tree, plus the bundled extras', () => {
    const root = temp()
    put(root, { name: 'app', dependencies: { alpha: '1' } })
    put(join(root, 'node_modules/alpha'), { name: 'alpha', version: '1.0.0', license: 'MIT' }, 'MIT text')
    put(join(root, 'node_modules/alpha/node_modules/beta'), { name: 'beta', version: '2.0.0', license: 'ISC' })
    put(join(root, 'node_modules/tool'), { name: 'tool', version: '1.0.0', license: 'MIT' })
    put(join(root, 'node_modules/react'), { name: 'react', version: '19.0.0', license: 'MIT' })
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/alpha': { version: '1.0.0' },
        'node_modules/alpha/node_modules/beta': { version: '2.0.0' },
        'node_modules/tool': { version: '1.0.0', dev: true },
        'node_modules/react': { version: '19.0.0', dev: true },
        'node_modules/linked': { link: true, resolved: '../linked' },
        // An optional package for another platform: in the lock, not installed.
        'node_modules/@x/canvas-win32': { version: '1.0.0', optional: true },
      },
    }
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock))
    expect(productionPackages(lock).map((p) => p.name)).toEqual(['@x/canvas-win32', 'alpha', 'beta'])
    expect(productionPackages(lock, root).map((p) => `${p.name}@${p.version}`)).toEqual(['alpha@1.0.0', 'beta@2.0.0'])
    const list = collectLicenses(root, { extra: ['react'], native: [], models: [] })
    expect(list.map((e) => `${e.name}:${e.license}`)).toEqual(['alpha:MIT', 'beta:ISC', 'react:MIT'])
    // Atelier's own decision models are listed by default, each with what it is built from.
    const withModels = collectLicenses(root, { extra: ['react'], native: [] })
    expect(withModels.filter((e) => MODEL_LICENSES.some((m) => m.name === e.name)).map((e) => e.license)).toEqual(['Apache-2.0', 'Apache-2.0', 'Apache-2.0'])
    expect(MODEL_LICENSES.find((m) => m.name.startsWith('atelier-nano'))?.text).toMatch(/mmBERT-small.*MIT License/s)
    expect(list[0]!.text).toBe('MIT text')
    // The native helpers' packages are added as they are, in name order.
    const withNative = collectLicenses(root, { extra: ['react'], native: [{ name: 'Native.Lib', version: '1.0.0', license: 'MIT', text: 'native text' }], models: [] })
    expect(withNative.map((e) => e.name)).toEqual(['alpha', 'beta', 'Native.Lib', 'react'])
  })

  it('lists what the native helpers compile in, at the versions they build with', () => {
    const listed = new Map(NATIVE_PACKAGES.map((e) => [e.name, e]))
    for (const entry of NATIVE_PACKAGES) {
      expect(licenseVerdict(entry.license), entry.name).toBe('ok')
      expect(entry.text, entry.name).toMatch(/Permission is hereby granted/)
    }
    // Every NuGet package the Windows speech helper references (NAudio.Wasapi brings NAudio.Core), and the .NET runtime it bundles.
    const csproj = read('native/speech-win/AtelierSpeech.csproj')
    const references = [...csproj.matchAll(/<PackageReference Include="([^"]+)" Version="([^"]+)"/g)].map((m) => [m[1]!, m[2]!] as const)
    expect(references.length).toBeGreaterThan(0)
    for (const [name, version] of references) expect(listed.get(name)?.version, name).toBe(version)
    expect(listed.get('NAudio.Core')?.version).toBe(listed.get('NAudio.Wasapi')?.version)
    expect(csproj).toMatch(/<SelfContained>true<\/SelfContained>/)
    expect(listed.has('.NET Runtime')).toBe(true)
    // The haptics addon compiles node-addon-api's headers in.
    const haptics = JSON.parse(read('native/haptics/package.json')) as { devDependencies: Record<string, string> }
    expect(listed.get('node-addon-api')?.version).toBe(haptics.devDependencies['node-addon-api'])
    // And the committed list carries them, so About shows them.
    const committed = JSON.parse(read('src/renderer/public/licenses.json')) as LicenseEntry[]
    for (const entry of NATIVE_PACKAGES) expect(committed.some((e) => e.name === entry.name && e.version === entry.version), entry.name).toBe(true)
  })

  it('lists the companion art under its own licence, with its text, beside the MPL code', () => {
    const own = ownLicenses(REPO)
    expect(own).toEqual([{ name: 'Atelier Companion Art', version: '1.1', license: 'LicenseRef-Atelier-Companion-Art', text: read('ART-LICENSE.md') }])
    expect(licenseVerdict(own[0]!.license)).toBe('ok')
    // A checkout without ART-LICENSE.md (a fork with art of its own) lists none.
    expect(ownLicenses(join(REPO, 'tests'))).toEqual([])
    const committed = JSON.parse(read('src/renderer/public/licenses.json')) as LicenseEntry[]
    expect(committed.find((e) => e.name === 'Atelier Companion Art')).toEqual(own[0])
    const pkg = JSON.parse(read('package.json')) as { license: string }
    expect(pkg.license).toBe('MPL-2.0 AND LicenseRef-Atelier-Companion-Art')
  })

  it('refuses copyleft and patron licences, and flags undeclared ones', () => {
    for (const ok of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'MS-PL', 'MPL-2.0', 'OFL-1.1', '(MIT OR GPL-3.0)', 'MIT AND Zlib']) expect(licenseVerdict(ok), ok).toBe('ok')
    for (const no of ['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1', 'SSPL-1.0', 'MIT AND GPL-2.0', '(GPL-2.0 OR AGPL-3.0)']) expect(licenseVerdict(no), no).toBe('denied')
    for (const unk of ['UNKNOWN', '', 'SEE LICENSE IN LICENSE.md', 'GPL-3.0 OR UNKNOWN']) expect(licenseVerdict(unk), unk).toBe('unknown')
    const entry = (name: string, license: string, text = 'text') => ({ name, version: '1.0.0', license, text })
    const { errors, warnings } = licenseListProblems(
      [entry('a', 'MIT'), entry('b', 'GPL-3.0'), entry('c', 'UNKNOWN'), entry('d', 'ISC', ''), { name: 'e' }],
      [{ name: 'a', version: '1.0.0' }, { name: 'f', version: '2.0.0' }],
    )
    expect(errors).toEqual([
      "b@1.0.0 is GPL-3.0, which Atelier can't ship",
      expect.stringMatching(/^licenses.json has a malformed entry/),
      'licenses.json leaves out f@2.0.0',
    ])
    expect(warnings).toEqual(['c@1.0.0 declares no licence; check it by hand', 'd@1.0.0 (ISC) ships no licence text'])
    expect(licenseListProblems({}, []).errors).toEqual(['licenses.json is not an array'])
  })

  it('commits a licences.json of the shape About reads, with nothing it can’t ship', () => {
    const list = JSON.parse(read('src/renderer/public/licenses.json')) as unknown
    // Optional packages differ per platform (the release regenerates the list on each), so they're left out here.
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { optional?: boolean }> }
    const required = { packages: Object.fromEntries(Object.entries(lock.packages).filter(([, e]) => !e.optional)) }
    const shipped = productionPackages(required, REPO)
    expect(licenseListProblems(list, []).errors).toEqual([])
    const entries = list as Array<{ name: string; version: string }>
    const ids = entries.map((e) => `${e.name}@${e.version}`)
    expect(new Set(ids).size).toBe(ids.length)
    expect(entries.map((e) => e.name)).toEqual([...entries.map((e) => e.name)].sort((a, b) => a.localeCompare(b)))
    for (const name of ['electron', 'react', 'react-dom', 'zod']) expect(entries.some((e) => e.name === name), name).toBe(true)
    // Every production package that installs everywhere is listed.
    expect(licenseListProblems(list, shipped).errors).toEqual([])
  })
})

describe('publishing', () => {
  it('releases and publishes only the official branding', () => {
    expect(releaseBrandingProblem({ ATELIER_OFFICIAL_BRANDING: '1' })).toBeNull()
    expect(releaseBrandingProblem({ ATELIER_OFFICIAL_BRANDING: '0' })).toMatch(/official branding only.*Summit.*ATELIER_OFFICIAL_BRANDING=1/)
    // Unset, it resolves the way the build does: without the internal folder, unofficial.
    expect(releaseBrandingProblem({ ATELIER_INTERNAL: '0' })).toMatch(/official branding only/)
    expect(releaseBrandingProblem({ ATELIER_OFFICIAL_BRANDING: 'yes' })).toMatch(/ATELIER_OFFICIAL_BRANDING is "yes"/)
    // release.mjs asks first, before anything else in its preflight (a release and every publish; --package-only skips the preflight).
    const source = readFileSync(join(REPO, 'scripts/release/release.mjs'), 'utf8')
    const preflight = source.slice(source.indexOf('function preflight('), source.indexOf('function describe('))
    expect(preflight.indexOf('releaseBrandingProblem(env)')).toBeGreaterThan(0)
    expect(preflight.indexOf('releaseBrandingProblem(env)')).toBeLessThan(preflight.indexOf('versionProblem('))
  })

  it('runs the release workflow only in the official repository, official there and unofficial anywhere else', () => {
    const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }
    const workflow = yaml.load(readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8')) as {
      env: Record<string, string>
      jobs: Record<string, { if?: string }>
    }
    expect(workflow.env.ATELIER_OFFICIAL_BRANDING).toBe("${{ github.repository == '3SENN/atelier' && '1' || '0' }}")
    expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0)
    for (const [name, job] of Object.entries(workflow.jobs)) expect(job.if, name).toBe("github.repository == '3SENN/atelier'")
  })

  it('uploads installers, blockmaps and update feeds, never names GitHub would rename', () => {
    const dist = ['Atelier-1.0.0-arm64.dmg', 'Atelier-1.0.0-arm64.dmg.blockmap', 'Atelier-1.0.0-arm64-mac.zip', 'latest-mac.yml', 'beta-mac.yml', 'latest.yml', 'latest-linux.yml', 'Atelier-Setup-1.0.0.exe', 'Atelier-1.0.0.AppImage', 'atelierbrowser_1.0.0_amd64.deb', 'builder-debug.yml', 'builder-effective-config.yaml', 'SHA256SUMS', 'atelier-support.json', 'mac-arm64']
    expect(uploadsFrom(dist)).toEqual(['Atelier-1.0.0-arm64-mac.zip', 'Atelier-1.0.0-arm64.dmg', 'Atelier-1.0.0-arm64.dmg.blockmap', 'Atelier-1.0.0.AppImage', 'Atelier-Setup-1.0.0.exe', 'atelierbrowser_1.0.0_amd64.deb', 'beta-mac.yml', 'latest-linux.yml', 'latest-mac.yml', 'latest.yml'])
    expect(() => uploadsFrom(['Atelier Setup 1.0.0.exe'])).toThrow(/spaces/)
  })

  it('takes only this version’s files from a dist/ that still has earlier builds', () => {
    const dist = ['Atelier-1.1.2.dmg', 'Atelier-1.1.2-arm64.dmg', 'Atelier-1.2.1.dmg', 'Atelier-1.2.1-arm64.dmg', 'Atelier-1.2.1-arm64.dmg.blockmap', 'Atelier-1.2.1-arm64-mac.zip', 'Atelier-1.2.10-arm64.dmg', 'Atelier-1.2.1-beta.1-arm64.dmg', 'Atelier-Setup-1.2.1.exe', 'atelierbrowser_1.2.1_amd64.deb', 'latest-mac.yml', 'mac-arm64']
    expect(ofVersion(dist, '1.2.1')).toEqual(['Atelier-1.2.1.dmg', 'Atelier-1.2.1-arm64.dmg', 'Atelier-1.2.1-arm64.dmg.blockmap', 'Atelier-1.2.1-arm64-mac.zip', 'Atelier-Setup-1.2.1.exe', 'atelierbrowser_1.2.1_amd64.deb', 'latest-mac.yml', 'mac-arm64'])
    expect(ofVersion(dist, '1.2.1-beta.1')).toEqual(['Atelier-1.2.1-beta.1-arm64.dmg', 'latest-mac.yml', 'mac-arm64'])
  })

  it('rewrites a stapled dmg’s hash in the macOS feed and leaves the zip alone', () => {
    const yml = [
      'version: 1.0.0',
      'files:',
      '  - url: Atelier-1.0.0-arm64-mac.zip',
      '    sha512: ZIP==',
      '    size: 10',
      '  - url: Atelier-1.0.0-arm64.dmg',
      '    sha512: OLD==',
      '    size: 20',
      'path: Atelier-1.0.0-arm64-mac.zip',
      'sha512: ZIP==',
      "releaseDate: '2026-10-29T00:00:00.000Z'",
      '',
    ].join('\n')
    const out = refreshFeed(yml, [{ name: 'Atelier-1.0.0-arm64.dmg', sha512: 'NEW==', size: 21 }])
    expect(out).toBe(yml.replace('OLD==', 'NEW==').replace('size: 20', 'size: 21'))
    expect(refreshFeed(yml, [{ name: 'Atelier-1.0.0-arm64-mac.zip', sha512: 'Z2==', size: 11 }]).match(/Z2==/g)).toHaveLength(2)
  })

  it('verifies every arch electron-builder built, this machine’s first', () => {
    const dist = mkdtempSync(join(tmpdir(), 'atelier-dist-'))
    // Named after the branding the build uses (Atelier.app, or Summit.app).
    const name = loadBranding().name
    for (const dir of ['mac', 'mac-arm64']) mkdirSync(join(dist, dir, `${name}.app`), { recursive: true })
    expect(packagedApps({ dist, platform: 'darwin', arch: 'arm64' }).map((a) => a.arch)).toEqual(['arm64', 'x64'])
    expect(packagedApps({ dist, platform: 'darwin', arch: 'x64' })[0]!.executable).toBe(join(dist, 'mac', `${name}.app`, 'Contents', 'MacOS', name))
    expect(packagedApps({ dist, platform: 'darwin', arch: 'x64', productName: name === 'Atelier' ? 'Summit' : 'Atelier' })).toEqual([])
    expect(packagedApps({ dist, platform: 'win32', arch: 'x64' })).toEqual([])
  })
})

describe('releases with an update feed', () => {
  it('must be public releases, so private engines never reach other people', () => {
    const repo = { owner: 'example', name: 'browser' }
    expect(releaseFeedProblem({ repo, publicRelease: false })).toMatch(/ATELIER_PUBLIC_RELEASE=1/)
    expect(releaseFeedProblem({ repo, publicRelease: true })).toBeNull()
    expect(releaseFeedProblem({ repo: null, publicRelease: false })).toBeNull()
  })
})
