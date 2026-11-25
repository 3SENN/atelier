/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reset Atelier (ST-55) restarts into setup, so the setup flow's own files
// (setup.json, profile.json and the given extras) go too, and the stores
// that hold them in memory never write the old state back.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyProfile } from '@shared/userProfile'
import { SETUP_FILE, SetupStore, setupResetStep } from '../src/main/onboarding'
import { registerResetStep, runResetSteps } from '../src/main/reset'
import { PROFILE_FILE, UserProfileStore } from '../src/main/userProfile'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const off of cleanups.splice(0)) off()
})

function setUp(): { dir: string; setup: SetupStore; profile: UserProfileStore } {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-reset-setup-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const setup = new SetupStore({ dataDir: dir })
  setup.save({ answers: { work: 'I run a small bakery' } })
  setup.finish()
  const profile = new UserProfileStore(dir)
  profile.set({ ...emptyProfile(1), name: 'Sam', work: 'I run a small bakery' })
  writeFileSync(join(dir, 'guidance.json'), '{"version":1,"dismissedTips":["a"],"dismissedNudges":[]}\n')
  cleanups.push(registerResetStep(setupResetStep({ dataDir: dir, setup, profile, files: ['guidance.json', 'dock-icon.json'] }, 'Setup')))
  return { dir, setup, profile }
}

describe('Reset and the setup flow (ST-55)', () => {
  it('lists setup.json, profile.json and the extras on a dry run without touching them', async () => {
    const { dir, setup, profile } = setUp()
    // dock-icon.json was never written, so it isn't listed.
    expect((await runResetSteps({ secrets: false, dryRun: true })).removed).toEqual([SETUP_FILE, PROFILE_FILE, 'guidance.json'])
    for (const name of [SETUP_FILE, PROFILE_FILE, 'guidance.json']) expect(existsSync(join(dir, name))).toBe(true)
    expect(setup.state().finishedAt).not.toBeNull()
    expect(profile.get()?.name).toBe('Sam')
  })

  it('deletes them and forgets them in memory, so nothing writes them back', async () => {
    const { dir, setup, profile } = setUp()
    expect((await runResetSteps({ secrets: false, dryRun: false })).removed).toEqual([SETUP_FILE, PROFILE_FILE, 'guidance.json'])
    for (const name of [SETUP_FILE, PROFILE_FILE, 'guidance.json']) expect(existsSync(join(dir, name))).toBe(false)
    expect(setup.state()).toMatchObject({ step: 'intro', answers: {}, finishedAt: null, skipped: false })
    expect(profile.get()).toBeNull()
    // A save after Reset starts from the fresh state, never the old progress.
    setup.goTo('name')
    expect(JSON.parse(readFileSync(join(dir, SETUP_FILE), 'utf8'))).toMatchObject({ step: 'name', answers: {}, finishedAt: null })
    // After the restart the stores read nothing back.
    expect(new UserProfileStore(dir).get()).toBeNull()
    expect(new SetupStore({ dataDir: dir }).state().finishedAt).toBeNull()
  })
})
