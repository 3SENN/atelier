/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useLayoutEffect, useRef, type ReactElement } from 'react'
import { X } from 'lucide-react'
import { t } from '@shared/i18n/core'
import { PasteBody } from '../../../chat/composer/PastePreview'
import '../../../chat/composer/composer.css'
import { IconButton, cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { windowViewport } from '../../host/windowSize'

// The paste preview as an overlay surface (CH-24): a scrim over the whole
// window, page included, with the same body as the in-window dialog. Esc
// and the close button dismiss it; the composer hears the result.

export function PasteSurface({ props, resolve, close, reportBounds, exiting }: SurfaceComponentProps<{ chatId: string; attachmentId: string }>): ReactElement {
  const titleId = useId()
  const card = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <div className={cx('ui-modal', 'ui-modal--center', 'cmp-paste-surface')} data-state={exiting ? 'closing' : 'open'}>
      <div className="ui-modal__scrim" aria-hidden="true" onClick={close} />
      <div ref={card} className="ui-modal__panel ui-dialog ui-dialog--lg cmp-paste-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="ui-dialog__header">
          <h2 id={titleId} className="ui-dialog__title">{t('composer.paste.title')}</h2>
          <IconButton label={t('composer.paste.close')} tooltip={false} size="sm" icon={<X />} onClick={close} className="ui-dialog__close" />
        </header>
        <div className="ui-dialog__body">
          <PasteBody chatId={props.chatId} attachmentId={props.attachmentId} onDone={(result) => (result ? resolve(result) : close())} />
        </div>
      </div>
    </div>
  )
}
