/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Quick decisions (docs/decisions.md): an optional decision model
// next to Atelier's own rules, never fixed to one provider or one model. You
// connect any providers (each with its own key, sealed on this computer) and
// any servers of your own, pick the models to use from what they offer (with
// prices where they list them), and put them in order: the first answers, the
// next ones step in when it fails, is busy or hits its rate limit. A model
// you add is checked by itself; one status at the top says where it stands,
// each model says how it is doing. One switch turns it all off without
// losing the setup. Model and key keeps one row that opens this page.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, ExternalLink, X } from 'lucide-react'
import {
  CHOSEN_MODELS_MAX,
  DECISIONS_SETTINGS_SCHEMA,
  DECISION_PRESETS,
  OWN_SERVER_PLACEHOLDER,
  PROVIDER_DEFAULTS,
  SERVERS_MAX,
  isOnDevice,
  isPreset,
  isServerUrl,
  perMessageEffort,
  sameModel,
  type DecisionCatalog,
  type DecisionComparison,
  type DecisionModelRef,
  type DecisionPresetId,
  type DecisionProviderId,
  type DecisionsStatus,
  type DecisionTestResult,
  type MiniStatus,
} from '@shared/decisions'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Badge, Button, IconButton, SegmentedControl, Select, Switch, useConfirm, useToast } from '../../ui'
import { useResource } from '../data'
import { Card, PageHeader, PageSkeleton, Row, Section, SwitchRow, TextInput } from '../kit'
import { DECISION_USE_GROUPS, decisionsHealth, healthTone, isSetUp, modelHealth, moveModel, nextServerId, priceText, refKey, type DecisionsHealth, type ModelHealth } from '../logic/decisions'

const COMPARISONS_SHOWN = 20
/** A Test's result shows this long; after that, the model's live state does. */
const TEST_SHOWN_MS = 60_000
/** Catalog rows shown at once; the search narrows a long list (OpenRouter carries dozens). */
const CATALOG_SHOWN = 40
/** A provider's list longer than this gets a search box. */
const CATALOG_SEARCH_FROM = 8

type Decisions = SettingsView['decisions']

interface PageProps {
  settings: SettingsView
  update(patch: SettingsPatch): void
  onOpenSection?(page: string): void
}

