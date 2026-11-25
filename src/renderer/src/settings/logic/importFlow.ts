/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Import and the welcome step (ST-46, ON-03): which
// browser and types start chosen, and how a summary reads. Pure, so tested.
import { DEFAULT_UNCHECKED_TYPES, IMPORT_TYPES, type ImportBrowser, type ImportCounts, type ImportType } from '@shared/browserImport'
import type { MessageKey } from '@shared/i18n/core'

export const IMPORT_TYPE_LABELS: Record<ImportType, MessageKey> = {
  bookmarks: 'settings.import.type.bookmarks',
  history: 'settings.import.type.history',
  tabs: 'settings.import.type.tabs',
  searchEngines: 'settings.import.type.searchEngines',
  addresses: 'settings.import.type.addresses',
  cookies: 'settings.import.type.cookies',
}

export const IMPORT_COUNT_LABELS: Record<ImportType, MessageKey> = {
  bookmarks: 'settings.import.count.bookmarks',
  history: 'settings.import.count.history',
  tabs: 'settings.import.count.tabs',
  searchEngines: 'settings.import.count.searchEngines',
  addresses: 'settings.import.count.addresses',
  cookies: 'settings.import.count.cookies',
}

/** The browser to start on: the one asked for (?browser=), else the first that can be read now. */
export function initialBrowser(browsers: readonly ImportBrowser[], wanted: string | null): ImportBrowser | null {
  return browsers.find((b) => b.id === wanted) ?? browsers.find((b) => !b.needsAccess) ?? browsers[0] ?? null
}

/** Every type the browser keeps starts ticked, in the standard order — except opt-ins like cookies. */
export function defaultTypes(browser: Pick<ImportBrowser, 'types'> | null): ImportType[] {
  if (!browser) return []
  return IMPORT_TYPES.filter((t) => browser.types.includes(t) && !DEFAULT_UNCHECKED_TYPES.includes(t))
}

export function toggleType(types: readonly ImportType[], type: ImportType, on: boolean, allowed: readonly ImportType[]): ImportType[] {
  const next = new Set(types)
  if (on) next.add(type)
  else next.delete(type)
  return IMPORT_TYPES.filter((t) => next.has(t) && allowed.includes(t))
}

/** The types with a count above zero, in order, for the summary's list. */
export function countedTypes(counts: ImportCounts): Array<{ type: ImportType; count: number }> {
  return IMPORT_TYPES.flatMap((type) => {
    const count = counts[type] ?? 0
    return count > 0 ? [{ type, count }] : []
  })
}

/** "a, b and c" from already-translated parts; `and` joins the last two. */
export function joinList(parts: readonly string[], and: (a: string, b: string) => string): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0] ?? ''
  return and(parts.slice(0, -1).join(', '), parts[parts.length - 1] ?? '')
}

/** Profiles worth a picker: only when there is more than one. */
export function needsProfilePicker(browser: Pick<ImportBrowser, 'profiles'> | null): boolean {
  return (browser?.profiles.length ?? 0) > 1
}
