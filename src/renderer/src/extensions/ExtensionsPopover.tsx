/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ArrowUpRight, Ellipsis, Pin, PinOff, Settings2 } from 'lucide-react'
import { ANCHOR_GAP, EDGE_MARGIN, EXTENSIONS_SETTINGS_URL, type ExtensionInfo } from '@shared/extensions'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import type { SurfaceComponentProps } from '../overlay/types'
import { ErrorState, IconButton, SkeletonRows, cx } from '../ui'
import { ExtensionBadge, ExtensionIcon } from './ExtensionIcon'
import { useExtensions } from './useExtensions'
import { windowViewport } from '../overlay/host/windowSize'
import './extensions.css'

// The extensions popover (SH-65, routes/55 geometry): an in-window card under
// the toolbar's Extensions button, placed there by its overlay frame like the
// other menus (the module's gap). Every extension is a
// row: a click runs its action; pin or unpin sits on the row; the ⋯ button
// opens Manage, Remove and Report a problem below it. Empty, it points to
// the store. Arrow keys move between rows, Esc closes.

const WIDTH = 340

type Props = SurfaceComponentProps<Record<string, never>>

function rowsOf(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>('[data-ext-row]')] : []
}

export function ExtensionsPopover({ anchor, close, resolve }: Props): ReactElement {
  const { items, loading, error, reload } = useExtensions()
  const card = useRef<HTMLDivElement>(null)
  const [openMore, setOpenMore] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // The frame places the card and sizes the overlay to it; the card only keeps to the room below the
  // button, in the window (not the overlay view, which is only as big as what it shows).
  const rect = anchor.kind === 'window' ? anchor.rect : { x: windowViewport().width - 48, y: 4, width: 32, height: 32 }
  const below = rect.y + rect.height + ANCHOR_GAP
  const maxHeight = Math.max(160, windowViewport().height - below - EDGE_MARGIN)

  // Focus lands on the first row, or the store link when the list is empty.
  useEffect(() => {
    if (loading) return
    const first = rowsOf(card.current)[0] ?? card.current?.querySelector<HTMLElement>('[data-ext-footer]')
    first?.focus()
  }, [loading])

  const act = async (fn: () => Promise<unknown>, done = true): Promise<void> => {
    setFailure(null)
    try {
      await fn()
      if (done) close()
    } catch (err) {
      setFailure(errorText(err))
    }
  }

  const run = (ext: ExtensionInfo): void => {
    if (!ext.enabled || !ext.supported) return void act(() => call('pages', 'open', EXTENSIONS_SETTINGS_URL))
    // The popup anchors under the Extensions button this card hangs from.
    void act(() => call('extensions', 'runAction', ext.id, rect))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (openMore) setOpenMore(null)
      else close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const rows = rowsOf(card.current)
    if (rows.length === 0) return
    e.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length
    rows[next]?.focus()
  }

  return (
    <div
      ref={card}
      className="ext-popover"
      role="dialog"
      aria-label={t('extensions.popover.title')}
      style={{ width: WIDTH, maxHeight }}
      onKeyDown={onKeyDown}
    >
      <h2 className="ext-popover__title">{t('extensions.popover.title')}</h2>
      {loading ? (
        <SkeletonRows rows={3} avatar label={t('extensions.popover.title')} className="ext-popover__body" />
      ) : error ? (
        <ErrorState compact title={t('extensions.settings.loadError')} message={error} onRetry={reload} className="ext-popover__body" />
      ) : items.length === 0 ? (
        <p className="ext-popover__empty">{t('extensions.popover.empty')}</p>
      ) : (
        <ul className="ext-popover__list" role="list">
          {items.map((ext) => (
            <li key={ext.id} className={cx('ext-row', (!ext.enabled || !ext.supported) && 'ext-row--off')}>
              <div className="ext-row__main">
                <button type="button" data-ext-row className="ext-row__run" onClick={() => run(ext)} aria-label={t('extensions.popover.run', { name: ext.name })}>
                  <span className="ext-row__icon">
                    <ExtensionIcon ext={ext} size={20} dimmed={!ext.enabled || !ext.supported} />
                    {ext.badge && <ExtensionBadge badge={ext.badge} />}
                  </span>
                  <span className="ext-row__text">
                    <span className="ext-row__name">{ext.name}</span>
                    {(!ext.enabled || !ext.supported) && <span className="ext-row__note">{ext.supported ? t('extensions.popover.off') : t('extensions.popover.unsupported')}</span>}
                  </span>
                </button>
                {ext.enabled && ext.supported && (
                  <IconButton
                    size="sm"
                    label={ext.pinned ? t('extensions.popover.unpin') : t('extensions.popover.pin')}
                    pressed={ext.pinned}
                    className="ext-row__pin"
                    icon={ext.pinned ? <PinOff /> : <Pin />}
                    onClick={() => void act(() => call('extensions', 'pin', ext.id, !ext.pinned), false)}
                  />
                )}
                <IconButton
                  size="sm"
                  label={t('extensions.popover.more', { name: ext.name })}
                  aria-expanded={openMore === ext.id}
                  aria-controls={`ext-more-${ext.id}`}
                  icon={<Ellipsis />}
                  onClick={() => setOpenMore(openMore === ext.id ? null : ext.id)}
                />
              </div>
              {openMore === ext.id && (
                <div id={`ext-more-${ext.id}`} className="ext-row__more" role="group" aria-label={t('extensions.popover.more', { name: ext.name })}>
                  <button type="button" className="ext-row__action" onClick={() => void act(() => call('pages', 'open', EXTENSIONS_SETTINGS_URL))}>
                    {t('extensions.popover.manage')}
                  </button>
                  {ext.storeUrl && (
                    <button type="button" className="ext-row__action" onClick={() => void act(() => call('extensions', 'report', ext.id))}>
                      {t('extensions.popover.report')}
                    </button>
                  )}
                  <button type="button" className="ext-row__action ext-row__action--danger" onClick={() => resolve({ kind: 'remove', id: ext.id, name: ext.name })}>
                    {t('extensions.popover.remove')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p className="ext-popover__failure" role="alert">
          {failure}
        </p>
      )}
      <div className="ext-popover__footer">
        {items.length === 0 ? (
          <button type="button" data-ext-footer className="ext-popover__link" onClick={() => void act(() => call('extensions', 'openStore'))}>
            {t('extensions.popover.find')}
            <ArrowUpRight aria-hidden />
          </button>
        ) : (
          <button type="button" data-ext-footer className="ext-popover__link" onClick={() => void act(() => call('pages', 'open', EXTENSIONS_SETTINGS_URL))}>
            {t('extensions.popover.manageAll')}
            <Settings2 aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}
