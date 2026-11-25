/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { ANCHOR_GAP } from '@shared/extensions'
import type { ExtensionsSurfaceProps } from '@shared/overlay/extensions'
import { ExtensionsPopover } from '../../../extensions/ExtensionsPopover'
import { InstallPrompt, NativePrompt } from '../../../extensions/Prompts'
import { MENU_POLICY, MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'

// The extensions surfaces: the popover, and the install and native-messaging prompts.
// The popover is a menu-layer card under the toolbar button; the prompts are
// window modals that stay put across tab switches until answered.

const label = z.string().min(1).max(500)
const permission = z.object({ id: z.string().min(1).max(512), label }).strict()
const icon = z.string().max(1_500_000).nullable()

const popover: SurfaceModule<ExtensionsSurfaceProps['extensions-popover']> = {
  component: ExtensionsPopover,
  props: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  policy: { ...MENU_POLICY, onTabSwitch: 'close' },
  // 4 px under the Extensions button, as the toolbar's own menus sit.
  gap: ANCHOR_GAP,
}

const installPrompt: SurfaceModule<ExtensionsSurfaceProps['extension-install-prompt']> = {
  component: InstallPrompt,
  props: z
    .object({
      prompt: z
        .object({
          id: z.string().uuid(),
          name: z.string().max(200),
          icon,
          permissions: z.array(permission).max(64),
          optional: z.array(permission).max(64),
          unsupportedReason: z.string().max(1000).nullable(),
          kind: z.enum(['install', 'optional']),
        })
        .strict(),
    })
    .strict(),
  policy: { ...MODAL_POLICY, onTabSwitch: 'stay' },
}

const nativePrompt: SurfaceModule<ExtensionsSurfaceProps['extension-native-prompt']> = {
  component: NativePrompt,
  props: z.object({ prompt: z.object({ id: z.string().uuid(), extensionName: z.string().max(200), host: z.string().max(256) }).strict() }).strict(),
  policy: { ...MODAL_POLICY, onTabSwitch: 'stay' },
}

export const EXTENSIONS_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'extensions-popover': popover as unknown as SurfaceModule<never>,
  'extension-install-prompt': installPrompt as unknown as SurfaceModule<never>,
  'extension-native-prompt': nativePrompt as unknown as SurfaceModule<never>,
}
