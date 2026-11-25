/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement } from 'react'
import { FLIGHT_MAX_MS, flightDuration, flightFrames, type DownloadFlightProps } from '@shared/downloads'
import { motionReduced } from '../../../../ui'
import type { SurfaceComponentProps } from '../../../types'
import { FileKindIcon } from '../downloads/FileKindIcon'
import { windowViewport } from '../../../host/windowSize'
import '../downloads/downloads.css'

// The fly-to-button cue (OV-19), in the passive, click-through tier: the
// file-type icon flies along a curve from the page to the downloads button
// and ends in a small bounce. At most two seconds; several can fly at once.
// Skipped under reduced motion, and cancelled when the window hides, moves
// or changes size or full screen (the child window follows the parent).

const TILE = 28

export function DownloadFlight({ props, close, reportBounds }: SurfaceComponentProps<DownloadFlightProps>): ReactElement {
  const tile = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = tile.current
    if (!el || motionReduced() || document.hidden) {
      close()
      return
    }
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
    const frames = flightFrames(props.from, props.to).map((f) => ({
      offset: f.offset,
      opacity: f.opacity,
      transform: `translate(${f.x - TILE / 2}px, ${f.y - TILE / 2}px) scale(${f.scale})`,
    }))
    const animation = el.animate(frames, { duration: flightDuration(props.from, props.to), easing: 'linear', fill: 'forwards' })
    const start = { x: window.screenX, y: window.screenY, w: windowViewport().width, h: windowViewport().height }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      animation.cancel()
      close()
    }
    animation.onfinish = finish
    let frame = 0
    const watch = (): void => {
      if (window.screenX !== start.x || window.screenY !== start.y || windowViewport().width !== start.w || windowViewport().height !== start.h) return finish()
      frame = requestAnimationFrame(watch)
    }
    frame = requestAnimationFrame(watch)
    // A hidden view runs no frames, so a timer makes sure the cue never outlives its budget.
    const timeout = setTimeout(finish, FLIGHT_MAX_MS + 250)
    const onHidden = (): void => {
      if (document.hidden) finish()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('resize', finish)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timeout)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('resize', finish)
      done = true
      animation.cancel()
    }
  }, [])

  return (
    <div className="dl-flight" aria-hidden>
      <div ref={tile} className="dl-flight__tile" style={{ width: TILE, height: TILE, opacity: 0 }}>
        <FileKindIcon kind={props.kind} className="dl-flight__icon" />
      </div>
    </div>
  )
}
