/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GENERATED_LENGTH, type CsvMapping, type CsvPreview, type PasswordsServices } from '@shared/passwords'
import type { Authenticator } from '../features/personalRuntime'
import { mainT } from '../i18n/mainT'
import type { UnlockWindow } from './auth'
import { buildPreview, mappingComplete, readPasswordCsv, rowsToLogins, guessMapping } from './csvImport'
import type { ImportFiles } from './importFiles'
import { credentialOrigin, generatePassword, passwordStrength, type PasswordVault } from './vault'
import type { WalletStore } from './wallet'

// The passwords and wallet services. The page must be unlocked (Touch
// ID, five minutes) to list, change, reveal or copy logins; revealing or
// copying while locked asks first. Platform calls (file pickers, the
// clipboard, the Trash) are injected, so this is tested without Electron.

export interface PasswordsPlatform {
  /** An open-file sheet for a CSV; the path, or null when cancelled. */
  pickCsv(purpose: 'csv' | 'system'): Promise<string | null>
  /** Passwords.app on macOS 15+, else System Settings › Passwords. */
  openSystemPasswords(): void
  /** Moves the user's own export to the Trash. */
  trash(path: string): Promise<void>
  /** Puts a password on the clipboard and clears it again a minute later if it is still there. */
  copySecret(text: string): void
}

export interface PasswordsServiceDeps {
  vault: PasswordVault
  wallet: WalletStore
  auth: Authenticator
  unlock: UnlockWindow
  files: ImportFiles
  platform: PasswordsPlatform
  /** Sets autofill.passwordsImported after an import that saved something. */
  onImported(): void
}

const isSecure = (url: string): boolean => credentialOrigin(url) !== null

export function createPasswordsServices(deps: PasswordsServiceDeps): PasswordsServices {
  const { vault, wallet, auth, unlock, files, platform } = deps

  const requireUnlocked = (): void => {
    if (!unlock.isUnlocked()) throw new Error(mainT('passwords.error.locked'))
  }

  /** Unlocks with Touch ID (or a fallback). False when you cancel; throws when this computer can't confirm anyone. */
  const unlockNow = async (): Promise<boolean> => {
    if (unlock.isUnlocked()) return true
    const result = await auth.authenticate(mainT('passwords.auth.reason'))
    if (result === 'unavailable') throw new Error(mainT('passwords.auth.unavailable'))
    if (result !== 'ok') return false
    unlock.open()
    return true
  }

  const unlockForSecret = async (): Promise<void> => {
    if (!(await unlockNow())) throw new Error(mainT('passwords.auth.cancelled'))
  }

  const preview = (token: string, fileName: string, text: string, mapping: CsvMapping | null): CsvPreview => {
    const parsed = readPasswordCsv(text)
    if (parsed.columns.length === 0) throw new Error(mainT('passwords.import.error.empty'))
    const chosen = mapping ?? guessMapping(parsed.columns)
    files.setMapping(token, chosen)
    return buildPreview(token, fileName, parsed, chosen, isSecure)
  }

  const openPicked = (path: string | null): CsvPreview | null => {
    if (!path) return null
    const { token, fileName, text } = files.open(path)
    try {
      return preview(token, fileName, text, null)
    } catch (err) {
      files.cancel(token)
      throw err
    }
  }

  const checkMapping = (m: CsvMapping, columns: number): void => {
    for (const index of [m.url, m.username, m.password]) {
      if (index !== null && index >= columns) throw new Error(mainT('passwords.import.error.mapping'))
    }
  }

  return {
    passwords: {
      status: () => ({ count: vault.count(), locked: !unlock.isUnlocked(), unlockedUntil: unlock.until(), available: vault.available() }),
      list: (q) => (unlock.isUnlocked() ? vault.query(q ?? {}) : []),
      unlock: unlockNow,
      lock: () => unlock.lock(),
      reveal: async (id) => {
        await unlockForSecret()
        return vault.reveal(id)
      },
      copyPassword: async (id) => {
        await unlockForSecret()
        platform.copySecret(vault.reveal(id))
      },
      create: (input) => {
        requireUnlocked()
        const decision = vault.decide(input.url, input.username, input.password)
        if (!decision) throw new Error(mainT('passwords.error.insecure'))
        if (decision.kind !== 'new') throw new Error(mainT('passwords.error.exists'))
        return vault.save(input.url, input.username, input.password)
      },
      update: (id, patch) => {
        requireUnlocked()
        return vault.update(id, patch)
      },
      remove: (id) => {
        requireUnlocked()
        vault.remove(id)
      },
      neverSaveList: () => (vault.available() ? vault.neverSaveList() : []),
      allowAgain: (origin) => vault.allowAgain(origin),
      generate: (length) => generatePassword(length ?? GENERATED_LENGTH.default),
      strength: (password) => passwordStrength(password),
      importPick: async () => openPicked(await platform.pickCsv('csv')),
      importRemap: (token, mapping) => {
        const { text, fileName } = files.read(token)
        const parsed = readPasswordCsv(text)
        checkMapping(mapping, parsed.columns.length)
        return preview(token, fileName, text, mapping)
      },
      importConfirm: (token, mapping) => {
        const { text } = files.read(token)
        const parsed = readPasswordCsv(text)
        checkMapping(mapping, parsed.columns.length)
        if (!mappingComplete(mapping, parsed.columns.length)) throw new Error(mainT('passwords.import.error.mapping'))
        const report = vault.importLogins(rowsToLogins(parsed.rows, mapping))
        files.finish(token)
        if (report.added + report.updated + report.same > 0) deps.onImported()
        return report
      },
      importCancel: (token) => files.cancel(token),
      openSystemPasswords: () => platform.openSystemPasswords(),
      pickSystemExport: async () => openPicked(await platform.pickCsv('system')),
      trashFile: async (token) => {
        const source = files.source(token)
        if (!source) throw new Error(mainT('passwords.import.error.ended'))
        files.finish(token)
        await platform.trash(source)
        files.forget(token)
      },
    },
    wallet: {
      addresses: () => wallet.addresses(),
      saveAddress: (a) => wallet.saveAddress(a),
      removeAddress: (id) => wallet.removeAddress(id),
      setMine: (id) => wallet.setMine(id),
      cards: () => wallet.cards(),
      saveCard: (c) => wallet.saveCard(c),
      removeCard: (id) => wallet.removeCard(id),
    },
  }
}
