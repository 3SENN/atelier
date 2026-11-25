/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Import (ST-46), also embedded (compact) in the welcome
// flow (ON-03). Main finds the browsers on this computer and their profiles;
// the person picks one, ticks what to bring over, watches counts arrive and
// gets a summary: success, partial, nothing found, or an error with Try
// again. Safari waits behind Full Disk Access on macOS, with the way there.
import { Fragment, useEffect, useId, useState, type ReactElement } from 'react'
import { CircleCheck, Globe, Import, Info } from 'lucide-react'
import type { ImportBrowser, ImportProgress, ImportSummary, ImportType } from '@shared/browserImport'
import { atelier, call } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, CheckRow, EmptyState, ErrorState, Select, SkeletonRows, Spinner, useAsyncAction } from '../../ui'
import { useEvent, useResource } from '../data'
import { Card, ListFrame, Notice, PageHeader, Row, Section } from '../kit'
import { ImportTargetRow } from '../../profiles/ImportTarget'
import { countedTypes, defaultTypes, IMPORT_COUNT_LABELS, IMPORT_TYPE_LABELS, initialBrowser, joinList, needsProfilePicker, toggleType } from '../logic/importFlow'
import { ExtensionImportStatus, ExtensionsPicker, type ExtensionRunState } from './ImportExtensions'

export interface ImportSectionProps {
  /** The welcome step: no page header, a tighter frame and the explainer up top. */
  compact?: boolean
  /** ?browser=<id>: the browser to start on. */
  browser?: string | null
}

type RunState = { kind: 'idle' } | { kind: 'running'; progress: ImportProgress | null } | { kind: 'done'; summary: ImportSummary } | { kind: 'failed'; message: string }

