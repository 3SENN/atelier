/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for browser profiles: each profile has its own
// session (cookies, history, site data, extensions, passwords) and colour,
// while companions and chats stay shared. Main's ProfileManager
// (src/main/profiles/**) creates one session per profile and runs every
// Feature.session installer on it.
import { formatSize } from './downloads'
import type { MessageKey, MessageVars } from './i18n/core'
import { DEFAULT_PROFILE_HUE, PROFILE_HUES, profileTokens, type ProfileHue } from './profile'

// profile.ts already holds the hues (ids, labels, base colours); the
// hue id list is PROFILE_HUE_IDS there.
export { PROFILE_HUE_IDS, isProfileHue, type ProfileHue } from './profile'

export interface Profile {
  id: string
  name: string
  hue: ProfileHue
  createdAt: number
  /** 'persist:atelier-web' for the default profile, 'persist:atelier-profile-<id>' for the rest. */
  partition: string
  isDefault: boolean
}

export interface ProfileDeletionSummary {
  tabs: number
  historyEntries: number
  siteDataBytes: number
  ownedChats: number
  ownedCompanions: number
}

export interface ProfilesServices {
  profiles: {
    list(): Profile[]
    /** The profile of the window that asked. */
    current(): Profile
    create(input: { name: string; hue: ProfileHue }): Profile
    rename(id: string, name: string): Profile
    setHue(id: string, hue: ProfileHue): Profile
    /** Opens (or focuses) a window in that profile. */
    switchTo(id: string): void
    deletionSummary(id: string): ProfileDeletionSummary
    /** Needs the profile's name typed exactly; the last profile can't be deleted. */
    remove(id: string, typedName: string): Promise<void>
  }
}

export type ProfilesEvent = { type: 'profiles'; items: Profile[]; currentId: string }

export const DEFAULT_PROFILE_ID = 'default'
export const DEFAULT_PROFILE_PARTITION = 'persist:atelier-web'
export const PROFILE_ID = /^[a-z0-9]{8,32}$/
export const PROFILE_NAME_MAX = 40
export const PROFILES_SETTINGS_URL = 'atelier://settings/profiles'

/** The persistent partition a profile's session lives in. */
export function profilePartition(id: string): string {
  return id === DEFAULT_PROFILE_ID ? DEFAULT_PROFILE_PARTITION : `persist:atelier-profile-${id}`
}

/**
 * The default profile as it exists before the ProfileManager starts (and for
 * data from before profiles): every window, the old partition, the saved hue.
 */
export function defaultProfile(hue: ProfileHue = DEFAULT_PROFILE_HUE, name = ''): Profile {
  return { id: DEFAULT_PROFILE_ID, name, hue, createdAt: 0, partition: DEFAULT_PROFILE_PARTITION, isDefault: true }
}

// Shared by main, which enforces them, and the settings page and dialogs, which explain them

export type ProfileNameProblem = 'empty' | 'long' | 'taken'

/** A name after trimming, or why it can't be used: empty, too long, or another profile's (case-insensitive). */
export function checkProfileName(name: string, profiles: readonly Pick<Profile, 'id' | 'name'>[], selfId?: string): { ok: true; name: string } | { ok: false; problem: ProfileNameProblem } {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (!trimmed) return { ok: false, problem: 'empty' }
  if (trimmed.length > PROFILE_NAME_MAX) return { ok: false, problem: 'long' }
  const lower = trimmed.toLocaleLowerCase()
  if (profiles.some((p) => p.id !== selfId && p.name.trim().toLocaleLowerCase() === lower)) return { ok: false, problem: 'taken' }
  return { ok: true, name: trimmed }
}

export type ProfileDeleteBlock = 'last' | 'default'

/**
 * Why a profile can't be deleted, or null. The last profile always stays, and
 * so does the default one: its data folder is Atelier's own, which also holds
 * the shared companions, chats and library.
 */
