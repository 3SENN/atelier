/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app as electronApp, net, safeStorage, shell, utilityProcess } from 'electron'
import { PROVIDER_DEFAULTS, type DecisionQuestion, type DecisionsServices } from '@shared/decisions'
import { looksLikeAddress } from '@shared/url'
import type { Feature } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { registerResetStep } from '../reset'
import { appRoot } from '../resources'
import { registerStorageCategory } from '../storage'
import type { FetchLike } from './client'
import { DeviceDecisions, deviceModelDir, deviceStepDir, setDeviceSteps } from './device'
import { MINI_MANIFEST } from './device/miniManifest'
import { STEP_MANIFEST } from './device/stepManifest'
import { MiniInstaller } from './deviceMini'
import { DecisionKeys, KEYS_FILE } from './keys'
import { COMPARISONS_FILE, Decisions, setDecider } from './service'
import { registerLabelItems } from './tool'
import { searchOrAsk } from './uses'

// Quick decisions, main side (DC-01 to DC-12, docs/decisions.md): builds the
// decider from Settings › Quick decisions and the saved keys, makes it the
// app's decider, and answers the settings page. Smoke never reaches the
// network: a stand-in model answers there, sure of its first option.

/** Smoke's stand-in model: yes at 0.9, the first option at 0.9, the lowest level at 0.9. */
export const smokeFetch: FetchLike = async (_url, init) => {
  if (init.method === 'GET') {
    const list = {
      data: [{ id: 'kev-latest' }, { id: 'kev-0.8b' }, { id: 'a-chat-model' }],
    }
    return {
      status: 200,
      ok: true,
      json: async () => list,
      text: async () => JSON.stringify(list),
    }
  }
  const body = JSON.parse(init.body ?? '{}') as {
    questions:
      | Record<string, DecisionQuestion>
      | Array<{
          type: string
          name: string
          choices?: Array<{ value: string }>
          levels?: unknown[]
        }>
    model: string
  }
  const { model } = body
  // OpenAI's Decisions request (DC-19): the same sure first option, in its shape.
  if (Array.isArray(body.questions)) {
    const list = body.questions.map((q) => {
      if (q.type === 'predicate') return { type: 'predicate', name: q.name, probability: 0.9 }
      const values = q.type === 'choice' ? (q.choices ?? []).map((c) => c.value) : (q.levels ?? []).map((_, i) => i)
      const probabilities = values.map((value, i) => ({
        value,
        probability: i === 0 ? 0.9 : 0.1 / (values.length - 1),
      }))
      return q.type === 'choice'
        ? {
            type: 'choice',
            name: q.name,
            choice: values[0],
            confidence: 0.9,
            probabilities,
          }
        : {
            type: 'score',
            name: q.name,
            score: 0.1,
            confidence: 0.9,
            probabilities,
          }
    })
    const reply = {
      model: model || 'smoke-model',
      answers: list,
      usage: { input_tokens: 10, output_tokens: 0 },
    }
    return {
      status: 200,
      ok: true,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    }
  }
  const { questions } = body
  const answers = Object.fromEntries(
    Object.entries(questions).map(([key, q]) => {
      if (q.type === 'noul') return [key, { type: 'noul', noul: 0.9 }]
      const options = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
      const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (options.length - 1)]))
      return [
        key,
        q.type === 'choice'
          ? {
              type: 'choice',
              choice: options[0],
              confidence: 0.9,
              probabilities,
            }
          : {
              type: 'score',
              score: 0.1,
              confidence: 0.9,
              probabilities,
              legend: {},
            },
      ]
    }),
  )
  const reply = {
    model: model || 'smoke-model',
    answers,
    usage: { input_tokens: 10, output_tokens: 0 },
  }
  return {
    status: 200,
    ok: true,
    json: async () => reply,
    text: async () => JSON.stringify(reply),
  }
}

const electronFetch: FetchLike = async (url, init) => {
  const res = await net.fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal,
  })
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    json: () => res.json(),
    text: () => res.text(),
  }
}

