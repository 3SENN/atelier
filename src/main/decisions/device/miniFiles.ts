/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'

// What a usable folder of atelier-mini holds (mini.ts runs it, deviceMini.ts downloads it). Kept apart from mini.ts
// so the main process can check a folder without loading the tokenizer.

/** The model: the GGUF, the readout, the protocol and calibration, the tokenizer (from the training code's student/export_mini.py). */
export const MINI_FILES = ['mini.gguf', 'readout.f32', 'decision.json', 'tokenizer.json', 'tokenizer_config.json'] as const

/** The server: llama.cpp's CPU build for this platform, in server/. */
export const miniServer = (dir: string, platform: NodeJS.Platform = process.platform): string =>
  join(dir, 'server', platform === 'win32' ? 'llama-server.exe' : 'llama-server')
