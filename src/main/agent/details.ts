/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AddressView } from '@shared/passwords'
import type { PersonDetails } from './prompt'

function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** Your details for a new chat's prompt (Settings › You), from the wallet's address marked as yours. */
export function personDetails(mine: AddressView | null): PersonDetails | null {
  if (!mine) return null
  const name = [mine.givenName, mine.additionalName, mine.familyName].map((s) => s.trim()).filter(Boolean).join(' ')
  // English names (the prompt is English), with the code the person saved.
  const country = mine.country ? `${regionName(mine.country)} (${mine.country})` : ''
  const place = [mine.postalCode, mine.city].map((s) => s.trim()).filter(Boolean).join(' ')
  const address = [mine.line1, mine.line2, mine.line3, place, mine.region, country].map((s) => s.trim()).filter(Boolean).join(', ')
  const out = { name, organization: mine.organization.trim(), email: mine.email.trim(), tel: mine.tel.trim(), address }
  return Object.values(out).some(Boolean) ? out : null
}
