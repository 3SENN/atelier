/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { ADDRESS_FIELD_MAX, GENERATED_LENGTH, PASSWORD_MAX, USERNAME_MAX, type PasswordsServices } from '@shared/passwords'
import { idSchema, originSchema, urlSchema, type SchemaMap } from '../schemas/types'

// Argument schemas for the passwords and wallet services. Security codes
// have no field anywhere: a card with a `cvc` or `csc` key fails `.strict()`.
const token = z.string().uuid()
const column = z.number().int().min(0).max(500).nullable()
const mapping = z.object({ url: column, username: column, password: column }).strict()
const field = z.string().max(ADDRESS_FIELD_MAX)

const address = z
  .object({
    id: idSchema.optional(),
    givenName: field,
    additionalName: field,
    familyName: field,
    organization: field,
    line1: field,
    line2: field,
    line3: field,
    city: field,
    region: field,
    postalCode: z.string().max(32),
    country: z.string().regex(/^([A-Z]{2})?$/),
    email: z.string().max(320),
    tel: z.string().max(40),
    mine: z.boolean().optional(),
  })
  .strict()

const card = z
  .object({
    id: idSchema.optional(),
    number: z.string().regex(/^[0-9 -]{12,23}$/).optional(),
    holder: z.string().trim().max(120),
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2000).max(2100),
  })
  .strict()

export const PASSWORDS_SCHEMAS: SchemaMap<PasswordsServices> = {
  passwords: {
    status: z.tuple([]),
    list: z.tuple([
      z.object({ site: z.string().max(253).optional(), search: z.string().max(200).optional(), sort: z.enum(['site', 'recent']).optional() }).strict().optional(),
    ]),
    unlock: z.tuple([]),
    lock: z.tuple([]),
    reveal: z.tuple([idSchema]),
    copyPassword: z.tuple([idSchema]),
    create: z.tuple([z.object({ url: urlSchema, username: z.string().max(USERNAME_MAX), password: z.string().min(1).max(PASSWORD_MAX) }).strict()]),
    update: z.tuple([idSchema, z.object({ username: z.string().max(USERNAME_MAX).optional(), password: z.string().min(1).max(PASSWORD_MAX).optional() }).strict()]),
    remove: z.tuple([idSchema]),
    neverSaveList: z.tuple([]),
    allowAgain: z.tuple([originSchema]),
    generate: z.tuple([z.number().int().min(GENERATED_LENGTH.min).max(GENERATED_LENGTH.max).optional()]),
    strength: z.tuple([z.string().max(PASSWORD_MAX)]),
    importPick: z.tuple([]),
    importRemap: z.tuple([token, mapping]),
    importConfirm: z.tuple([token, mapping]),
    importCancel: z.tuple([token]),
    openSystemPasswords: z.tuple([]),
    pickSystemExport: z.tuple([]),
    trashFile: z.tuple([token]),
  },
  wallet: {
    addresses: z.tuple([]),
    saveAddress: z.tuple([address]),
    removeAddress: z.tuple([idSchema]),
    setMine: z.tuple([idSchema.nullable()]),
    cards: z.tuple([]),
    saveCard: z.tuple([card]),
    removeCard: z.tuple([idSchema]),
  },
}
