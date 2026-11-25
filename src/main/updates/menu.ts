/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MenuItemModel } from '@shared/menuModel'
import type { UpdateStatus } from '@shared/updates'
import { mainT } from '../i18n/mainT'

// The update menu items: the App menu's update item, the main menu's update
// banner and its Help › Check for Updates row (ids prefixed 'update:'). Every
// item runs the 'check-for-updates' command, whose action follows the state:
// check, download (with consent), restart to install, or try again.
// What's New lives with the diagnostics Help items, which run the 'whats-new' command.

export type UpdateAction = 'check' | 'download' | 'install' | 'none'

export interface UpdateMenuActions {
  check(): void
  download(): void
  install(): void
}

/** Whether update items show at all: unpackaged builds, and unsigned ones that don't announce updates, hide them (ST-56). */
export function updatesVisible(status: UpdateStatus): boolean {
  return status.disabledReason !== 'unpackaged' && status.disabledReason !== 'unsigned'
}

/** What the update item does in this state. */
export function primaryAction(status: UpdateStatus): UpdateAction {
  switch (status.phase) {
    case 'disabled':
    case 'checking':
    case 'downloading':
    case 'installing':
      return 'none'
    case 'ready':
      return 'install'
    case 'idle':
      return status.awaitingConsent ? 'download' : 'check'
    case 'error':
      return 'check'
  }
}

function percent(status: UpdateStatus): number {
  return Math.floor((status.progress ?? 0) * 100)
}

/** The App menu label, per state. */
export function appMenuLabel(status: UpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return mainT('updates.menu.checking')
    case 'downloading':
      return mainT('updates.menu.downloading', { percent: percent(status) })
    case 'ready':
      return mainT('updates.menu.restart')
    case 'installing':
      return mainT('updates.menu.installing')
    case 'error':
      return mainT('updates.menu.failed')
    case 'idle':
      return status.awaitingConsent && status.version ? mainT('updates.menu.download', { version: status.version }) : mainT('updates.menu.check')
    case 'disabled':
      return mainT('updates.menu.check')
  }
}

export function updateAppMenuItem(status: UpdateStatus, _actions?: UpdateMenuActions): MenuItemModel {
  return {
    id: 'update:app',
    label: appMenuLabel(status),
    commandId: 'check-for-updates',
    enabled: primaryAction(status) !== 'none',
  }
}

/** The main menu's banner row: while downloading, ready, failed, waiting for consent, or unsupported. */
export function updateBanner(status: UpdateStatus): MenuItemModel | null {
  if (!updatesVisible(status)) return null
  const base = { id: 'update:banner', commandId: 'check-for-updates' as const, icon: 'circle-arrow-up' }
  switch (status.phase) {
    case 'downloading':
      return { ...base, label: mainT('updates.menu.bannerDownloading', { percent: percent(status) }), enabled: false }
    case 'ready':
      return { ...base, label: mainT('updates.menu.bannerReady') }
    case 'error':
      return { ...base, label: mainT('updates.menu.bannerFailed') }
    case 'installing':
      return { ...base, label: mainT('updates.menu.installing'), enabled: false }
    default:
      break
  }
  if (status.awaitingConsent && status.version) return { ...base, label: mainT('updates.menu.bannerAvailable', { version: status.version }) }
  if (status.unsupported) return { ...base, label: mainT('updates.menu.bannerUnsupported') }
  return null
}

/** The main menu's top-level update rows: the banner (when relevant) and a separator after it. */
export function updateMenuItems(status: UpdateStatus): MenuItemModel[] {
  const banner = updateBanner(status)
  return banner ? [banner, { id: 'update:banner-separator', label: '', type: 'separator' }] : []
}

/** Help › Check for Updates in the main menu; hidden where updates are off for the build. */
export function updateHelpItems(status: UpdateStatus): MenuItemModel[] {
  if (!updatesVisible(status)) return []
  return [{ id: 'update:check', label: appMenuLabel(status), commandId: 'check-for-updates', enabled: primaryAction(status) !== 'none' }]
}

let bound: { status(): UpdateStatus; actions: UpdateMenuActions } | null = null

/** The feature binds the live status and actions; runUpdateMenu dispatches through them. */
export function bindUpdateMenu(source: { status(): UpdateStatus; actions: UpdateMenuActions } | null): void {
  bound = source
}

/** Runs the state's action, as the 'check-for-updates' command does. Returns what it did. */
export function runPrimaryAction(status: UpdateStatus, actions: UpdateMenuActions): UpdateAction {
  const action = primaryAction(status)
  if (action === 'check') actions.check()
  else if (action === 'download') actions.download()
  else if (action === 'install') actions.install()
  return action
}

/** Runs an 'update:' menu item by id; false for ids it doesn't know. */
export function runUpdateMenu(id: string): boolean {
  if (!bound || !id.startsWith('update:') || id === 'update:banner-separator') return false
  runPrimaryAction(bound.status(), bound.actions)
  return true
}
