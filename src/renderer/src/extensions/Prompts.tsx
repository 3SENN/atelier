/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Check, Plug, TriangleAlert } from 'lucide-react'
import type { ExtensionInstallPrompt, ExtensionNativePrompt, ExtensionPermission } from '@shared/extensions'
import { t } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { Button, cx } from '../ui'
import { tabbables } from '../ui/layers'
import { trapFocusIndex } from '../ui/logic/keys'
import { ExtensionIcon } from './ExtensionIcon'
import { windowViewport } from '../overlay/host/windowSize'
import './extensions.css'

// The install prompt (OV-16) and the native-messaging prompt: small
// cards over a scrim, answering through the overlay's resolve. The install
// prompt lists what the extension can do in plain words (or that it needs
// nothing extra), and the optional extras it may ask for later; an
// unsupported extension gets an acknowledge-only notice. Esc means no.

function Card({ titleId, onKeyDown, children, exiting, reportBounds }: { titleId: string; onKeyDown(e: KeyboardEvent): void; children: ReactNode; exiting: boolean; reportBounds: SurfaceComponentProps<unknown>['reportBounds'] }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [reportBounds])
  // A modal: Tab and Shift-Tab wrap inside the card.
  const trap = (e: KeyboardEvent): boolean => {
    if (e.key !== 'Tab' || !ref.current) return false
    const items = tabbables(ref.current)
    if (items.length === 0) return false
    const current = items.indexOf(document.activeElement as HTMLElement)
    const atEdge = current === -1 || (e.shiftKey ? current === 0 : current === items.length - 1)
    if (!atEdge) return true
    e.preventDefault()
    items[trapFocusIndex(current, items.length, e.shiftKey)]?.focus()
    return true
  }
  // The safe answer has focus first: Cancel, Don't allow or OK.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])
  return (
    <div className={cx('ext-prompt-scrim', exiting && 'ext-prompt-scrim--exiting')}>
      <div ref={ref} className="ext-prompt" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={(e) => trap(e) || onKeyDown(e)}>
        {children}
      </div>
    </div>
  )
}

function PermissionList({ items }: { items: readonly ExtensionPermission[] }): ReactElement {
  return (
    <ul className="ext-prompt__list">
      {items.map((p) => (
        <li key={p.id}>
          <Check aria-hidden />
          <span>{p.label}</span>
        </li>
      ))}
    </ul>
  )
}

export function InstallPrompt({ props, resolve, exiting, reportBounds, instanceId }: SurfaceComponentProps<{ prompt: ExtensionInstallPrompt }>): ReactElement {
  const { prompt } = props
  const titleId = `ext-install-${instanceId}`
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      resolve(false)
    }
  }
  if (prompt.unsupportedReason) {
    return (
      <Card titleId={titleId} onKeyDown={onKeyDown} exiting={exiting} reportBounds={reportBounds}>
        <div className="ext-prompt__head">
          <span className="ext-prompt__glyph ext-prompt__glyph--warning" aria-hidden>
            <TriangleAlert />
          </span>
          <h2 id={titleId} className="ext-prompt__title">
            {t('extensions.unsupported.title')}
          </h2>
        </div>
        <p className="ext-prompt__name">{prompt.name}</p>
        <p className="ext-prompt__text">{prompt.unsupportedReason}</p>
        <div className="ext-prompt__buttons">
          <Button variant="primary" data-autofocus onClick={() => resolve(false)}>
            {t('extensions.unsupported.ok')}
          </Button>
        </div>
      </Card>
    )
  }
  const optional = prompt.kind === 'optional'
  return (
    <Card titleId={titleId} onKeyDown={onKeyDown} exiting={exiting} reportBounds={reportBounds}>
      <div className="ext-prompt__head">
        <ExtensionIcon ext={prompt} size={32} />
        <h2 id={titleId} className="ext-prompt__title">
          {optional ? t('extensions.optional.title', { name: prompt.name }) : t('extensions.install.title', { name: prompt.name })}
        </h2>
      </div>
      {prompt.permissions.length > 0 ? (
        <>
          <p className="ext-prompt__text">{optional ? t('extensions.optional.body') : t('extensions.install.canDo')}</p>
          <PermissionList items={prompt.permissions} />
        </>
      ) : (
        <p className="ext-prompt__text">{t('extensions.install.nothingExtra')}</p>
      )}
      {!optional && prompt.optional.length > 0 && (
        <>
          <p className="ext-prompt__text ext-prompt__text--muted">{t('extensions.install.later')}</p>
          <PermissionList items={prompt.optional} />
        </>
      )}
      <div className="ext-prompt__buttons">
        <Button variant="secondary" data-autofocus onClick={() => resolve(false)}>
          {optional ? t('extensions.optional.deny') : t('extensions.install.cancel')}
        </Button>
        <Button variant="primary" onClick={() => resolve(true)}>
          {optional ? t('extensions.optional.allow') : t('extensions.install.add')}
        </Button>
      </div>
    </Card>
  )
}

export function NativePrompt({ props, resolve, exiting, reportBounds, instanceId }: SurfaceComponentProps<{ prompt: ExtensionNativePrompt }>): ReactElement {
  const { prompt } = props
  const titleId = `ext-native-${instanceId}`
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      resolve('deny')
    }
  }
  return (
    <Card titleId={titleId} onKeyDown={onKeyDown} exiting={exiting} reportBounds={reportBounds}>
      <div className="ext-prompt__head">
        <span className="ext-prompt__glyph" aria-hidden>
          <Plug />
        </span>
        <h2 id={titleId} className="ext-prompt__title">
          {t('extensions.native.title', { extension: prompt.extensionName, host: prompt.host })}
        </h2>
      </div>
      <p className="ext-prompt__text">{t('extensions.native.body')}</p>
      <div className="ext-prompt__buttons ext-prompt__buttons--three">
        <Button variant="secondary" data-autofocus onClick={() => resolve('deny')}>
          {t('extensions.native.deny')}
        </Button>
        <Button variant="secondary" onClick={() => resolve('once')}>
          {t('extensions.native.once')}
        </Button>
        <Button variant="primary" onClick={() => resolve('always')}>
          {t('extensions.native.always')}
        </Button>
      </div>
    </Card>
  )
}