export function QuickDecisionsPage({ settings, update, onOpenSection }: PageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const d = settings.decisions
  // Both keep what they show while they reload, so a change never empties the page or loses its place.
  const status = useResource(() => call('decisions', 'status'), JSON.stringify([d.on, d.models, d.servers]), { keep: true })
  // While atelier-mini, atelier-step or atelier-vision downloads, its progress comes with the status: ask again each second.
  const downloading = status.data?.mini?.state === 'downloading' || status.data?.step?.state === 'downloading' || status.data?.vision?.state === 'downloading'
  useEffect(() => {
    if (!downloading) return
    const timer = setInterval(() => void status.reload(), 1_000)
    return () => clearInterval(timer)
  }, [downloading]) // eslint-disable-line react-hooks/exhaustive-deps
  const downloadAction = async (which: 'Mini' | 'Step' | 'Vision', action: DownloadAction): Promise<void> => {
    try {
      status.set(await call('decisions', `${action}${which}` as `install${'Mini' | 'Step' | 'Vision'}`))
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const connectedIds = Object.entries(status.data?.connected ?? {})
    .filter(([, on]) => on)
    .map(([id]) => id)
    .sort()
    .join(',')
  const anyConnected = connectedIds !== ''
  const catalog = useResource(() => (connectedIds ? call('decisions', 'catalog') : Promise.resolve([] as DecisionCatalog[])), connectedIds, { keep: true })
  const comparisons = useResource(() => call('decisions', 'comparisons'))
  /** Test results by model, kept a minute: after that, the model's live state shows again. */
  const [tests, setTests] = useState<Record<string, { result: DecisionTestResult; at: number }>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})

  // Each change builds on the last one sent, not on `d`, which only catches up after the settings round trip.
  const latest = useRef(d)
  useEffect(() => {
    latest.current = d
  }, [d])
  const patch = (next: Partial<Decisions>): void => {
    const merged = { ...latest.current, ...next }
    // A change Settings would refuse is never sent, so it can't leave the next changes building on it.
    if (!DECISIONS_SETTINGS_SCHEMA.safeParse(merged).success) {
      toast.show({ tone: 'error', message: t('decisions.cantSave') })
      return
    }
    latest.current = merged
    update({ decisions: merged })
  }

  const nameOf = (provider: DecisionProviderId): string => (isPreset(provider) ? t(`decisions.provider.${provider}`) : (d.servers.find((s) => s.id === provider)?.name ?? provider))
  // "at OpenRouter", but "on this computer" for Atelier's own model (its provider's name reads as a place already).
  const whereOf = (provider: DecisionProviderId): string => (isOnDevice(provider) ? t('decisions.models.onDevice') : t('decisions.models.at', { provider: nameOf(provider) }))

  const runTest = async (ref: DecisionModelRef): Promise<void> => {
    const key = refKey(ref)
    setChecking((c) => ({ ...c, [key]: true }))
    try {
      const result = await call('decisions', 'test', ref)
      setTests((all) => ({ ...all, [key]: { result, at: Date.now() } }))
      await status.reload()
    } catch (err) {
      setTests((all) => ({
        ...all,
        [key]: { result: { ...ref, ok: false, error: 'failed', detail: errorText(err) }, at: Date.now() },
      }))
    } finally {
      setChecking((c) => ({ ...c, [key]: false }))
    }
  }
  // A model added or a key saved is checked as soon as main has it: no separate Test needed.
  const checkNext = useRef<DecisionModelRef[]>([])
  const queueCheck = (refs: readonly DecisionModelRef[]): void => {
    for (const ref of refs) if (!checkNext.current.some((q) => sameModel(q, ref))) checkNext.current = [...checkNext.current, ref]
  }
  useEffect(() => {
    const pending = checkNext.current.filter((ref) => d.models.some((m) => sameModel(m, ref)) && status.data?.models.some((m) => sameModel(m, ref) && m.connected))
    if (pending.length === 0) return
    checkNext.current = checkNext.current.filter((ref) => !pending.some((p) => sameModel(p, ref)))
    for (const ref of pending) void runTest(ref)
  }, [d.models, status.data])

  const addModel = (ref: DecisionModelRef): void => {
    const now = latest.current.models
    if (now.some((m) => sameModel(m, ref)) || now.length >= CHOSEN_MODELS_MAX) return
    queueCheck([ref])
    // The first model you add turns it on; the switch above turns it off again.
    patch({ models: [...now, ref], ...(now.length === 0 ? { on: true } : {}) })
  }
  const removeModel = (ref: DecisionModelRef): void => {
    checkNext.current = checkNext.current.filter((q) => !sameModel(q, ref))
    patch({ models: latest.current.models.filter((m) => !sameModel(m, ref)) })
  }
  /** Moves a model by what it is, not by the row it was in when the list last drew, so quick clicks move the right one. */
  const moveRef = (ref: DecisionModelRef, delta: -1 | 1): void => {
    const at = latest.current.models.findIndex((m) => sameModel(m, ref))
    if (at >= 0) patch({ models: moveModel(latest.current.models, at, delta) })
  }

  const modelRows = d.models.map((ref) => {
    const live = status.data?.models.find((m) => sameModel(m, ref))
    const tested = tests[refKey(ref)]
    const fresh = tested && Date.now() - tested.at < TEST_SHOWN_MS ? tested.result : null
    const health: ModelHealth = live ? modelHealth(live, fresh, checking[refKey(ref)] === true) : { kind: 'unchecked' }
    return { ref, health }
  })
  const health = decisionsHealth(status.data, modelRows, d.on)
  // How it's used and what it decides apply once a chosen model can be asked, switched on or not.
  const setUp = modelRows.some((r) => r.health.kind !== 'not-connected') && anyConnected

  const saveKey = async (provider: DecisionProviderId, value: string | null): Promise<boolean> => {
    try {
      status.set(await call('decisions', 'setKey', provider, value))
      toast.show({
        tone: 'success',
        message: value ? t('decisions.keySaved') : t('decisions.keyRemoved'),
      })
      if (value) {
        // Its models in your list are checked again; with none chosen yet, its suggested model is added to start with.
        const mine = latest.current.models.filter((m) => m.provider === provider)
        if (mine.length > 0) queueCheck(mine)
        else if (isPreset(provider) && latest.current.models.length === 0) addModel({ provider, model: PROVIDER_DEFAULTS[provider].suggested })
      }
      return true
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
      return false
    }
  }
  const disconnect = async (provider: DecisionProviderId): Promise<void> => {
    if (
      await confirm({
        title: t('decisions.disconnectTitle', { provider: nameOf(provider) }),
        message: t('decisions.disconnectMessage'),
        confirmLabel: t('decisions.disconnect'),
        destructive: true,
      })
    )
      await saveKey(provider, null)
  }
  const removeServer = async (id: DecisionProviderId): Promise<void> => {
    if (
      !(await confirm({
        title: t('decisions.server.removeTitle', { name: nameOf(id) }),
        confirmLabel: t('decisions.server.remove'),
        destructive: true,
      }))
    )
      return
    // Its key goes with it; main also forgets keys of servers that are gone when it starts.
    if (status.data?.keys[id]) await call('decisions', 'setKey', id, null).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
    patch({
      servers: latest.current.servers.filter((s) => s.id !== id),
      models: latest.current.models.filter((m) => m.provider !== id),
    })
  }
  const clearComparisons = async (): Promise<void> => {
    if (
      !(await confirm({
        title: t('decisions.clearTitle'),
        confirmLabel: t('decisions.clear'),
        destructive: true,
      }))
    )
      return
    await call('decisions', 'clearComparisons')
    comparisons.set([])
  }

  const providersSection = (
    <Section title={t('decisions.section.providers')} note={t('decisions.privacy')}>
      <div className="dc-stack" data-settings-anchor="decisions-providers">
        <Card>
          {DECISION_PRESETS.map((id) =>
            PROVIDER_DEFAULTS[id].keyUrl === '' ? (
              <DeviceRow
                key={id}
                id={id}
                installed={status.data?.connected[id] ?? false}
                inUse={d.models.some((m) => m.provider === id)}
                onUse={() => addModel({ provider: id, model: PROVIDER_DEFAULTS[id].suggested })}
                mini={status.data?.mini}
                miniModel={modelName('atelier-mini', status.data?.miniVersion)}
                onMini={(action) => void downloadAction('Mini', action)}
                step={status.data?.step}
                stepModel={modelName('atelier-step', status.data?.stepVersion)}
                onStep={(action) => void downloadAction('Step', action)}
                vision={status.data?.vision}
                visionModel={modelName('atelier-vision', status.data?.visionVersion)}
                onVision={(action) => void downloadAction('Vision', action)}
              />
            ) : (
              <PresetRow key={id} id={id} hasKey={status.data?.keys[id] ?? false} onSave={(key) => saveKey(id, key)} onDisconnect={() => void disconnect(id)} />
            ),
          )}
        </Card>
        <Card>
          {d.servers.map((server) => (
            <Row key={server.id} title={server.name} description={server.url}>
              <Badge tone={status.data?.keys[server.id] ? 'success' : 'info'}>{status.data?.keys[server.id] ? t('decisions.server.withKey') : t('decisions.server.noKey')}</Badge>
              <Button variant="secondary" size="sm" onClick={() => void removeServer(server.id)}>
                {t('decisions.server.remove')}
              </Button>
            </Row>
          ))}
          <AddServer
            taken={d.servers.map((s) => s.id)}
            full={d.servers.length >= SERVERS_MAX}
            onAdd={async (server, key) => {
              // The key first: if it can't be saved, the server isn't added and the form keeps what was typed.
              if (key && !(await saveKey(server.id, key))) return false
              patch({ servers: [...latest.current.servers, server] })
              await status.reload()
              return true
            }}
          />
        </Card>
      </div>
    </Section>
  )

  // Until the status has loaded, nothing would be right yet (every provider would read as not connected).
  if (!status.data) {
    return (
      <>
        <PageHeader title={t('decisions.title')} description={t('decisions.note')} />
        <PageSkeleton label={t('decisions.title')} rows={4} />
      </>
    )
  }

  return (
    <>
      <PageHeader title={t('decisions.title')} description={t('decisions.note')} />
      <Section>
        <Card>
          <SwitchRow
            anchor="decisions-on"
            label={
              <>
                {t('decisions.on')} <Badge tone={healthTone(health)}>{t(`decisions.health.${badgeOf(health)}`)}</Badge>
              </>
            }
            description={<HealthText health={health} whereOf={whereOf} />}
            checked={d.on}
            onChange={(on) => patch({ on })}
          />
        </Card>
      </Section>

      {/* Until a provider is connected, the providers come first; after that, your models do. */}
      {!anyConnected && providersSection}
      {anyConnected && (
        <Section title={t('decisions.section.models')} note={t('decisions.models.note')}>
          <div className="dc-stack" data-settings-anchor="decisions-models">
            <Card>
              {d.models.length === 0 ? (
                <p className="sp-row sp-field__hint">{t('decisions.models.none')}</p>
              ) : (
                <ol className="dc-models" aria-label={t('decisions.section.models')}>
                  {modelRows.map(({ ref, health: h }, i) => (
                    <li key={refKey(ref)} className="dc-model">
                      <div className="dc-model__text">
                        <span className="dc-model__name">
                          {ref.model}
                          {isOnDevice(ref.provider) ? ', ' : ' '}
                          <span className="dc-model__where">{whereOf(ref.provider)}</span>
                        </span>
                        {isOnDevice(ref.provider) && status.data?.mini?.state === 'ready' && <span className="sp-field__hint">{t('decisions.models.withMini')}</span>}
                        <span className="dc-model__state">
                          <Badge tone={healthTone(h)}>{i === 0 ? t('decisions.models.first') : t('decisions.models.backup', { n: String(i) })}</Badge> <ModelLine health={h} />
                        </span>
                      </div>
                      <div className="dc-model__actions">
                        <Button size="sm" variant="secondary" loading={checking[refKey(ref)] === true} disabled={h.kind === 'not-connected'} onClick={() => void runTest(ref)}>
                          {t('decisions.test')}
                        </Button>
                        <IconButton
                          size="sm"
                          label={t('decisions.models.up', { model: ref.model })}
                          icon={<ArrowUp aria-hidden />}
                          disabled={i === 0}
                          onClick={() => moveRef(ref, -1)}
                        />
                        <IconButton
                          size="sm"
                          label={t('decisions.models.down', {
                            model: ref.model,
                          })}
                          icon={<ArrowDown aria-hidden />}
                          disabled={i === d.models.length - 1}
                          onClick={() => moveRef(ref, 1)}
                        />
                        <IconButton
                          size="sm"
                          label={t('decisions.models.remove', {
                            model: ref.model,
                          })}
                          icon={<X aria-hidden />}
                          onClick={() => removeModel(ref)}
                        />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <Catalog lists={catalog.data ?? []} loading={catalog.loading} chosen={d.models} full={d.models.length >= CHOSEN_MODELS_MAX} nameOf={nameOf} onAdd={addModel} />
          </div>
        </Section>
      )}

      {anyConnected && providersSection}

      {!setUp && (
        // Settings search can land here for the parts that come with a model; they say where they will be.
        <div data-settings-anchor="decisions-models">
          <div data-settings-anchor="decisions-mode">
            <p className="sp-field__hint" data-settings-anchor="decisions-uses">
              {t('decisions.laterHint')}
            </p>
          </div>
        </div>
      )}
      {setUp && (
        <Section>
          <Card>
            <Row title={t('decisions.mode')} description={t(d.mode === 'use' ? 'decisions.mode.use.description' : 'decisions.mode.compare.description')} anchor="decisions-mode">
              <SegmentedControl
                label={t('decisions.mode')}
                size="sm"
                value={d.mode}
                options={[
                  { value: 'use', label: t('decisions.mode.use') },
                  { value: 'compare', label: t('decisions.mode.compare') },
                ]}
                onChange={(mode) => patch({ mode })}
              />
            </Row>
          </Card>
        </Section>
      )}
      {setUp && (
        <div data-settings-anchor="decisions-uses">
          {DECISION_USE_GROUPS.map((group) => (
            <Section key={group.id} title={t(`decisions.group.${group.id}`)}>
              <Card>
                {group.uses.map((use) => (
                  <Switch key={use} label={t(`decisions.use.${use}`)} description={<UseDescription use={use} settings={settings} />} checked={d.uses[use]} onChange={(on) => patch({ uses: { ...latest.current.uses, [use]: on } })} />
                ))}
              </Card>
            </Section>
          ))}
        </div>
      )}
      {setUp && <Comparisons rows={comparisons.data ?? []} status={status.data} onRefresh={() => {
            setTests({})
            void Promise.all([comparisons.reload(), status.reload()])
          }} onClear={() => void clearComparisons()} />}
      {onOpenSection && setUp && (
        <p className="sp-field__hint">
          <button type="button" className="sp-link" onClick={() => onOpenSection('model')}>
            {t('decisions.usageLink')}
          </button>
        </p>
      )}
    </>
  )
}

type DownloadAction = 'install' | 'cancel' | 'remove'

/** One of the on-device models' optional downloads: what it does, and download, stop or remove. */
/** "atelier-step v0.1" from the name and the version it downloads ("step-v0.1" names its release). */
function modelName(name: string, version: string | undefined): string {
  return version ? `${name} ${version.replace(/^[a-z]+-(?=v\d)/, '')}` : name
}

function DownloadRow({ anchor, name, model, description, state, onAction }: { anchor: string; name: string; model: string; description: string; state: MiniStatus; onAction(action: DownloadAction): void }): ReactElement {
  const t = useT()
  const mb = (bytes: number): string => String(Math.round(bytes / 1e6))
  return (
    <div className="dc-provider" data-settings-anchor={anchor}>
      <div className="dc-provider__text">
        <span className="sp-field__label">
          {name} <span className="dc-model__where">· {model}</span>{' '}
          {state.state === 'ready' && <Badge tone="success">{t('decisions.device.mini.ready')}</Badge>}
          {state.state === 'downloading' && <Badge tone="info">{t('decisions.device.mini.downloading', { received: mb(state.received), total: mb(state.total) })}</Badge>}
        </span>
        <span className="sp-field__hint">{description}</span>
        {state.state === 'failed' && <p className="sp-field__error">{t('decisions.device.mini.failed', { error: state.error })}</p>}
      </div>
      <div className="dc-provider__actions">
        {(state.state === 'absent' || state.state === 'failed') && (
          <Button size="sm" variant="secondary" onClick={() => onAction('install')}>
            {t('decisions.device.mini.download', { size: mb(state.total) })}
          </Button>
        )}
        {state.state === 'downloading' && (
          <Button size="sm" variant="ghost" onClick={() => onAction('cancel')}>
            {t('decisions.device.mini.cancel')}
          </Button>
        )}
        {state.state === 'ready' && !state.external && (
          <Button size="sm" variant="ghost" onClick={() => onAction('remove')}>
            {t('decisions.device.mini.remove')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Atelier's own model on this computer: no key to connect, only whether its files are here and whether you use it; its optional larger half, atelier-mini, atelier-step for browser tasks and atelier-vision for pictures, to download or remove. */
function DeviceRow({
  id,
  installed,
  inUse,
  onUse,
  mini,
  miniModel,
  onMini,
  step,
  stepModel,
  onStep,
  vision,
  visionModel,
  onVision,
}: {
  id: DecisionPresetId
  installed: boolean
  inUse: boolean
  onUse(): void
  mini?: MiniStatus
  miniModel: string
  onMini(action: DownloadAction): void
  step?: MiniStatus
  stepModel: string
  onStep(action: DownloadAction): void
  vision?: MiniStatus
  visionModel: string
  onVision(action: DownloadAction): void
}): ReactElement {
  const t = useT()
  return (
    <div className="sp-row sp-row--stack" data-settings-anchor={`decisions-provider-${id}`}>
      <div className="dc-provider">
        <div className="dc-provider__text">
          <span className="sp-field__label">
            {t(`decisions.provider.${id}`)} <span className="dc-model__where">· {PROVIDER_DEFAULTS[id].suggested}</span>{' '}
            <Badge tone={installed ? 'success' : 'neutral'}>{installed ? t('decisions.device.ready') : t('decisions.device.missing')}</Badge>
          </span>
          <span className="sp-field__hint">{t(`decisions.provider.${id}.description`)}</span>
        </div>
        <div className="dc-provider__actions">
          {installed && !inUse && (
            <Button size="sm" variant="secondary" onClick={onUse}>
              {t('decisions.device.use')}
            </Button>
          )}
        </div>
      </div>
      {installed && mini && mini.state !== 'unavailable' && (
        <DownloadRow anchor="decisions-device-mini" name={t('decisions.device.mini')} model={miniModel} description={t('decisions.device.mini.description')} state={mini} onAction={onMini} />
      )}
      {step && step.state !== 'unavailable' && (
        <DownloadRow anchor="decisions-device-step" name={t('decisions.device.step')} model={stepModel} description={t('decisions.device.step.description')} state={step} onAction={onStep} />
      )}
      {vision && vision.state !== 'unavailable' && (
        <DownloadRow anchor="decisions-device-vision" name={t('decisions.device.vision')} model={visionModel} description={t('decisions.device.vision.description')} state={vision} onAction={onVision} />
      )}
    </div>
  )
}

/** A listed provider: connect it with a key, change the key, or disconnect it. */
function PresetRow({ id, hasKey, onSave, onDisconnect }: { id: DecisionPresetId; hasKey: boolean; onSave(key: string): Promise<boolean>; onDisconnect(): void }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const name = t(`decisions.provider.${id}`)
  const save = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    const ok = await onSave(key.trim())
    setBusy(false)
    if (ok) {
      setKey('')
      setOpen(false)
    }
  }
  return (
    <div className="sp-row sp-row--stack" data-settings-anchor={`decisions-provider-${id}`}>
      <div className="dc-provider">
        <div className="dc-provider__text">
          <span className="sp-field__label">
            {name} <Badge tone={hasKey ? 'success' : 'neutral'}>{hasKey ? t('decisions.connected') : t('decisions.notConnected')}</Badge>
          </span>
          <span className="sp-field__hint">{t(`decisions.provider.${id}.description`)}</span>
        </div>
        <div className="dc-provider__actions">
          {hasKey && (
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              {t('decisions.disconnect')}
            </Button>
          )}
          <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {hasKey ? t('decisions.changeKey') : t('decisions.connect')}
          </Button>
        </div>
      </div>
      {open && (
        <form
          className="sp-field__row"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <TextInput
            className="sp-input--inline"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder={hasKey ? t('decisions.pasteNewKey') : t('decisions.pasteKey')}
            aria-label={t('decisions.keyFor', { provider: name })}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!key.trim()} loading={busy}>
            {t('decisions.saveKey')}
          </Button>
        </form>
      )}
      {open && (
        <p className="sp-field__hint">
          {t('decisions.keyHint')}{' '}
          <button type="button" className="sp-link" onClick={() => void call('decisions', 'openKeyPage', id)}>
            {t('decisions.getKey')} <ExternalLink size={12} aria-hidden />
          </button>
        </p>
      )}
    </div>
  )
}

/** Adds a server of your own: a name, its address, and a key only if it asks for one. */
function AddServer({ taken, full, onAdd }: { taken: readonly string[]; full: boolean; onAdd(server: { id: `server-${string}`; name: string; url: string }, key: string | null): Promise<boolean> }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!open) {
    return (
      <Row title={t('decisions.server.title')} description={t('decisions.server.description')}>
        <Button size="sm" variant="secondary" disabled={full} onClick={() => setOpen(true)}>
          {t('decisions.server.add')}
        </Button>
      </Row>
    )
  }
  const submit = async (): Promise<void> => {
    if (!isServerUrl(url.trim())) {
      setError(t('decisions.server.badUrl'))
      return
    }
    const added = await onAdd(
      {
        id: nextServerId(taken),
        name: name.trim() || t('decisions.server.defaultName'),
        url: url.trim(),
      },
      key.trim() || null,
    )
    if (!added) return
    setOpen(false)
    setName('')
    setUrl('')
    setKey('')
    setError(null)
  }
  return (
    <form
      className="sp-row sp-row--stack"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <span className="sp-field__label">{t('decisions.server.title')}</span>
      <TextInput value={name} maxLength={60} placeholder={t('decisions.server.defaultName')} aria-label={t('decisions.server.name')} onChange={(e) => setName(e.target.value)} />
      <TextInput type="url" value={url} maxLength={500} placeholder={OWN_SERVER_PLACEHOLDER} spellCheck={false} aria-label={t('decisions.url')} invalid={!!error} onChange={(e) => setUrl(e.target.value)} />
      <div className="sp-field__row">
        <TextInput className="sp-input--inline" type="password" value={key} autoComplete="off" spellCheck={false} placeholder={t('decisions.keyOptional')} aria-label={t('decisions.keyOptional')} onChange={(e) => setKey(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!url.trim()}>
          {t('decisions.server.save')}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('decisions.cancel')}
        </Button>
      </div>
      {error ? (
        <p className="sp-field__error" role="alert">
          {error}
        </p>
      ) : (
        <p className="sp-field__hint">{t('decisions.urlHint')}</p>
      )}
    </form>
  )
}

/** What the connected providers offer: pick a provider, search, add; or type a model id it doesn't list. */
function Catalog({
  lists,
  loading,
  chosen,
  full,
  nameOf,
  onAdd,
}: {
  lists: readonly DecisionCatalog[]
  loading: boolean
  chosen: readonly DecisionModelRef[]
  full: boolean
  nameOf(provider: DecisionProviderId): string
  onAdd(ref: DecisionModelRef): void
}): ReactElement | null {
  const t = useT()
  const [provider, setProvider] = useState<DecisionProviderId | null>(null)
  const [query, setQuery] = useState('')
  const [typed, setTyped] = useState('')
  const current = lists.find((l) => l.provider === provider) ?? lists[0]
  const shown = useMemo(() => {
    // The search narrows only a list long enough to show its box.
    const q = (current?.models.length ?? 0) > CATALOG_SEARCH_FROM ? query.trim().toLowerCase() : ''
    return (current?.models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q))
  }, [current, query])
  if (!current) return loading ? <p className="sp-field__hint">{t('decisions.catalog.loading')}</p> : null
  return (
    <Card>
      <div className="sp-row sp-row--stack">
        <span className="sp-field__label">{t('decisions.catalog.title')}</span>
        {(lists.length > 1 || current.models.length > CATALOG_SEARCH_FROM) && (
          <div className="sp-field__row">
            {lists.length > 1 && (
              <Select
                aria-label={t('decisions.catalog.provider')}
                value={current.provider}
                options={lists.map((l) => ({
                  value: l.provider,
                  label: nameOf(l.provider),
                }))}
                onChange={(p) => {
                  setProvider(p as DecisionProviderId)
                  setQuery('')
                }}
              />
            )}
            {current.models.length > CATALOG_SEARCH_FROM && <TextInput className="sp-input--inline" value={query} placeholder={t('decisions.catalog.search')} aria-label={t('decisions.catalog.search')} onChange={(e) => setQuery(e.target.value)} />}
          </div>
        )}
        {current.failed && <p className="sp-field__hint">{t('decisions.catalog.failed')}</p>}
        {!current.failed && current.models.length === 0 && <p className="sp-field__hint">{t('decisions.catalog.empty')}</p>}
      </div>
      {shown.length > 0 && (
        <ul className="dc-catalog" aria-label={t('decisions.catalog.title')}>
          {shown.slice(0, CATALOG_SHOWN).map((m) => {
            const ref = { provider: current.provider, model: m.id }
            const added = chosen.some((c) => sameModel(c, ref))
            const price = priceText(m.price)
            const suggested = isPreset(current.provider) && PROVIDER_DEFAULTS[current.provider].suggested === m.id
            return (
              <li key={m.id} className="dc-catalog__row">
                <span className="dc-catalog__name">
                  <span className="dc-catalog__id">{m.id}</span>
                  {suggested && <Badge tone="accent">{t('decisions.catalog.suggested')}</Badge>}
                  {price === 'free' ? <Badge tone="success">{t('decisions.catalog.free')}</Badge> : price && <span className="dc-catalog__meta">{t('decisions.catalog.price', { price })}</span>}
                  {m.zdr && <span className="dc-catalog__meta">{t('decisions.catalog.zdr')}</span>}
                </span>
                <Button size="sm" variant="secondary" disabled={added || full} onClick={() => onAdd(ref)}>
                  {added ? t('decisions.catalog.added') : t('decisions.catalog.add')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {/* Atelier's own model has one name; anything typed here would be the same model again. */}
      {!isOnDevice(current.provider) && (
        <form
          className="sp-row sp-row--stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (!typed.trim()) return
            onAdd({ provider: current.provider, model: typed.trim() })
            setTyped('')
          }}
        >
          <span className="sp-field__label">{t('decisions.catalog.other', { provider: nameOf(current.provider) })}</span>
          <div className="sp-field__row">
            <TextInput
              className="sp-input--inline"
              value={typed}
              maxLength={120}
              spellCheck={false}
              placeholder={isPreset(current.provider) ? PROVIDER_DEFAULTS[current.provider].suggested : 'kev-latest'}
              aria-label={t('decisions.catalog.other', {
                provider: nameOf(current.provider),
              })}
              onChange={(e) => setTyped(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={!/^[A-Za-z0-9._:/~@-]+$/.test(typed.trim()) || full}>
              {t('decisions.catalog.add')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

/** The badge's word for the page's status. */
function badgeOf(health: DecisionsHealth): 'off' | 'notSetUp' | 'working' | 'failing' | 'paused' | 'ready' {
  switch (health.kind) {
    case 'no-provider':
    case 'no-model':
      return 'notSetUp'
    default:
      return health.kind
  }
}

/** The status in words, under the switch: what to do next, or how it is doing. */
function HealthText({ health, whereOf }: { health: DecisionsHealth; whereOf(provider: DecisionProviderId): string }): ReactElement {
  const t = useT()
  switch (health.kind) {
    case 'off':
      return <>{t('decisions.line.off')}</>
    case 'no-provider':
      return <>{t('decisions.line.noProvider')}</>
    case 'no-model':
      return <>{t('decisions.line.noModel')}</>
    case 'working':
      return (
        <>
          {t('decisions.line.working', {
            model: health.model.model,
            where: whereOf(health.model.provider),
          })}
        </>
      )
    case 'failing':
      return <>{t('decisions.line.failing')}</>
    case 'paused':
      return <>{t('decisions.line.paused', { minutes: String(health.minutes) })}</>
    case 'ready':
      return <>{t('decisions.line.ready')}</>
  }
}

/** One model's state, after its badge. */
function ModelLine({ health }: { health: ModelHealth }): ReactElement {
  const t = useT()
  switch (health.kind) {
    case 'not-connected':
      return <span className="sp-field__hint">{t('decisions.model.notConnected')}</span>
    case 'checking':
      return <span className="sp-field__hint">{t('decisions.line.checking')}</span>
    case 'working':
      return (
        <span className="sp-field__hint">
          {health.tested
            ? t('decisions.testOk', {
                model: health.answered,
                ms: String(health.ms),
              })
            : t('decisions.lastAnswer', {
                model: health.answered,
                ms: String(health.ms),
              })}
        </span>
      )
    case 'slow':
      return <span className="sp-field__hint">{t('decisions.model.slow')}</span>
    case 'paused':
      return <span className="sp-field__hint">{[t('decisions.paused', { minutes: String(health.minutes) }), health.reason ? t('decisions.pausedSaid', { reason: health.reason }) : ''].filter(Boolean).join(' ')}</span>
    case 'failing':
      return (
        <span className="sp-field__error" role="alert">
          {[t(`decisions.error.${health.error}`), health.detail ? t('decisions.pausedSaid', { reason: health.detail }) : ''].filter(Boolean).join(' ')}
        </span>
      )
    case 'unchecked':
      return <span className="sp-field__hint">{t('decisions.model.unchecked')}</span>
  }
}

/** A switch's description, with what it depends on where that isn't on. */
function UseDescription({ use, settings }: { use: (typeof DECISION_USE_GROUPS)[number]['uses'][number]; settings: SettingsView }): ReactElement {
  const t = useT()
  const extra = use === 'effort' && !perMessageEffort(settings.model) ? t('decisions.use.effort.noModel', { model: settings.model }) : use === 'memory' ? t('decisions.use.memory.where') : null
  return (
    <>
      {t(`decisions.use.${use}.description`)}
      {extra && (
        <>
          {' '}
          <span className="dc-use__note">{extra}</span>
        </>
      )}
    </>
  )
}

/** Model and key's row: whether quick decisions are on, and the page that sets them up. */
export function QuickDecisionsSummary({ settings, onOpen }: { settings: SettingsView; onOpen(): void }): ReactElement {
  const t = useT()
  const d = settings.decisions
  const status = useResource(() => call('decisions', 'status'), JSON.stringify([d.on, d.models, d.servers]))
  const rows = (status.data?.models ?? []).map((m) => ({
    ref: { provider: m.provider, model: m.model },
    health: modelHealth(m, null, false),
  }))
  const health = decisionsHealth(status.data, rows, d.on)
  const where = (ref: DecisionModelRef): string =>
    isOnDevice(ref.provider) ? t('decisions.models.onDevice') : t('decisions.models.at', { provider: isPreset(ref.provider) ? t(`decisions.provider.${ref.provider}`) : (d.servers.find((s) => s.id === ref.provider)?.name ?? ref.provider) })
  const first = d.models[0]
  const shown = health.kind === 'working' ? health.model : first
  const description =
    health.kind === 'off'
      ? t('decisions.summary.off')
      : !isSetUp(health) || !shown
        ? t('decisions.summary.notSetUp')
        : health.kind === 'failing'
          ? t('decisions.summary.failing', {
              model: shown.model,
              where: where(shown),
            })
          : t('decisions.summary.on', {
              model: shown.model,
              where: where(shown),
              count: d.models.length,
            })
  return (
    <Section>
      <Card>
        <Row title={t('decisions.title')} description={description} anchor="decisions-summary">
          <Button variant="secondary" onClick={onOpen}>
            {d.on || d.models.length > 0 ? t('decisions.summary.open') : t('decisions.summary.setUp')}
          </Button>
        </Row>
      </Card>
    </Section>
  )
}

function Comparisons({ rows, status, onRefresh, onClear }: { rows: readonly DecisionComparison[]; status: DecisionsStatus | null; onRefresh(): void; onClear(): void }): ReactElement {
  const t = useT()
  return (
    <Section
      title={t('decisions.comparisons')}
      note={
        status
          ? t('decisions.comparisons.summary', {
              answered: String(status.answered),
              differed: String(status.differed),
            })
          : t('decisions.comparisons.description')
      }
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            {t('decisions.refresh')}
          </Button>
          {rows.length > 0 && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              {t('decisions.clear')}
            </Button>
          )}
        </>
      }
    >
      <Card>
        {rows.length === 0 ? (
          <p className="sp-row sp-field__hint">{t('decisions.comparisons.none')}</p>
        ) : (
          <ul className="dc-comparisons" aria-label={t('decisions.comparisons')}>
            {rows.slice(0, COMPARISONS_SHOWN).map((row) => (
              <li key={`${row.at}-${row.use}`} className="dc-comparison">
                <span className="dc-comparison__use">{t(`decisions.caller.${row.use}`)}</span>
                <span className="dc-comparison__verdicts">
                  {t('decisions.comparison', {
                    rule: row.rule,
                    model: row.model,
                    confidence: String(Math.round(row.confidence * 100)),
                  })}
                  {row.applied ? ` · ${t('decisions.comparison.applied')}` : ''}
                </span>
                {row.excerpt && <span className="dc-comparison__excerpt">{row.excerpt}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  )
}