export function createDecisionsFeature(): Feature {
  const stops: (() => void)[] = []
  let decider: Decisions | null = null

  /** The new tab's search-or-ask question; addresses never ask (the decider reuses an answer for a minute per text). */
  const searchOrAskOnce = (text: string, current: 'search' | 'ask'): Promise<'search' | 'ask'> => {
    const query = text.trim()
    if (!decider?.active('searchOrAsk') || looksLikeAddress(query)) return Promise.resolve(current)
    return searchOrAsk(query, current)
  }

  return {
    name: 'decisions',
    app(app) {
      const keys = new DecisionKeys(app.dataDir, {
        available: () => (app.smoke ? true : safeStorage.isEncryptionAvailable()),
        seal: (text) => (app.smoke ? Buffer.from(text, 'utf8') : safeStorage.encryptString(text)),
        open: (data) => (app.smoke ? data.toString('utf8') : safeStorage.decryptString(data)),
      })
      // Atelier's own decision model, in a utility process that starts on the first question (device.ts).
      // Its larger half, atelier-mini, is an optional download (deviceMini.ts); ATELIER_DECISION_MINI uses a folder as it is.
      // atelier-step, the model for browser tasks (docs/decisions.md › Browser tasks), is another optional download that
      // runs in the same helper; ATELIER_STEP_MODEL uses a folder as it is (in smoke runs too, so the tool can be checked).
      let mini: MiniInstaller | null = null
      let stepInstaller: MiniInstaller | null = null
      const device = new DeviceDecisions({
        modelDir: () => (app.smoke ? null : deviceModelDir({ packaged: electronApp.isPackaged, resourcesPath: process.resourcesPath, appPath: appRoot() })),
        miniDir: () => (app.smoke ? null : (mini?.dir() ?? null)),
        stepDir: () => stepInstaller?.dir() ?? null,
        spawner: (dir, miniDir, stepDir) =>
          utilityProcess.fork(join(__dirname, 'decisionsDevice.js'), [dir, miniDir ?? '', stepDir ?? ''], { serviceName: 'Atelier quick decisions', stdio: 'ignore' }),
      })
      const installer = new MiniInstaller({
        dir: process.env.ATELIER_DECISION_MINI || join(app.dataDir, 'decision-model-mini'),
        manifest: MINI_MANIFEST,
        external: Boolean(process.env.ATELIER_DECISION_MINI),
        base: process.env.ATELIER_DECISION_MINI_URL,
        // net.fetch: the system's proxy settings, like Atelier's other downloads.
        download: async (url, init) => {
          const res = await net.fetch(url, { signal: init.signal, headers: init.headers })
          return { status: res.status, body: res.body as AsyncIterable<Uint8Array> | null }
        },
        release: () => device.restart(),
      })
      mini = installer
      const stepFolder = process.env.ATELIER_STEP_MODEL
      const steps = new MiniInstaller({
        dir: stepFolder || join(app.dataDir, 'decision-model-step'),
        manifest: STEP_MANIFEST,
        needsServer: false,
        installed: deviceStepDir,
        external: Boolean(stepFolder) || app.smoke,
        download: async (url, init) => {
          const res = await net.fetch(url, { signal: init.signal, headers: init.headers })
          return { status: res.status, body: res.body as AsyncIterable<Uint8Array> | null }
        },
        release: () => device.restart(),
      })
      stepInstaller = steps
      setDeviceSteps(device)
      stops.push(() => {
        installer.cancel()
        steps.cancel()
        setDeviceSteps(null)
        device.dispose()
      })
      const d = new Decisions({
        dataDir: app.dataDir,
        settings: () => app.settings.get().decisions,
        keys,
        // atelier-device:// is answered on this computer (device.ts), everything else over the network.
        fetch: app.smoke ? smokeFetch : device.route(electronFetch),
        quick: () => app.quick ?? null,
        device,
        mini: installer,
        step: steps,
      })
      decider = d
      setDecider(d)
      // With the on-device model among your models, it loads in the background once Atelier has started.
      const warm = setTimeout(() => {
        const s = app.settings.get().decisions
        if (s.on && s.models.some((m) => PROVIDER_DEFAULTS[m.provider as keyof typeof PROVIDER_DEFAULTS]?.keyUrl === '')) device.warm()
      }, 10_000)
      warm.unref?.()
      stops.push(() => clearTimeout(warm))
      registerLabelItems()
      // A key never outlives its server: one left by a server removed while a save failed goes now.
      try {
        keys.retainServers(new Set(app.settings.get().decisions.servers.map((s) => s.id)))
      } catch {
        // Secure storage unavailable: nothing to tidy.
      }
      stops.push(
        // Reset Atelier: the comparisons go with the settings, the keys with the other secrets.
        registerResetStep({
          id: 'decision-comparisons',
          order: 91,
          label: mainT('decisions.storage'),
          run: async ({ dryRun }) => {
            const had = d.comparisonsBytes() > 0
            if (!dryRun) d.clearComparisons()
            return { removed: had ? [COMPARISONS_FILE] : [] }
          },
        }),
        registerResetStep({
          id: 'decision-keys',
          order: 96,
          label: mainT('decisions.reset.keys'),
          secrets: true,
          run: async ({ dryRun }) => {
            const had = existsSync(join(app.dataDir, KEYS_FILE))
            if (!dryRun) keys.clear()
            return { removed: had ? [KEYS_FILE] : [] }
          },
        }),
      )
      stops.push(
        registerStorageCategory({
          id: 'decision-comparisons',
          label: mainT('decisions.storage'),
          order: 95,
          measure: async () => d.comparisonsBytes(),
          clear: {
            label: mainT('decisions.storage.clear'),
            run: async () => d.clearComparisons(),
          },
        }),
      )

      const services: DecisionsServices['decisions'] = {
        status: async () => d.status(),
        setKey: async (provider, key) => {
          keys.set(provider, key)
          return d.status()
        },
        test: (model) => d.test(model),
        catalog: () => d.catalog(),
        comparisons: async () => d.comparisons(),
        clearComparisons: async () => d.clearComparisons(),
        searchOrAsk: searchOrAskOnce,
        installMini: async () => {
          void installer.install().then(() => log.info('decisions', 'atelier-mini download ended', { status: installer.status().state }))
          return d.status()
        },
        cancelMini: async () => {
          installer.cancel()
          return d.status()
        },
        removeMini: async () => {
          installer.remove()
          return d.status()
        },
        installStep: async () => {
          void steps.install().then(() => log.info('decisions', 'atelier-step download ended', { status: steps.status().state }))
          return d.status()
        },
        cancelStep: async () => {
          steps.cancel()
          return d.status()
        },
        removeStep: async () => {
          steps.remove()
          return d.status()
        },
        openKeyPage: (provider) => {
          // The on-device model has no key and no page to make one.
          const url = PROVIDER_DEFAULTS[provider].keyUrl
          if (!app.smoke && url) void shell.openExternal(url).catch(() => undefined)
        },
      }
      return { decisions: services }
    },
    // DC-04: what is typed in a private window's composer never leaves the computer.
    window(win) {
      return {
        decisions: {
          searchOrAsk: (text: string, current: 'search' | 'ask') => (win.kind === 'private' ? Promise.resolve(current) : searchOrAskOnce(text, current)),
        },
      }
    },
    dispose() {
      for (const stop of stops.splice(0)) stop()
      setDecider(null)
      decider = null
    },
  }
}
