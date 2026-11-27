/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { t } from '@shared/i18n/core'
import type { UpdateStatus } from '@shared/updates'
import { formatRelative } from '../../ui/logic/time'

// What the update pill and About's update section show for a status. Pure,
// so every state's wording is unit-tested; the components only draw it.

/** Unpackaged builds, and unsigned ones that don't announce updates, hide every update control (ST-56). */
export function updatesVisible(status: UpdateStatus | null): status is UpdateStatus {
  return status !== null && status.disabledReason !== 'unpackaged' && status.disabledReason !== 'unsigned'
}

export function percentOf(status: UpdateStatus): number {
  return Math.floor(Math.min(1, Math.max(0, status.progress ?? 0)) * 100)
}

export type PillKind = 'downloading' | 'available' | 'ready' | 'installing' | 'failed'

/** Which pill the footer shows, or null for none. */
export function pillKind(status: UpdateStatus | null): PillKind | null {
  if (!updatesVisible(status) || status.phase === 'disabled') return null
  switch (status.phase) {
    case 'downloading':
      return 'downloading'
    case 'ready':
      return 'ready'
    case 'installing':
      return 'installing'
    case 'error':
      return 'failed'
    case 'idle':
      return status.awaitingConsent && status.version ? 'available' : null
    default:
      return null
  }
}

export function pillLabel(kind: PillKind, status: UpdateStatus): string {
  switch (kind) {
    case 'downloading':
      return t('updates.pill.downloading', { percent: percentOf(status) })
    case 'available':
      return t('updates.pill.available')
    case 'ready':
      return t('updates.pill.ready')
    case 'installing':
      return t('updates.pill.installing')
    case 'failed':
      return t('updates.pill.failed')
  }
}

/** The pill's tooltip and accessible description. */
export function pillHint(kind: PillKind, status: UpdateStatus): string {
  const version = status.version ?? ''
  switch (kind) {
    case 'downloading':
      return t('updates.pill.downloadingHint', { version })
    case 'available':
      return t(status.manual ? 'updates.pill.availableManualHint' : 'updates.pill.availableHint', { version })
    case 'ready':
      return t('updates.pill.readyHint', { version })
    case 'installing':
      return t('updates.about.installing')
    case 'failed':
      return t('updates.pill.failedHint', { message: status.error?.message ?? t('updates.error.unknown') })
  }
}

export type UpdateClick = 'install' | 'download' | 'check' | 'none'

/** What a click on the pill (or the About row's button) does. */
export function clickAction(status: UpdateStatus): UpdateClick {
  switch (status.phase) {
    case 'ready':
      return 'install'
    case 'error':
      return 'check'
    case 'idle':
      return status.awaitingConsent ? 'download' : 'check'
    default:
      return 'none'
  }
}

export type AboutButton = 'check' | 'tryAgain' | 'download' | 'restart' | 'later'

export interface AboutView {
  /** The status line under the version; null when there is nothing to say yet. */
  line: { text: string; detail: string | null; tone: 'muted' | 'success' | 'error' | 'accent'; busy: boolean } | null
  buttons: AboutButton[]
  /** 0..1 while downloading. */
  progress: number | null
}

/** About's update row for a status (only called when updatesVisible). */
export function aboutView(status: UpdateStatus, now: number, deferred = false): AboutView {
  const version = status.version ?? ''
  if (status.disabledReason === 'unsupported-package') return { line: { text: t('updates.about.packageManager'), detail: null, tone: 'muted', busy: false }, buttons: [], progress: null }
  switch (status.phase) {
    case 'checking':
      return { line: { text: t('updates.about.checking'), detail: null, tone: 'muted', busy: true }, buttons: [], progress: null }
    case 'downloading':
      return { line: { text: t('updates.about.downloading', { version, percent: percentOf(status) }), detail: null, tone: 'muted', busy: false }, buttons: [], progress: status.progress ?? 0 }
    case 'ready':
      if (deferred) return { line: { text: t('updates.about.ready'), detail: t('updates.about.deferred', { version }), tone: 'accent', busy: false }, buttons: ['restart'], progress: null }
      return { line: { text: t('updates.about.ready'), detail: t('updates.about.readyBody', { version }), tone: 'accent', busy: false }, buttons: ['restart', 'later'], progress: null }
    case 'installing':
      return { line: { text: t('updates.about.installing'), detail: null, tone: 'muted', busy: true }, buttons: [], progress: null }
    case 'error': {
      const e = status.error
      const failedCheck = e?.kind === 'network' || status.lastCheck === 'failed'
      const retry = e?.retryAt ? ` ${t('updates.error.retrying', { time: formatRelative(e.retryAt, now) })}` : ''
      return {
        line: { text: failedCheck ? t('updates.about.failed') : (e?.message ?? t('updates.error.unknown')), detail: failedCheck ? `${e?.message ?? ''}${retry}`.trim() || null : null, tone: 'error', busy: false },
        buttons: ['tryAgain'],
        progress: null,
      }
    }
    case 'idle':
      if (status.awaitingConsent && status.version) {
        return { line: { text: t('updates.about.available', { version }), detail: status.manual ? t('updates.about.availableManual') : null, tone: 'accent', busy: false }, buttons: ['download'], progress: null }
      }
      if (status.lastCheck === 'up-to-date' && status.checkedAt !== null) {
        return { line: { text: t('updates.about.upToDate'), detail: t('updates.about.checkedAt', { time: formatRelative(status.checkedAt, now) }), tone: 'success', busy: false }, buttons: ['check'], progress: null }
      }
      return { line: null, buttons: ['check'], progress: null }
    case 'disabled':
      return { line: null, buttons: [], progress: null }
  }
}
