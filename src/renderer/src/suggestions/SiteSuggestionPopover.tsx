/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The toolbar's site-suggestion popover (OV-23, overlay surface
// `site-suggestion`): the same offer as the panel card, hanging under the
// toolbar button (placed there by its overlay frame, like the other menus),
// drafting into the attached chat or a new one. Esc closes; focus starts on
// the first task.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { SiteSuggestionSurfaceProps } from '@shared/overlay/site-suggestions'
import type { SurfaceComponentProps } from '../overlay/types'
import { SuggestionBody } from './SuggestionBody'
import { useSiteSuggestion } from './suggestionData'

const WIDTH = 320

type Props = SurfaceComponentProps<SiteSuggestionSurfaceProps['site-suggestion']>

export function SiteSuggestionPopover({ props, close }: Props): ReactElement | null {
  const suggestion = useSiteSuggestion(props.tabId)
  const box = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    if (suggestion) setSeen(true)
    // The suggestion went away (dismissed, the page changed): the popover goes with it.
    else if (seen) close()
  }, [suggestion, seen])

  useEffect(() => {
    if (suggestion) box.current?.querySelector<HTMLElement>('.pl-suggest__task, button')?.focus()
  }, [suggestion !== null])

  if (!suggestion) return null
  return (
    <div
      ref={box}
      style={{ width: WIDTH }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      }}
    >
      <SuggestionBody suggestion={suggestion} chatId={props.chatId} variant="popover" onDone={close} />
    </div>
  )
}
