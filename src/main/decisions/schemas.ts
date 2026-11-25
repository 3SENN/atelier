/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { DECISION_PRESETS, isProviderId, type DecisionsServices } from '@shared/decisions'

// Services.decisions' arguments (docs/decisions.md), spread by main/services.ts.

const provider = z.string().max(40).refine(isProviderId)
const modelRef = z.object({ provider, model: z.string().trim().min(1).max(120) }).strict()

export const DECISIONS_SCHEMAS: {
  decisions: {
    [M in keyof DecisionsServices['decisions']]: z.ZodType<unknown[]>
  }
} = {
  decisions: {
    status: z.tuple([]),
    setKey: z.tuple([provider, z.string().trim().max(500).nullable()]),
    test: z.tuple([modelRef.optional()]),
    catalog: z.tuple([]),
    comparisons: z.tuple([]),
    clearComparisons: z.tuple([]),
    searchOrAsk: z.tuple([z.string().max(2_000), z.enum(['search', 'ask'])]),
    openKeyPage: z.tuple([z.enum(DECISION_PRESETS)]),
    installMini: z.tuple([]),
    cancelMini: z.tuple([]),
    removeMini: z.tuple([]),
  },
}
