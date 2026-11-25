/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileDeletionSummary } from '@shared/profiles'

// What goes with a deleted profile (ST-38): sizes and counts read from disk,
// so the summary works before the profile's stores are open.

const MAX_ENTRIES = 50_000

/** A folder's total file size in bytes (symlinks not followed; capped so a huge cache can't stall main). */
export function folderBytes(path: string | null | undefined): number {
  if (!path || !existsSync(path)) return 0
  let total = 0
  let seen = 0
  const stack = [path]
  while (stack.length > 0 && seen < MAX_ENTRIES) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) break
      try {
        const full = join(dir, name)
        const stat = lstatSync(full)
        if (stat.isDirectory()) stack.push(full)
        else if (stat.isFile()) total += stat.size
      } catch {
        // Gone while counting.
      }
    }
  }
  return total
}

/** history.json's entry count (an array of visits), 0 when missing or unreadable. */
export function historyFileCount(dataDir: string): number {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'history.json'), 'utf8'))
    return Array.isArray(raw) ? raw.length : 0
  } catch {
    return 0
  }
}

export const EMPTY_SUMMARY: ProfileDeletionSummary = { tabs: 0, historyEntries: 0, siteDataBytes: 0, ownedChats: 0, ownedCompanions: 0 }

/** Adds counts from several sources; negative or non-finite numbers count as 0. */
export function sumSummaries(parts: readonly Partial<ProfileDeletionSummary>[]): ProfileDeletionSummary {
  const out = { ...EMPTY_SUMMARY }
  for (const part of parts) {
    for (const key of Object.keys(out) as (keyof ProfileDeletionSummary)[]) {
      const n = part[key]
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[key] += Math.round(n)
    }
  }
  return out
}