export function ImportSection({ compact = false, browser: wanted = null }: ImportSectionProps): ReactElement {
  const t = useT()
  const browsers = useResource(() => call('browserImport', 'browsers'))
  const [browserId, setBrowserId] = useState<string | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [types, setTypes] = useState<ImportType[]>([])
  const [state, setState] = useState<RunState>({ kind: 'idle' })
  // ST-46 X: the Extensions choice and its checklist (Chromium browsers).
  const [extOn, setExtOn] = useState(false)
  const [extPicks, setExtPicks] = useState<string[]>([])
  const [extState, setExtState] = useState<ExtensionRunState>({ kind: 'idle' })
  const browserSelect = useId()
  const profileSelect = useId()

  const list = browsers.data
  const chosen = list?.find((b) => b.id === browserId) ?? null

  // First load (and a re-check after Full Disk Access): keep the pick if it is still there.
  useEffect(() => {
    if (!list) return
    const keep = list.find((b) => b.id === browserId)
    const next = keep ?? initialBrowser(list, wanted)
    if (!next) return
    if (!keep) pick(next)
  }, [list])

  // Back from System Settings: look again, so Safari unlocks without a reload.
  useEffect(() => {
    const recheck = (): void => {
      if (document.visibilityState === 'visible' && chosen?.needsAccess) void browsers.reload()
    }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [chosen?.needsAccess])

  useEvent('import-progress', (e) => {
    setState((s) => (s.kind === 'running' && e.progress.browserId === browserId ? { kind: 'running', progress: e.progress } : s))
  })

  function pick(next: ImportBrowser): void {
    setBrowserId(next.id)
    setProfileId(next.profiles[0]?.id ?? null)
    setTypes(defaultTypes(next))
    setState({ kind: 'idle' })
    setExtOn(false)
    setExtPicks([])
    setExtState({ kind: 'idle' })
  }

  const wantExtensions = Boolean(chosen?.extensions) && extOn && extPicks.length > 0
  const run = useAsyncAction(async () => {
    if (!chosen || !profileId || (types.length === 0 && !wantExtensions)) return
    if (types.length > 0) {
      setState({ kind: 'running', progress: null })
      try {
        const summary = await call('browserImport', 'run', { browserId: chosen.id, profileId, types })
        setState({ kind: 'done', summary })
      } catch (err) {
        setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    }
    if (wantExtensions) {
      setExtState({ kind: 'running' })
      try {
        setExtState({ kind: 'done', report: await call('browserImport', 'installExtensions', { browserId: chosen.id, profileId, ids: extPicks }) })
      } catch (err) {
        setExtState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    }
  })

  const explainer = <p className="sp-import__explainer">{t('settings.import.explainer')}</p>
  let body: ReactElement
  if (list === null) {
    body = <ListFrame>{browsers.error ? <ErrorState title={t('settings.import.lookFailed')} message={browsers.error} onRetry={browsers.reload} compact /> : <SkeletonRows rows={3} avatar label={t('settings.import.looking')} />}</ListFrame>
  } else if (list.length === 0) {
    body = (
      <ListFrame>
        <EmptyState icon={<Import />} title={t('settings.import.none')} description={t('settings.import.none.description')} compact={compact} action={<Button size="sm" variant="secondary" onClick={() => void browsers.reload()}>{t('settings.import.access.check')}</Button>} />
      </ListFrame>
    )
  } else {
    const busy = state.kind === 'running' || extState.kind === 'running'
    const nothingChosen = types.length === 0 && !wantExtensions
    body = (
      <div className="sp-import">
        <Card>
          <Row title={t('settings.import.browsers')} htmlFor={browserSelect} icon={<Globe />} anchor="import-browser">
            <Select
              id={browserSelect}
              aria-label={t('settings.import.browsers.label')}
              value={browserId ?? ''}
              disabled={busy}
              options={list.map((b) => ({ value: b.id, label: b.profiles.length > 1 ? `${b.name} (${t('settings.import.profiles', { count: b.profiles.length })})` : b.name }))}
              onChange={(id) => {
                const next = list.find((b) => b.id === id)
                if (next) pick(next)
              }}
            />
          </Row>
          {needsProfilePicker(chosen) && chosen && (
            <Row title={t('settings.import.profile')} htmlFor={profileSelect}>
              <Select id={profileSelect} value={profileId ?? ''} disabled={busy} options={chosen.profiles.map((p) => ({ value: p.id, label: p.name }))} onChange={setProfileId} />
            </Row>
          )}
          {/* ST-46: the Atelier profile the import goes into. */}
          <ImportTargetRow disabled={busy} />
        </Card>

        {chosen?.needsAccess ? (
          <Notice
            tone="warning"
            action={
              <span className="sp-import__access">
                {atelier.platform === 'darwin' && (
                  <Button size="sm" variant="secondary" onClick={() => void call('browserImport', 'openAccessSettings')}>
                    {t('settings.import.access.open')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void browsers.reload()}>
                  {t('settings.import.access.check')}
                </Button>
              </span>
            }
          >
            <strong>{t('settings.import.access')}</strong> {t('settings.import.access.description')}
          </Notice>
        ) : (
          chosen && (
            <>
              <fieldset className="sp-import__types" disabled={busy}>
                <legend className="sp-section__title">{t('settings.import.what')}</legend>
                {chosen.types.map((type) => (
                  <Fragment key={type}>
                    <CheckRow label={t(IMPORT_TYPE_LABELS[type])} checked={types.includes(type)} onChange={(on) => setTypes((cur) => toggleType(cur, type, on, chosen.types))} />
                    {type === 'addresses' && <p className="sp-import__type-note sp-field__hint">{t('settings.import.addresses.explain')}</p>}
                    {type === 'cookies' && <p className="sp-import__type-note sp-field__hint">{t('settings.import.cookies.explain')}</p>}
                  </Fragment>
                ))}
                {chosen.extensions && profileId && (
                  <ExtensionsPicker
                    browserId={chosen.id}
                    profileId={profileId}
                    on={extOn}
                    onToggle={setExtOn}
                    picks={extPicks}
                    onPicks={setExtPicks}
                    disabled={busy}
                  />
                )}
              </fieldset>
              {nothingChosen && (
                <p className="sp-field__hint" role="status">
                  {t('settings.import.chooseType')}
                </p>
              )}
              <div className="sp-import__actions">
                <Button variant="primary" icon={<Import />} loading={busy} disabled={nothingChosen || !profileId} onClick={() => void run.run()}>
                  {state.kind === 'done' || extState.kind === 'done' ? t('settings.import.again') : t('settings.import.run')}
                </Button>
              </div>
              <ImportStatus state={state} browserName={chosen.name} onRetry={() => void run.run()} />
              <ExtensionImportStatus state={extState} onRetry={() => void run.run()} />
            </>
          )
        )}
      </div>
    )
  }

  if (compact) {
    return (
      <div className="sp-import--compact">
        {explainer}
        {body}
      </div>
    )
  }
  return (
    <>
      <PageHeader title={t('settings.import.title')} description={t('settings.import.description')} />
      <Section note={t('settings.import.note')}>
        {explainer}
        {body}
      </Section>
    </>
  )
}

/** Progress while it runs, then the summary. */
function ImportStatus({ state, browserName, onRetry }: { state: RunState; browserName: string; onRetry(): void }): ReactElement | null {
  const t = useT()
  const list = (counts: ImportSummary['counts']): string =>
    joinList(
      countedTypes(counts).map(({ type, count }) => t(IMPORT_COUNT_LABELS[type], { count })),
      (a, b) => t('settings.import.and', { a, b }),
    )
  if (state.kind === 'idle') return null
  if (state.kind === 'running') {
    const counts = state.progress?.counts ?? {}
    const sofar = list(counts)
    return (
      <div className="sp-import__status" role="status" aria-live="polite">
        <Spinner size={14} />
        <span>
          {t('settings.import.progress', { browser: browserName })}
          {state.progress?.current ? ` · ${t('settings.import.reading')} ${t(IMPORT_TYPE_LABELS[state.progress.current]).toLowerCase()}` : ''}
          {sofar ? ` · ${sofar}` : ''}
        </span>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={onRetry}>{t('settings.retry')}</Button>}>
        {t('settings.import.outcome.error', { browser: browserName })} {state.message}
      </Notice>
    )
  }
  const { summary } = state
  const failures = summary.failed.map((f) => (
    <li key={f.type}>{t('settings.import.failedType', { type: t(IMPORT_TYPE_LABELS[f.type]), message: f.message })}</li>
  ))
  if (summary.outcome === 'error') {
    return (
      <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={onRetry}>{t('settings.retry')}</Button>}>
        {t('settings.import.outcome.error', { browser: browserName })}
        <ul className="sp-import__failures">{failures}</ul>
      </Notice>
    )
  }
  if (summary.outcome === 'partial') {
    return (
      <Notice tone="warning" action={<Button size="sm" variant="secondary" onClick={onRetry}>{t('settings.retry')}</Button>}>
        {t('settings.import.outcome.partial', { list: list(summary.counts) })}
        <ul className="sp-import__failures">{failures}</ul>
      </Notice>
    )
  }
  return (
    <div className="sp-import__status sp-import__status--done" role="status">
      {summary.outcome === 'success' ? <CircleCheck className="sp-icon--positive" aria-hidden /> : <Info aria-hidden />}
      <span>{summary.outcome === 'success' ? t('settings.import.outcome.success', { list: list(summary.counts) }) : t('settings.import.outcome.nothing')}</span>
    </div>
  )
}
