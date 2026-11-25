/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { brandingAlias, brandingDefines, loadBranding } from './scripts/branding.mjs'
import { releaseSettings, viteDefines } from './scripts/release/config.mjs'

// `@engines` is the engines besides the API key (src/engines, docs/architecture.md › Engines).
// `@branding` is the active branding's folder, branding/official or
// branding/unofficial (scripts/branding.mjs; ATELIER_OFFICIAL_BRANDING).
const shared = { '@shared': resolve('src/shared'), '@engines': resolve('src/engines'), ...brandingAlias() }

// RELEASE in src/shared/release.ts; docs/release.md.
// __ATELIER_BRANDING__ is the branding's names, bundle id and default companion (src/shared/branding.ts).
const release = { ...viteDefines(releaseSettings(process.env, process.platform)), ...brandingDefines() }

// The renderer's HTML pages say %BRAND_NAME% where the app's name goes (their titles before the UI sets one).
const brandHtml = { name: 'atelier-branding-html', transformIndexHtml: (html: string): string => html.replaceAll('%BRAND_NAME%', loadBranding().name) }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    define: release,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The pdf.js worker_threads entry, out/main/pdfWorker.js
          pdfWorker: resolve('src/main/pdf/worker.ts'),
          // Query_table's read-only connection runs here, out/main/tablesQueryWorker.js
          tablesQueryWorker: resolve('src/main/tables/queryWorker.ts'),
          // The on-device decision model's utility process, out/main/decisionsDevice.js (src/main/decisions/device.ts)
          decisionsDevice: resolve('src/main/decisions/deviceHelper.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    define: release,
    build: {
      // Both preloads run with `sandbox: true`, so each must be one standalone
      // CommonJS file that requires nothing but `electron`.
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          ui: resolve('src/preload/ui.ts'),
          page: resolve('src/preload/page.ts'),
          // The sandboxed float preload
          float: resolve('src/preload/float.ts'),
          // Registered as a service-worker preload on profile sessions
          extensionWorker: resolve('src/preload/extensionWorker.ts'),
          // The frame preload for extension pages and the Web Store (registered with includeGlobs).
          extensionFrame: resolve('src/preload/extensionFrame.ts'),
          // Sign-in compatibility: the chrome surface, a session frame preload on every browsing session (src/main/chromeSurface.ts).
          chromeSurface: resolve('src/preload/chromeSurface.ts'),
          // Packs (docs/packs.md): window.atelier in each pack's partition, registered as a session frame preload.
          pack: resolve('src/preload/pack.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: shared },
    define: release,
    plugins: [react(), brandHtml],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // The launcher, HUD, meeting card and recording widget
          float: resolve('src/renderer/float.html'),
          // The hidden, sandboxed image preprocessor
          preprocess: resolve('src/renderer/preprocess.html'),
        },
      },
    },
  },
})
