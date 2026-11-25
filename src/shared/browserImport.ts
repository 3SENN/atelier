/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Importing from another browser (ST-46, ON-03). Main detects
// the browsers and their profiles; Settings › Import and the welcome step
// pick what to bring over and show progress and a summary.

/**
 * What can come over. Passwords come from CSV (ST-41). Saved addresses go
 * into the wallet; cards never come over. Cookies (signed-in sessions) are an
 * explicit opt-in, offered only for Chromium browsers on macOS and never
 * ticked by default; detectBrowsers decides where they show.
 */
export const IMPORT_TYPES = ['bookmarks', 'history', 'tabs', 'searchEngines', 'addresses', 'cookies'] as const
export type ImportType = (typeof IMPORT_TYPES)[number]

export type ImportBrowserKind = 'chromium' | 'firefox' | 'safari'

/**
 * The types each kind of browser always keeps in a form Atelier can read.
 * 'cookies' is left out here on purpose: it depends on the platform (macOS
 * only) and is appended by detectBrowsers, so it never shows elsewhere.
 */
export const BROWSER_TYPES: Readonly<Record<ImportBrowserKind, readonly ImportType[]>> = {
  chromium: ['bookmarks', 'history', 'tabs', 'searchEngines', 'addresses'],
  firefox: ['bookmarks', 'history', 'tabs', 'searchEngines', 'addresses'],
  // Safari keeps addresses in Contacts, not in its own files.
  safari: ['bookmarks', 'history'],
}

/**
 * Ticked when the import panel opens: everything but cookies, which stays an
 * opt-in (another browser's Keychain key, and live sign-ins). Addresses are
 * ticked: reading them needs no prompt and they land in the encrypted wallet.
 */
export const DEFAULT_UNCHECKED_TYPES: readonly ImportType[] = ['cookies']

export interface ImportProfile {
  /** The profile's folder name ('Default', 'Profile 1', a Firefox profile path). */
  id: string
  name: string
}

export interface ImportBrowser {
  id: string
  name: string
  kind: ImportBrowserKind
  profiles: ImportProfile[]
  types: readonly ImportType[]
  /** macOS keeps Safari's files behind Full Disk Access; true until Atelier is allowed. */
  needsAccess: boolean
  /** Chromium browsers: its Web Store extensions can be listed and added again here (ST-46 X). */
  extensions?: boolean
}

export interface ImportRequest {
  browserId: string
  profileId: string
  types: ImportType[]
}

export type ImportCounts = Partial<Record<ImportType, number>>

/** Sent as each type starts and finishes, so the page can show counts as they arrive. */
export interface ImportProgress {
  browserId: string
  /** The type being read now; null once everything is done. */
  current: ImportType | null
  done: ImportType[]
  counts: ImportCounts
}

export type ImportOutcome = 'success' | 'partial' | 'nothing' | 'error'

export interface ImportSummary {
  outcome: ImportOutcome
  counts: ImportCounts
  failed: Array<{ type: ImportType; message: string }>
}

/**
 * The summary's headline: an error when every type failed, partial when some
 * did, nothing found when every type came back empty, and success otherwise.
 */
export function importOutcome(requested: readonly ImportType[], counts: ImportCounts, failed: ReadonlyArray<{ type: ImportType }>): ImportOutcome {
  if (requested.length === 0) return 'nothing'
  if (failed.length >= requested.length) return 'error'
  if (failed.length > 0) return 'partial'
  const total = requested.reduce((sum, type) => sum + (counts[type] ?? 0), 0)
  return total === 0 ? 'nothing' : 'success'
}

// ── Extensions from another browser (ST-46 X) ──
// Chromium browsers keep their extensions' ids in the profile; Atelier lists
// them and adds the chosen ones again from the Chrome Web Store, through the
// same verified install path as the store's own Add button.

/** At most this many extensions in one batch. */
export const EXTENSION_IMPORT_MAX = 100

/** One extension found in another browser's profile. */
export interface ImportableExtension {
  id: string
  name: string
  version: string
  /** On in that browser (an extension it turned off starts unticked). */
  enabled: boolean
  /** From the Chrome Web Store, so Atelier can fetch it; false for other stores and side-loaded ones. */
  onStore: boolean
  /** Already in this Atelier profile. */
  installed: boolean
}

/** The picks from one profile; main reads that profile again, so names and ids come from it, not the page. */
export interface ExtensionImportRequest {
  browserId: string
  profileId: string
  ids: string[]
}

export type ExtensionSkipReason = 'notOnStore' | 'unsupported' | 'installed' | 'declined' | 'failed'

export interface ExtensionImportReport {
  /** The person said no to the confirmation: nothing was fetched. */
  cancelled: boolean
  added: Array<{ id: string; name: string }>
  skipped: Array<{ id: string; name: string; reason: ExtensionSkipReason; message?: string }>
}

/** Ticked when the list opens: on in the other browser, on the store, and not here yet. */
export function defaultExtensionPicks(list: readonly ImportableExtension[]): string[] {
  return list.filter((e) => e.enabled && e.onStore && !e.installed).map((e) => e.id)
}

/** The ones that can be picked at all: on the store and not here yet. */
export function pickableExtension(e: Pick<ImportableExtension, 'onStore' | 'installed'>): boolean {
  return e.onStore && !e.installed
}
