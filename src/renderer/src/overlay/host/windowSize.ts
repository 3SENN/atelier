/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The window's size for overlay surface code: the JavaScript side of viewport.ts's --ov-vw and --ov-vh.

import { hostedSnapshot } from './store'

/** Whether this document is one of the overlay tiers (index.html#overlay=interactive or #overlay=passive). */
function inOverlay(): boolean {
  return typeof location !== 'undefined' && /(^|[#&])overlay=/.test(location.hash.slice(1))
}

/**
 * The window's size in CSS px, for code that places or sizes a surface: the
 * JavaScript side of --ov-vw and --ov-vh. In the overlay, window.innerWidth
 * and innerHeight are the view main sized to the open surfaces (nothing at
 * start, then whatever showed last), so a surface placed or capped by them
 * draws 0 px wide or 2 px tall and is never seen. There the window's size
 * comes from the host's latest message; anywhere else (a kit surface the
 * chrome hosts itself) the document is the window.
 */
export function windowViewport(): { width: number; height: number } {
  if (inOverlay()) {
    let latest: { seq: number; width: number; height: number } | null = null
    for (const i of hostedSnapshot()) {
      const v = i.message.viewport
      if (v && v.width > 0 && v.height > 0 && (!latest || i.seq > latest.seq)) latest = { seq: i.seq, width: v.width, height: v.height }
    }
    if (latest) return { width: latest.width, height: latest.height }
  }
  return { width: window.innerWidth, height: window.innerHeight }
}
