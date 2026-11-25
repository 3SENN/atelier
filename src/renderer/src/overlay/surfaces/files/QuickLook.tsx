/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useLayoutEffect, useRef, type ReactElement } from 'react'
import { ExternalLink, X } from 'lucide-react'
import type { FilesSurfaceProps } from '@shared/overlay/files'
import { kindLabelKey } from '@shared/fileKinds'
import { t } from '@shared/i18n/core'
import { errorText, formatBytes } from '../../../api'
import { FilePreview } from '../../../files/preview/FilePreview'
import { openViewer } from '../../../files/open'
import { useViewerDoc } from '../../../files/useViewerDoc'
import { Button, ErrorState, IconButton, SkeletonText, cx, toast } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { windowViewport } from '../../host/windowSize'
import './files.css'

// Quick look: a sheet over the tab with the same renderers as the
// viewer. Space or Esc closes it, Open in tab moves the file to the viewer,
// and its token ends with the sheet.

/** Space closes quick look unless focus sits in something Space works in (a button, a field, a player). */
export function spaceCloses(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  return !target.closest('button, a[href], input, textarea, select, audio, video, [contenteditable="true"], [role="button"], iframe')
}

export function QuickLookSurface({ props, close, resolve, reportBounds, exiting }: SurfaceComponentProps<FilesSurfaceProps['quick-look']>): ReactElement {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const { doc, error, loading, reload } = useViewerDoc(props.target)

  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [])

  useEffect(() => {
    panel.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || (e.key === ' ' && !e.repeat && spaceCloses(e.target))) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const openInTab = (): void => {
    void openViewer(props.target, { name: doc?.name }).then(
      () => resolve({ opened: true }),
      (err: unknown) => toast.show({ tone: 'error', message: errorText(err) }),
    )
  }

  return (
    <div className={cx('ui-modal', 'ui-modal--center', 'fq-surface')} data-state={exiting ? 'closing' : 'open'}>
      <div className="ui-modal__scrim" aria-hidden="true" onClick={close} />
      <div ref={panel} tabIndex={-1} className="ui-modal__panel fq-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="fq-sheet__header">
          <div className="fq-sheet__title">
            <h2 id={titleId}>{doc?.name ?? t('files.viewer.loading')}</h2>
            {doc && doc.state !== 'missing' && (
              <span className="fq-sheet__meta">
                {t(kindLabelKey(doc.previewable))} · {formatBytes(doc.size)}
              </span>
            )}
          </div>
          <Button size="sm" variant="secondary" icon={<ExternalLink />} disabled={!doc && !error} onClick={openInTab}>
            {t('files.action.openInTab')}
          </Button>
          <IconButton size="sm" label={t('files.action.close')} tooltip={false} icon={<X />} onClick={close} />
        </header>
        <div className="fq-sheet__body" aria-label={doc ? t('files.quickLook.label', { name: doc.name }) : undefined}>
          {doc ? (
            <FilePreview compact doc={doc} onRetry={reload} />
          ) : loading ? (
            <div aria-busy="true" aria-label={t('files.viewer.loading')}>
              <SkeletonText lines={6} />
            </div>
          ) : (
            <ErrorState compact title={t('files.viewer.loadFailed')} message={error ?? undefined} onRetry={reload} retryLabel={t('files.action.retry')} />
          )}
        </div>
      </div>
    </div>
  )
}
