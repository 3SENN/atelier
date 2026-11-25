/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The guides feature module (`firstRun` in FEATURES): the setup flow,
// conversation import, guides, help, tips and nudges, the Dock icon
// designer and companion preset extras. Without an app context (contract
// tests) every method is the "Not available yet" stub.
import { readFileSync } from 'node:fs'
import { BrowserWindow, dialog, shell } from 'electron'
import type { CompanionsSetupMethods, OnboardingMethods } from '@shared/onboarding'
import type { FirstRunServices } from '@shared/tips'
import { setCommandFailureCue } from '../commands'
import { createConversationsService } from '../conversationImport/service'
import { stubMethods } from '../serviceKit'
import { DOCK_DESIGN_FILE, createDockIconService } from '../dockIcon'
import type { AppContext, Feature } from '../features/types'
import { GUIDANCE_FILE, createGuidanceService } from '../guidance'
import { createHelpService, registerHelpMenus } from '../help'
import { SetupStore, createOnboardingService, setupResetStep } from '../onboarding'
import { registerResetStep } from '../reset'
import { UserProfileStore } from '../userProfile'
import { PRESET_BASES_FILE, createPresetMethods } from './presets'
import { createGuidesService } from './service'
import { mainLanguage, mainT } from '../i18n/mainT'

type F = FirstRunServices

function stubs(): ReturnType<NonNullable<Feature['app']>> {
  return {
    onboarding: stubMethods<OnboardingMethods>(['state', 'save', 'goTo', 'skipRest', 'restart', 'launch', 'stepTimeout']),
    companions: stubMethods<CompanionsSetupMethods>(['presetDetail', 'presetDiff', 'applyPresetUpdate']),
    conversations: stubMethods<F['conversations']>(['pick', 'start', 'job', 'continueFrom']),
    guides: stubMethods<F['guides']>(['list', 'get', 'tryIt', 'forUseCases']),
    help: stubMethods<F['help']>(['topics', 'ask']),
    guidance: stubMethods<F['guidance']>(['state', 'dismissTip', 'dismissNudge']),
    dockIcon: stubMethods<F['dockIcon']>(['design', 'save', 'reset', 'apply']),
  }
}

async function pickExportFiles(): Promise<string[] | null> {
  const parent = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: mainT('firstRun.mainFeature.chooseConversationExports'),
    message: mainT('firstRun.mainFeature.chooseAConversationsJson'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: mainT('firstRun.mainFeature.conversationExports'), extensions: ['json', 'zip', 'md'] }],
  }
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  return picked.canceled ? null : picked.filePaths
}

export function createFirstRunFeatures(): Feature {
  const offs: Array<() => void> = []
  return {
    name: 'firstRun',
    app(ctx: AppContext) {
      if (!ctx?.agent || !ctx.dataDir) return stubs()
      const deps = ctx.firstRunDeps
      const activeCompanionId = (): string | undefined => deps?.companions.activeId() ?? ctx.skillRoutines?.companions.get().id

      const store = new SetupStore({ dataDir: ctx.dataDir, onChange: (state) => ctx.broadcast({ type: 'onboarding', state }) })
      const profileStore = new UserProfileStore(ctx.dataDir)
      // Reset Atelier (ST-55) restarts into setup, so setup's own files go too.
      offs.push(registerResetStep(setupResetStep({ dataDir: ctx.dataDir, setup: store, profile: profileStore, files: [GUIDANCE_FILE, DOCK_DESIGN_FILE, PRESET_BASES_FILE] }, mainT('firstRun.reset.step'))))
      const onboarding = createOnboardingService({
        store,
        host: ctx.agent,
        activeCompanionId: () => activeCompanionId() ?? '',
        companionExists: (id) => (deps ? deps.companions.find(id) !== undefined : ctx.agent.companionName(id) !== null),
        // ON-18: your profile, the setup conversation and the workspace it asks for.
        profile: {
          store: profileStore,
          quick: ctx.quick,
          companionName: (id) => deps?.companions.find(id)?.name ?? ctx.agent.companionName(id),
          language: () => (mainLanguage().language === 'nl' ? 'nl' : 'en'),
          skills: () => ctx.skillRoutines?.skills.builtinNames() ?? [],
          directory: () => deps?.directory?.() ?? [],
          destinations: () => ctx.settings.get().sidebar.destinations,
          // Your name lives in Settings › You only; the profile never keeps a second copy.
          userName: () => ctx.settings.get().userName,
          setUserName: (userName) => void ctx.settings.update({ userName }),
          setDestinations: (destinations) => void ctx.settings.update({ sidebar: { destinations } }),
          saveRoutine: (draft) => {
            if (!ctx.skillRoutines) throw new Error('Routines aren’t available yet.')
            // A plan names its skill (weekly-review); a routine keeps the skill's id.
            const { skillId: skillName, ...rest } = draft
            const skill = skillName ? ctx.skillRoutines.skills.byName(skillName) : undefined
            return ctx.skillRoutines.routines.save({ ...rest, ...(skill ? { skillId: skill.id } : {}), enabled: true, ...(draft.companionId ? { owner: draft.companionId } : {}) })
          },
          timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
          writeMemory: (path, text) => deps?.writeMemory?.(path, text),
        },
      })

      // dispose is ours to call on quit, not a method the renderer can reach.
      const { dispose: disposeConversations, ...conversations } = createConversationsService({
        chats: ctx.maintenance.chats,
        host: ctx.agent,
        pickFiles: pickExportFiles,
        broadcast: (event) => ctx.broadcast(event),
        ...(deps?.startMemoryBuild ? { startMemoryBuild: deps.startMemoryBuild } : {}),
      })
      offs.push(disposeConversations)

      const rt = ctx.skillRoutines
      const guides = createGuidesService({
        skills: { byName: (name) => rt?.skills.byName(name) },
        routines: {
          list: () => rt?.routines.list() ?? [],
          save: (input) => {
            if (!rt) throw new Error('Routines aren’t available yet.')
            return rt.routines.save(input)
          },
        },
        host: ctx.agent,
        activeCompanionId: () => activeCompanionId() ?? '',
        ...(deps?.directoryIds ? { directoryIds: deps.directoryIds } : {}),
      })

      const help = createHelpService({ host: ctx.agent, activeCompanionId: () => activeCompanionId() ?? '' })
      offs.push(registerHelpMenus((topic) => void help.ask(topic)))

      const guidance = createGuidanceService({ dataDir: ctx.dataDir, onChange: (state) => ctx.broadcast({ type: 'guidance', state }) })
      const dockIcon = createDockIconService({ dataDir: ctx.dataDir })

      // NS-04: a menu command that fails plays the system beep.
      offs.push(setCommandFailureCue(() => shell.beep()))

      const companions: CompanionsSetupMethods = deps
        ? createPresetMethods({
            dataDir: ctx.dataDir,
            companions: deps.companions,
            presets: deps.presets,
            presetsRaw: deps.presetsRaw ?? (() => undefined),
          })
        : stubMethods<CompanionsSetupMethods>(['presetDetail', 'presetDiff', 'applyPresetUpdate'])

      return { onboarding, companions, conversations, guides, help, guidance, dockIcon }
    },
    dispose() {
      for (const off of offs.splice(0)) off()
    },
  }
}

/** Reads a JSON file, or undefined (start-up's presetsRaw: () => readJsonFile(presetsPath())). */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
