/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The window's viewport for overlay surface CSS (windowSize.ts has it for code).

/**
 * The window's size for a surface's CSS, as --ov-vw and --ov-vh. The overlay
 * view is only as big as the surfaces it shows, so 100vw and 100vh in here
 * are that view, not the window: a size capped by them shrinks the view,
 * which shrinks the cap again until the surface is drawn 0 px wide and the
 * view hides (the command bar opened but never showed). Surfaces cap
 * themselves with var(--ov-vw) and var(--ov-vh) instead.
 */
export function viewportVars(viewport: { width: number; height: number }): Record<string, string> {
  if (!(viewport.width > 0 && viewport.height > 0)) return {}
  return { '--ov-vw': `${Math.round(viewport.width)}px`, '--ov-vh': `${Math.round(viewport.height)}px` }
}
