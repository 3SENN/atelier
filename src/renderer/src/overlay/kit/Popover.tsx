/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { placePopover } from '../../ui/logic/popover'
import { cx } from '../../ui/logic/format'
import type { Box } from './logic'
import { windowViewport } from '../host/windowSize'

// The overlay kit's card (DS-94): white (raised in dark mode), a hairline, a
// soft shadow, radius 12 and 5 px padding. It sits below or above its anchor,
// clamped inside the window, shows only once placed (so it never jumps), and
// appears within a frame with an instant exit (DS-83, --motion-pop). Inside a
// fixed-size overlay frame, the overlay host already placed the frame beside the
// anchor, so the card sits in it as drawn instead of placing itself.

export interface KitPopoverProps {
  /** The anchor in window CSS px. */
  anchor: Box
  side?: 'below' | 'above'
  align?: 'start' | 'end'
  gap?: number
  width?: number
  /** Row height for the menus inside (36 by default; 30 in the main menu). */
  rowHeight?: number
  label: string
  className?: string
  children: ReactNode
  /** Hears the card's placed box (the overlay host sizes its view to it). */
  onBounds?(box: Box): void
}

export const Popover = forwardRef<HTMLDivElement | null, KitPopoverProps>(function Popover({ anchor, side = 'below', align = 'start', gap = 4, width, rowHeight, label, className, children, onBounds }, ref) {
  const box = useRef<HTMLDivElement>(null)
  useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(ref, () => box.current, [])
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [hosted, setHosted] = useState(false)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (el.parentElement?.closest('.ov-frame[data-size="fixed"]')) {
      setHosted(true)
      return
    }
    const measure = (): void => {
      const size = { width: el.offsetWidth, height: el.scrollHeight }
      const at = placePopover(anchor, size, { width: windowViewport().width, height: windowViewport().height }, { gap, align, side })
      setPlace((prev) => (prev && prev.left === at.left && prev.top === at.top && prev.maxHeight === at.maxHeight ? prev : at))
    }
    measure()
    // A search row filtering the list changes the height; keep the card in place and inside the window.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [anchor.left, anchor.top, anchor.width, anchor.height, side, align, gap])

  useLayoutEffect(() => {
    const el = box.current
    if (hosted && el) {
      const r = el.getBoundingClientRect()
      onBounds?.({ left: r.left, top: r.top, width: r.width, height: r.height })
      return
    }
    if (place && el) onBounds?.({ left: place.left, top: place.top, width: el.offsetWidth, height: Math.min(el.scrollHeight, place.maxHeight) })
  })

  // Unplaced cards are transparent rather than hidden, so the list inside can take focus as it mounts.
  const style = (
    hosted
      ? { width, ...(rowHeight ? { '--kit-row': `${rowHeight}px` } : {}) }
      : {
          width,
          left: place?.left ?? 0,
          top: place?.top ?? 0,
          maxHeight: place?.maxHeight,
          ...(place ? {} : { opacity: 0, pointerEvents: 'none' }),
          ...(rowHeight ? { '--kit-row': `${rowHeight}px` } : {}),
        }
  ) as CSSProperties
  return (
    <div ref={box} className={cx('kit-card', hosted && 'kit-card--hosted', className)} style={style} data-kit-card="" data-placed={place || hosted ? '' : undefined} aria-label={label} role="presentation">
      {children}
    </div>
  )
})