export function profileDeleteBlock(id: string, profiles: readonly Pick<Profile, 'id'>[]): ProfileDeleteBlock | null {
  if (profiles.length <= 1) return 'last'
  if (id === DEFAULT_PROFILE_ID) return 'default'
  return null
}

/** The letter a profile's avatar shows: its name's first letter or digit, upper-cased ('?' when it has none). */
export function profileInitial(name: string): string {
  const match = name.trim().match(/[\p{L}\p{N}]/u)
  return match ? match[0].toLocaleUpperCase() : '?'
}

// (the Profiles page and the profile-create and profile-delete dialogs, ST-37 to ST-39;
// pure, so they are tested without a DOM; src/renderer/src/profiles/logic.ts re-exports them)

export interface Message {
  key: MessageKey
  vars?: MessageVars
}

export function nameProblemMessage(problem: ProfileNameProblem): Message {
  return problem === 'long' ? { key: 'profiles.error.long', vars: { max: PROFILE_NAME_MAX } } : { key: `profiles.error.${problem}` }
}

/** The message under a name field, or null while the name is fine. */
export function nameMessage(name: string, profiles: readonly Pick<Profile, 'id' | 'name'>[], selfId?: string): Message | null {
  const checked = checkProfileName(name, profiles, selfId)
  return checked.ok ? null : nameProblemMessage(checked.problem)
}

export function deleteBlockMessage(block: ProfileDeleteBlock): Message {
  return { key: `profiles.block.${block}` }
}

/**
 * The delete dialog's list of what goes (ST-38). Tabs, history and site data
 * always show; companions and chats are shared, so they show only when the
 * profile owns some. Saved passwords, addresses and cards are shared by every
 * profile and stay, so they aren't listed.
 */
export function deletionRows(summary: ProfileDeletionSummary): Message[] {
  const rows: Message[] = [
    { key: 'profiles.delete.tabs', vars: { count: summary.tabs } },
    { key: 'profiles.delete.history', vars: { count: summary.historyEntries } },
    { key: 'profiles.delete.siteData', vars: { size: formatSize(summary.siteDataBytes) } },
  ]
  if (summary.ownedChats > 0) rows.push({ key: 'profiles.delete.chats', vars: { count: summary.ownedChats } })
  if (summary.ownedCompanions > 0) rows.push({ key: 'profiles.delete.companions', vars: { count: summary.ownedCompanions } })
  return rows
}

/** Delete arms only once the name is typed exactly (case and spaces count). */
export function deleteArmed(typed: string, name: string): boolean {
  return typed.length > 0 && typed === name
}

/** The swatch colours in each mode; the swatch is drawn in the same hue the chrome capsule uses. */
export function hueSwatches(): { id: ProfileHue; label: string; light: string; dark: string }[] {
  return PROFILE_HUES.map((h) => ({ id: h.id, label: h.label, light: profileTokens(h.id, 'light').hue, dark: profileTokens(h.id, 'dark').hue }))
}

/** Arrow keys move through a radio group, wrapping; Home and End jump to the ends. */
export function nextHue(current: ProfileHue, key: string): ProfileHue | null {
  const ids = PROFILE_HUES.map((h) => h.id)
  const at = Math.max(0, ids.indexOf(current))
  if (key === 'ArrowRight' || key === 'ArrowDown') return ids[(at + 1) % ids.length]!
  if (key === 'ArrowLeft' || key === 'ArrowUp') return ids[(at - 1 + ids.length) % ids.length]!
  if (key === 'Home') return ids[0]!
  if (key === 'End') return ids[ids.length - 1]!
  return null
}

/** A hue the other profiles don't use yet, for a new profile's starting colour. */
export function freshHue(profiles: readonly Pick<Profile, 'hue'>[]): ProfileHue {
  const used = new Set(profiles.map((p) => p.hue))
  return PROFILE_HUES.find((h) => !used.has(h.id) && h.id !== 'stone')?.id ?? 'moss'
}
