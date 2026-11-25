/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState, type ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { RELEASE } from '@shared/release'
import { atelier, call, errorText } from '../api'
import { Notice, Row } from '../settings/kit'
import { Button, Skeleton, Spinner, Switch, cx, useNow } from '../ui'
import { useT } from '../i18n/useT'
import { aboutView, updatesVisible, type AboutButton } from './logic/labels'
import { useUpdateStatus } from './useUpdateStatus'
import './updates.css'

export interface UpdateSectionProps {
  /** The settings page's view and save, when mounted there; otherwise the section reads them itself. */
  settings?: SettingsView
  update?(patch: SettingsPatch): Promise<void>
  /** A muted line under the version (About shows what Atelier runs on). */
  versionDetail?: string | null
}

// The About page's update rows (ST-56): the version and channel with the update status and
// its action, the "Download updates automatically" switch, and where the
// check goes. Unpackaged builds show the version only; an unsigned release
// build (status.manual) checks and links to the download, with no switch.
export function UpdateSection({ settings, update, versionDetail }: UpdateSectionProps): ReactElement {
  const t = useT()
  const status = useUpdateStatus()
  const now = useNow()
  const switchId = useId()
  const [own, setOwn] = useState<SettingsView | null>(null)
  const [deferred, setDeferred] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = settings ?? own

  useEffect(() => {
    if (!settings) void atelier.settings.get().then(setOwn, () => undefined)
  }, [settings])

  // A new ready version (or any other phase) forgets an earlier "Later".
  useEffect(() => {
    if (status?.phase !== 'ready') setDeferred(false)
  }, [status?.phase, status?.version])

  const save = async (patch: SettingsPatch): Promise<void> => {
    setError(null)
    try {
      if (update) await update(patch)
      else setOwn(await atelier.settings.set(patch))
    } catch (err) {
      setError(errorText(err))
    }
  }

  const run = (button: AboutButton): void => {
    setError(null)
    const fail = (err: unknown): void => setError(errorText(err))
    if (button === 'check' || button === 'tryAgain') void call('updates', 'check').catch(fail)
    else if (button === 'download') void call('updates', 'download').catch(fail)
    else if (button === 'restart') void call('updates', 'install').catch(fail)
    else {
      setDeferred(true)
      void call('updates', 'later').catch(fail)
    }
  }

  const versionText = status ? t('updates.about.version', { version: status.currentVersion, channel: RELEASE.channel }) : null
  const visible = updatesVisible(status)
  const about = visible ? aboutView(status, now, deferred) : null

  return (
    <>
      <Row
        id="check-updates"
        anchor="check-updates"
        title={t('updates.about.versionTitle')}
        description={
          <span className="update-section__text">
            {versionText ? <span className="about-version">{versionText}</span> : <Skeleton width={140} height={12} />}
            {versionDetail && <span className="update-section__detail">{versionDetail}</span>}
            {about?.line && (
              <span className={cx('update-section__status', `update-section__status--${about.line.tone}`)} role="status" data-update-line={status?.phase}>
                {about.line.busy && <Spinner size={12} />}
                {about.line.text}
              </span>
            )}
            {about?.line?.detail && <span className="update-section__detail">{about.line.detail}</span>}
            {about?.progress !== null && about?.progress !== undefined && (
              <span className="update-section__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(about.progress * 100)} aria-label={about.line?.text}>
                <span style={{ width: `${Math.round(about.progress * 100)}%` }} />
              </span>
            )}
          </span>
        }
      >
        {about && about.buttons.length > 0 && (
          <span className="update-section__buttons" data-update-section>
            {about.buttons.includes('later') && (
              <Button variant="ghost" size="sm" onClick={() => run('later')}>
                {t('updates.about.later')}
              </Button>
            )}
            {about.buttons.includes('restart') && (
              <Button variant="primary" size="sm" onClick={() => run('restart')}>
                {t('updates.about.restartNow')}
              </Button>
            )}
            {about.buttons.includes('download') && (
              <Button variant="primary" size="sm" onClick={() => run('download')}>
                {t('updates.about.download')}
              </Button>
            )}
            {(about.buttons.includes('check') || about.buttons.includes('tryAgain')) && (
              <Button variant="secondary" size="sm" icon={<RefreshCw size={14} aria-hidden />} loading={status?.phase === 'checking'} onClick={() => run(about.buttons.includes('tryAgain') ? 'tryAgain' : 'check')}>
                {about.buttons.includes('tryAgain') ? t('updates.about.tryAgain') : t('updates.about.check')}
              </Button>
            )}
          </span>
        )}
        {status?.phase === 'checking' && about && about.buttons.length === 0 && (
          <span data-update-section>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={14} aria-hidden />} loading>
              {t('updates.about.check')}
            </Button>
          </span>
        )}
      </Row>
      {visible && status.disabledReason !== 'unsupported-package' && !status.manual && (
        <Row id="auto-download" anchor="auto-download" title={t('updates.about.autoDownload')} description={t('updates.about.autoDownloadBody')} htmlFor={switchId}>
          <span data-update-section>
            <Switch id={switchId} checked={view?.autoDownloadUpdates ?? true} disabled={!view} onChange={(on) => void save({ autoDownloadUpdates: on })} />
          </span>
        </Row>
      )}
      {visible && status.unsupported && (
        <div className="sp-row sp-row--stack">
          <Notice
            tone="warning"
            action={
              <Button size="sm" variant="secondary" onClick={() => void call('updates', status.phase === 'ready' ? 'install' : 'download')}>
                {t('updates.unsupported.updateNow')}
              </Button>
            }
          >
            {status.unsupported.message ?? t('updates.about.unsupported')}
          </Notice>
        </div>
      )}
      {error && (
        <div className="sp-row sp-row--stack">
          <Notice tone="error" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        </div>
      )}
    </>
  )
}

/** The note under About's first card: what an update check reveals. Hidden with the update rows. */
export function UpdatePrivacyNote(): ReactElement | null {
  const t = useT()
  const status = useUpdateStatus()
  if (!updatesVisible(status) || status.disabledReason === 'unsupported-package') return null
  return <>{t('updates.about.privacy')}</>
}
