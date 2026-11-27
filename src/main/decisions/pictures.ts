/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pictures for atelier-vision (docs/decisions.md › Pictures): what Atelier captured or decoded, as the plain pixels the
// decision helper takes. The helper has no image library on purpose: Chromium already decoded everything Atelier shows.

import { createHash } from 'node:crypto'
import type { Picture } from './device/visionPreprocess'

/** The part of Electron's NativeImage this needs (tests pass their own). */
export interface CapturedImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toBitmap(): Buffer
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): CapturedImage
}

/** The longest edge sent to the helper. The model reads 256 x 256; more than this only costs time crossing processes. */
const MAX_EDGE = 768

/**
 * A captured or decoded image as RGB pixels. Electron's bitmap is BGRA at the image's own scale (a capture on a 2x
 * display has four times the pixels its size says), so the scale is read off the buffer's length.
 */
export function pictureOf(image: CapturedImage): Picture | null {
  if (image.isEmpty()) return null
  let { width, height } = image.getSize()
  if (width < 1 || height < 1) return null
  let bitmap = image.toBitmap()
  let scale = Math.round(Math.sqrt(bitmap.length / 4 / (width * height)))
  const tooBig = Math.max(width, height) * scale > MAX_EDGE
  if (scale < 1 || bitmap.length !== width * scale * height * scale * 4 || tooBig) {
    // An odd scale, or more pixels than are worth sending: one plain copy at a known size.
    const k = Math.min(1, MAX_EDGE / Math.max(width, height))
    width = Math.max(1, Math.round(width * k))
    height = Math.max(1, Math.round(height * k))
    bitmap = image.resize({ width, height, quality: 'best' }).toBitmap()
    scale = 1
    if (bitmap.length !== width * height * 4) return null
  }
  const w = width * scale
  const h = height * scale
  const data = new Uint8Array(w * h * 3)
  for (let i = 0, o = 0; i < bitmap.length; i += 4, o += 3) {
    data[o] = bitmap[i + 2] ?? 0
    data[o + 1] = bitmap[i + 1] ?? 0
    data[o + 2] = bitmap[i] ?? 0
  }
  return { data, width: w, height: h, channels: 3 }
}

/** A picture's fingerprint: the same pixels are looked at once (a site's header icons are on every page). */
export function pictureKey(picture: Picture): string {
  return createHash('sha256').update(`${picture.width}x${picture.height}x${picture.channels}:`).update(picture.data).digest('hex')
}
