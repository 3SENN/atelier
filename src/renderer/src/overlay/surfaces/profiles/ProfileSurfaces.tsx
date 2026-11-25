/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, type ReactElement } from 'react'
import type { ProfilesSurfaceProps } from '@shared/overlay/profiles'
import { CreateProfileDialog, DeleteProfileDialog } from '../../../profiles/ProfileDialogs'
import type { SurfaceComponentProps } from '../../types'
import { windowViewport } from '../../host/windowSize'

// The create and delete profile dialogs over the whole window (ST-38, ST-39).
// Create resolves with the new profile's id (main opens its window); delete
// resolves 'deleted' once the profile and its data are gone.

function useFillWindow(reportBounds: (rect: { x: number; y: number; width: number; height: number }) => void): void {
  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [])
}

export function ProfileCreateSurface({ resolve, close, reportBounds, exiting }: SurfaceComponentProps<ProfilesSurfaceProps['profile-create']>): ReactElement {
  useFillWindow(reportBounds)
  return <CreateProfileDialog open={!exiting} onClose={close} onCreated={(profile) => resolve({ id: profile.id, name: profile.name })} />
}

export function ProfileDeleteSurface({ props, resolve, close, reportBounds, exiting }: SurfaceComponentProps<ProfilesSurfaceProps['profile-delete']>): ReactElement {
  useFillWindow(reportBounds)
  return <DeleteProfileDialog open={!exiting} profileId={props.profileId} onClose={close} onDeleted={(profile) => resolve({ deleted: profile.id, name: profile.name })} />
}
