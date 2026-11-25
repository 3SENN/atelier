/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, type ReactElement } from 'react'
import type { WorkspaceSurfaceProps } from '@shared/overlay/workspace'
import { FolderAccessDialog } from '../../../workspace/FolderAccessDialog'
import type { SurfaceComponentProps } from '../../types'
import { windowViewport } from '../../host/windowSize'

// CH-43 over the whole window: the access prompt for a picked folder. It
// resolves with the granted WatchedFolder, or null when cancelled.
export function FolderAccessSurface({ props, resolve, reportBounds, exiting }: SurfaceComponentProps<WorkspaceSurfaceProps['folder-access']>): ReactElement | null {
  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [])
  if (exiting) return null
  return <FolderAccessDialog path={props.path} chatId={props.chatId} onClose={(folder) => resolve(folder)} />
}
