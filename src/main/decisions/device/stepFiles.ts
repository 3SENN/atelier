/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-step's files, apart from its runtime (step.ts), so the main process can check a folder without loading ONNX
// Runtime: only the decision helper does that.

/** The files a usable step model folder holds. */
export const STEP_FILES = ['model.emb4.int8.onnx', 'step.json', 'tokenizer.json', 'tokenizer_config.json'] as const
