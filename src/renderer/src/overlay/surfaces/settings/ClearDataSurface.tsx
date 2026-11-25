/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, type ReactElement } from 'react'
import type { SettingsSurfaceProps } from '@shared/overlay/settings'
import { ClearDataDialog } from '../../../settings/ClearDataDialog'
import type { SurfaceComponentProps } from '../../types'
import { windowViewport } from '../../host/windowSize'

// ⇧⌘⌫ (ST-36): the clear-browsing-data dialog over the whole window. It
// resolves 'cleared' after a clear, and main's window toast says so.
export function ClearDataSurface({ props, resolve, close, reportBounds, exiting }: SurfaceComponentProps<SettingsSurfaceProps['clear-data']>): ReactElement {
  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [])
  return <ClearDataDialog open={!exiting} range={props.range} toast={false} onClose={close} onDone={() => resolve('cleared')} />
}
