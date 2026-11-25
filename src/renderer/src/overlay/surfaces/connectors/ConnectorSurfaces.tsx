/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, type ReactElement } from 'react'
import type { ConnectorsSurfaceProps } from '@shared/overlay/connectors'
import { AddServerDialog } from '../../../connectors/AddServerDialog'
import { LocalApprovalDialog } from '../../../connectors/LocalApprovalDialog'
import '../../../connectors/connectors.css'
import type { SurfaceComponentProps } from '../../types'
import { windowViewport } from '../../host/windowSize'

// The add custom server dialog (SK-15) and the local server approval (OV-09)
// over the whole window. Add resolves with the saved connectors; the
// approval resolves { approved: true } once main recorded it.

function useFillWindow(reportBounds: (rect: { x: number; y: number; width: number; height: number }) => void): void {
  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [])
}

export function ConnectorAddSurface({ props, resolve, close, reportBounds, exiting }: SurfaceComponentProps<ConnectorsSurfaceProps['connector-add-dialog']>): ReactElement | null {
  useFillWindow(reportBounds)
  return <AddServerDialog open={!exiting} connectorId={props.connectorId} mode={props.mode} onClose={close} onSaved={(result) => resolve(result)} />
}

export function ConnectorLocalApprovalSurface({ props, resolve, close, reportBounds, exiting }: SurfaceComponentProps<ConnectorsSurfaceProps['connector-local-approval']>): ReactElement | null {
  useFillWindow(reportBounds)
  return <LocalApprovalDialog open={!exiting} data={props} onClose={close} onApproved={() => resolve({ approved: true })} />
}
