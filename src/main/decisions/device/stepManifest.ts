/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-step's optional download (deviceStep.ts): every file with its size and SHA-256, from the atelier-decisions
// project's releases/step-v0.1/MANIFEST.json. The base is the version's tag on Hugging Face, so these files never
// change under it; a new version is a new manifest here.

import type { MiniManifest } from '../deviceMini'

export const STEP_MANIFEST: MiniManifest = {
  version: 'step-v0.1',
  base: 'https://huggingface.co/3SENN/atelier-decisions/resolve/step-v0.1/releases/step-v0.1/model/',
  model: [
    { path: 'model.emb4.int8.onnx', url: 'model.emb4.int8.onnx', size: 54709312, sha256: '1612a88bca2fa048f71ecc5ec58eff406f75e33afd15b6ab8272dd291b582a5d' },
    { path: 'step.json', url: 'step.json', size: 3147, sha256: '604645e05e0479352f17c504d819bca69c2cbac44bb4992422511456c2f7439d' },
    { path: 'tokenizer.json', url: 'tokenizer.json', size: 2235313, sha256: '5a976b6650b911c2f57da96c73c4c93bf388e7cb53eeff65005719e90717ae34' },
    { path: 'tokenizer_config.json', url: 'tokenizer_config.json', size: 46440, sha256: 'ea349495764b24570b4560fe2e4a557e5c0a47e6bce782c2409b1d6445cf8633' },
  ],
  servers: {},
}
