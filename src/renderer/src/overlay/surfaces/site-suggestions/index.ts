/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { ANCHOR_GAP } from '@shared/extensions'
import type { SiteSuggestionSurfaceProps } from '@shared/overlay/site-suggestions'
import { SiteSuggestionPopover } from '../../../suggestions/SiteSuggestionPopover'
import { MENU_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'

// Site suggestions (`site-suggestion`, OV-23: the toolbar's site-suggestion
// popover, anchored to its button). Props are in @shared/overlay/site-suggestions.
// A menu-layer card that closes when the tab changes.

const popover: SurfaceModule<SiteSuggestionSurfaceProps['site-suggestion']> = {
  component: SiteSuggestionPopover,
  props: z.object({ tabId: z.string().min(1).max(64), chatId: z.string().min(1).max(128).nullable() }).strict(),
  policy: { ...MENU_POLICY, onTabSwitch: 'close' },
  // 4 px under the toolbar button, as the toolbar's own menus sit.
  gap: ANCHOR_GAP,
}

export const SITE_SUGGESTION_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; the schema checks props at open.
  'site-suggestion': popover as unknown as SurfaceModule<never>,
}
