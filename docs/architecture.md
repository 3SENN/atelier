# Atelier architecture

Atelier is an Electron browser with a built-in companion (Pip in official builds) that works in your real tabs. This document covers how Atelier is put together, the reasons behind the main decisions, and where each feature area stands.

## Processes and layers

```
main process (src/main)
 ├─ index.ts           bootstrap: sandbox, popup policy, stores, services, routines
 ├─ tabs.ts            TabManager: WebContentsViews, atelier:// pages, split panes, find results
 ├─ peek.ts            floating link preview above the page
 ├─ downloads.ts       saves to Downloads, tracks progress, reports to the agent
 ├─ importer.ts        bookmarks and history from Chrome, Arc, Brave, Edge, Vivaldi, Firefox
 ├─ importExtensions.ts  another Chromium profile's Web Store extensions (Preferences, Secure Preferences, Extensions/) and batch or single store installs (the batch confirmation lists each one's access from its local manifest; a store version asking for more gets the store's prompt); importExtensionsStore.ts wires them to the extensions host's verified installPackage (ST-46 X, ST-40 R)
 ├─ stores.ts          bookmarks, skills, routines, connectors (tokens encrypted), companion, chats
 ├─ memory.ts          the agent's memory directory (SDK memory backend + Library editor)
 ├─ routines.ts        scheduler for routines (background chats without browser control)
 ├─ services.ts        one validated invoke channel for all feature services
 ├─ ipc.ts             core UI channels (tabs, navigation, layout, agent, settings)
 ├─ pageBridge.ts      request/response channel to the agent preload in a tab
 ├─ input.ts           trusted input through the Chrome DevTools Protocol
 ├─ agent/
 │   ├─ session.ts     conversation loop, chat snapshots, tool routing, persistence
 │   ├─ browserTool.ts executor for browser_toolset_20260801, plus the tool-call runner
 │   ├─ schemas.ts     Zod schemas for each browser member
 │   ├─ guard.ts       detects consequential actions
 │   ├─ prompt.ts      system prompt, built once per chat
 │   ├─ quick.ts       QuickModel: the one path for every one-shot model call, on any engine
 │   └─ host.ts        one session per chat, tab ownership, routines
 ├─ engines/           what runs a chat's model turns (ST-58 to ST-60)
 │   ├─ backend.ts     the AgentBackend seam between a chat and its engine
 │   ├─ extras.ts      the engines besides the API key (`@engines/main`, src/engines)
 │   └─ service.ts     engine status, the local MCP server, outside access
 ├─ system/shell.ts    the person's shell: where a program is, the PATH a terminal has, short commands
 ├─ mcp/               Atelier's local browser-tools MCP server (loopback HTTP, bearer secrets)
 ├─ appProtocol.ts     app://atelier/ serves the UI with a strict CSP
 ├─ permissions.ts     camera, microphone, location etc.: asks the user, remembered per origin for the session
 ├─ adblock.ts         Ghostery engine, cached on disk
 ├─ history.ts         history, omnibox ranking, import merging
 ├─ settings.ts        settings; API key encrypted with safeStorage
 ├─ firstWeek*.ts      the getting-started plan (atelier://first-week): its store, starters and setup
 └─ menu.ts            browser shortcuts as menu accelerators
preload/ui.ts          window.atelier for the chrome only (typed by src/shared/api.ts)
preload/page.ts        agent bridge in every tab, isolated world, exposes nothing to pages
renderer/              React chrome: tabs, omnibox, bars, panes, peek, agent panel, atelier:// pages
renderer/companion/    companion runtime: assembles generated parts, face layer, clips, mood engine
shared/                IPC and service contracts, URL rules
```

The chrome UI is the BrowserWindow's own webContents, in the default session. Each tab is a `WebContentsView` with rounded corners, layered above the UI in its own persistent session (`persist:atelier-web`). The UI measures the panes (one, or two in split view) and the peek frame, and main places native views over them.

**Internal pages** (`atelier://library`, `history`, `bookmarks`, `downloads`, `settings`, `welcome`) and the new-tab page are drawn by the chrome. The tab's view is simply hidden, and the agent refuses to act on these pages.

**Overlays:** native views always draw above the window's UI. While omnibox suggestions or a peek are open, the page view is hidden. Each reason to hide is tracked separately, so one closing doesn't reveal the page while another still needs it covered. Layering small overlay views above the page remains an option for richer menus.

### Feature modules

Each feature folder in `src/main` owns its zod schemas (`schemas.ts`), its service (registered through `services.ts` or `features/*`), and its smoke checks (a smoke group folder such as `smokeBrowser` or `smokeMaintenance`, or the feature's own `smoke.ts`).

```
src/main
 ├─ overlayHost.ts, overlayState.ts, passiveLayer.ts   the overlay view's interactive and passive tiers: menus, popovers, tooltips, toasts, prompts above pages
 ├─ schemas/            zod contracts for tabs, address, menus, dialogs, sites and settings IPC
 ├─ tabGroups.ts, tabSleep.ts, tabRegistry.ts, tearOff.ts, sessionRestore.ts   groups, sleeping tabs, windows, tab tear-off, restore
 ├─ menuRebuild.ts, dockMenu.ts, pageMenu.ts, linkMenu.ts   native menus rebuilt from live state
 ├─ siteInfo.ts, siteData.ts, certificates.ts, permissionPolicy.ts, popupPolicy.ts, privacy.ts, clearData.ts   site safety, per-site settings and privacy controls
 ├─ privacy/            the privacy pack (PV-01 to PV-04): HTTPS-First as a registered mux layer with its fallback page (httpsFirst.ts; sitesSafety asks it on did-fail-load; ipc.ts's navigate registers typed bare hosts so a failed https offers http), per-profile exceptions, Atelier's built-in cookie-banner list as a user stylesheet plus an isolated-world Reject press, optional downloaded lists read by Ghostery's parser (cookieLists.ts), and the site info summary; smoke is ATELIER_SMOKE_ONLY=PRIVACY
 ├─ pageDialogs.ts, dialogQueue.ts, screenShare.ts, devices.ts   styled page dialogs and the device and screen pickers
 ├─ viewSource.ts, linkPreview.ts, zoomController.ts, uiZoom.ts, forceDark.ts   developer and reading conveniences
 ├─ profiles/           profiles, their paths, window binding and scope rules
 ├─ system/             tray, login item, default browser, second instance, Linux helpers
 ├─ passwords/          keychain-encrypted vault, wallet (cards without CVC), CSV import, Touch ID gate
 ├─ autofill/           login detection, save prompts, the autofill dropdown and field masking
 ├─ speech/, voice/     the native speech broker, push-to-talk, the quick-ask launcher and voice routing; the broker also relays the helper's `prepare`/`assets` lines (the newer engine's model per language) and its `watch-calls` → `calls` snapshots
 ├─ meetings/           meeting detection, capture, transcripts, summaries and export; capture/desktopCalls.ts turns the helper's call snapshots into calls in desktop apps (MV-09a: 3 s of microphone to start, 1.5 s gaps ridden out, 20 s or app quit to end, Atelier's processes left out), offered on the meeting card and recorded with only that app's sound
 ├─ float/              floating windows (launcher, voice HUD, meeting card, recording) with per-kind method access
 ├─ extensions/         Web Store install, CRX verification, the adapter over session.extensions, popups, native messaging, the API shims (privacy, webNavigation, declarativeContent, contextMenus, windows, storage.sync) and Apple Passwords
 ├─ intake/             attachments: detection, EXIF removal, downscaling, office and PDF text, per-chat file store
 ├─ pdf/                PDF text extraction in a worker
 ├─ artifacts/          sandboxed artifact tabs for HTML, SVG, images and files
 ├─ files/              Library › Files, the confined file protocol and the viewer
 ├─ connectors/         remote and local (stdio) MCP connectors, OAuth, the connector directory
 ├─ workspace/          projects, watched folders, the search index, versions, Recently Deleted, spaces
 ├─ activity/           opt-in activity memory with its schedule, pause and notes
 ├─ timeline/           visits, sessions and site insights from local history
 ├─ tables/             the Tables workspace: CSV import, SQLite store, a guarded query worker
 ├─ apps/               agent-built Apps as sandboxed HTML, plus calendar tools
 ├─ routines/, skills/  cron schedules, run history, suggested routines, built-in skills
 ├─ conversationImport/ importing ChatGPT or Claude conversation exports
 ├─ guides/, help/      the Guides library and the built-in help pages
 ├─ tidy.ts, memoryJobs.ts, spend.ts   Tidy memory, memory build and reorganize jobs, monthly spend on your own key
 ├─ diagnostics/        rotating redacted logs, crash capture, problem reports as an email draft
 ├─ updates/            the update state machine over electron-updater, backoff, What's new
 ├─ migrations/         versioned files, chat schema steps, backups and the migration notice
 ├─ i18n/               mainT() and early locale setup for the main process
 ├─ native/             haptics and lid events through the optional native addon
 ├─ packs/              packs (docs/packs.md, PK-01 to PK-15): manifest validation, .atelierpack archives and Ed25519 signing, the store (installed, drafts, storage, logs), the atelier-pack:// sandbox, the window.atelier bridge, the tool host, the contribution sync into skills, site tweaks, accents, client tools, the command bar and the page menu, sharing and updates, the companion builder tools, the first-party packs and a smoke group (ATELIER_SMOKE_ONLY=PACKS)
 ├─ tweaks/             site tweaks (TWK-01 to TWK-06): per-site hidden elements, style, custom CSS and isolated-world scripts in tweaks.json; the page preload asks for its rules at document start (PAGE.tweaks, sendSync) and gets changes pushed (PAGE.tweaksPush), CSS through webFrame.insertCSS; never on sign-in or atelier:// pages; JSON export and import with scripts off; files from before the rename still read (schemas.ts)
 ├─ reader/             the reader (RD-01 to RD-06): the page helper's readerable reports and Readability extraction on a document clone (preload/page/reader*.ts), re-checked with zod, kept per tab; a view cover hides the page while the chrome draws renderer/src/reader/ (the view, read aloud through speechSynthesis, settings rows); ⌥⌘R, View › Reader and ⌘+/⌘− for its text
 ├─ translate/          page translation (TR-01 to TR-13): the page helper's language hints and in-place text-node translation (preload/page/translate*.ts); the controller's decision table, sessions and batches; Apple's on-device engine through native/translate (atelier-translate, JSON lines) first, the companion's QuickModel engine only when switched on; TabInfo.translate drives the pill button and the translate-popover surface; a page menu section (Translate to, Show original); settings.translate per profile
 └─ media/              the media hub (MD-01 to MD-04): page helpers' media and Media Session reports, now-playing sources per window, speed, picture-in-picture, the page menu on video and audio; media keys and Now Playing stay Chromium's
src/shared/i18n/        the English and Dutch catalogues, typed message keys
src/renderer/src        companion-card/, workspace/, guidance/, updates/, voice/, diagnostics/, migrations/, popup-strip/: the matching UI
```

## The agent

### Chats are snapshots

The first message of a chat fixes its setup for the chat's whole life:
- model;
- whether it controls the browser;
- web tools and memory;
- enabled connectors;
- the system prompt, including the companion's name.

The API rejects requests that change `system` or `tools` before an earlier thinking block, and changing them would also throw away the prompt cache. Settings therefore apply to new chats, and history is append-only.

Chats are saved under `userData/chats/` together with a compacted, replayable event log, so the Library can reopen any chat and continue it.

### Request

Every request uses `client.beta.messages.stream` with:
- the tools from `buildTools`: `browser_toolset_20260801`, `web_search` / `web_fetch` (the dynamic `_20260209` versions where the model supports them), `memory_20250818`, and one `mcp_toolset` per connector;
- adaptive thinking with summarized display, and an explicit `effort`;
- automatic prompt caching (`cache_control`);
- `fallbacks: "default"` (not sent for Haiku), and the MCP connector beta when the chat has connectors.

Server-side tools (search, fetch and MCP) appear in the panel live, from `content_block_start` events.

### Tool calls

`runToolCalls` routes calls to their handlers:
- browser toolset calls (`toolset_name: "browser"`) go to `BrowserToolExecutor`;
- `memory` calls go to the SDK's `BetaLocalFilesystemMemoryTool`, which confines every path to `/memories`, including symlink escapes.

The batch halt rule applies across the whole turn. Download start, finish and failure events reach the agent as `browser_state.state_changes`.

### The browser executor

| Member group | How Atelier runs it |
|---|---|
| `read_page`, `find`, `get_page_text` | The page preload walks the DOM, including shadow roots and same-origin frames. It assigns stable `[ref_N]` references and works out roles and accessible names. Output is capped at 50,000 characters. |
| clicks, hover, drag, scroll, `key`, `type`, `hold_key` | CDP `Input.*` with focus emulation. Events are trusted and work while Atelier is in the background; editing shortcuts carry explicit editor commands. |
| `screenshot`, `zoom` | `capturePage`, scaled to at most 1456 px on the long edge and about 1.15 megapixels; model coordinates are mapped back to CSS pixels. |
| `form_input` | Uses the native value setter, so frameworks register the change; handles checkbox, radio, select and contenteditable. |
| `navigate` and tab members | Only http and https. Results include `browser_state` with `tab_opened` and download changes. |

### Routines

Routines run on a schedule (daily at a time, optionally on chosen weekdays, or every N hours) while Atelier is open; a missed run runs once at the next start. Each run is a fresh background chat with web tools, memory and connectors but **no browser control**, so it never takes over the tab you're using. You get a system notification when it finishes, and the result is in Library › Chats.

### Skills

Skills are saved instructions invoked as `/name`. The composer autocompletes them, and main expands them into a `<skill>` block in the user message. Routines can start with a skill too.

## Engines

A chat runs on one engine, fixed at its first message like the model (Settings › Model and key; a companion can choose its own). There are no plans, credits or quotas in Atelier: the page shows each engine's live status instead.

- **Anthropic API key** (`api-key`): the conversation loop above.
- **Your Claude subscription** (`claude-code`): Claude Code, Anthropic's own program, on your computer, signed in to your own Claude plan ([claude-subscription.md](claude-subscription.md)).
- **The seam.** The `AgentBackend` seam (`src/main/engines/backend.ts`) takes one message at a time; queueing, stop, approvals, tab ownership and persistence stay in the session, so every engine behaves alike. A backend also makes its own attachment blocks, names its own failures, and hears when a chat is duplicated or deleted. `src/main/engines/extras.ts` is the rest of what an engine brings: its status (`EngineStatus.others`, a short summary every surface shows), its quick calls, its service namespace, its settings, its chat error codes and their cards, its strings (the catalogue's `engines` area), its part of Settings › Model and key and the welcome flow, and its screenshots in the smoke run.

**Where engines come from.** The engines besides the API key live in `src/engines/`, which public code imports as `@engines/<name>` (`shared`, `main`, `renderer`, `cards`, `i18n/en`, `i18n/nl`). Every build has them, public releases included. The maintainer's private `internal/` folder holds no app code: only the release values, private documents and optional packaging steps (`internal/build.json`, run by `node scripts/internal.mjs prepackage`).

**Bring your own model.** Every engine runs on the person's own account. Atelier never holds, proxies or meters that access.

**Atelier's MCP server** (`src/main/mcp/`) lives inside main, because the `runAsNode` fuse is off. It listens on 127.0.0.1 and answers Streamable HTTP with plain JSON. An engine that runs the model elsewhere reaches Atelier's tools for one chat at `/mcp/chat/<id>` with a bearer token derived (HMAC) from a secret made at each launch; the token sits in a 0600 config file in Atelier's data folder, never on the command line, and opens only that chat. Requests with an `Origin` header, a non-loopback `Host`, or a missing or wrong token are refused before any tool is looked at; calls outside one of the chat's turns are refused too. Its tools are the browser toolset's members with the same schemas, run by the chat's own `BrowserToolExecutor`, so the guard, approvals, password and payment blocks and tab ownership are the API-key engine's; chats with memory also get a `memory` tool on the companion's memory folder. A chat's enabled connectors go into the same private config file as remote HTTP servers (with their tokens), and only their tools are allowed besides Atelier's.

**Let Claude Code use Atelier (ST-60).** Off by default. When on, `/mcp/outside` accepts a separate secret, kept encrypted with `safeStorage` and stable across launches (as is the port, when free), so the command added with `claude mcp add --transport http --scope user atelier … --header "Authorization: Bearer …"` keeps working. Settings shows that command with the secret masked (Copy puts the real one on the clipboard from main), runs it for you when it finds `claude` in your shell, picks the tabs it may use (only those it opens, or any tab no chat is working in) and revokes access by making a new secret. Its tabs show the working marker; consequential actions always ask in Atelier with a system prompt, whatever the approval setting, and fail closed after five minutes.

**One-shot calls.** Every model call outside a chat (activity notes, import summaries, skill drafts, voice, quick ask, meeting summaries, first-week starters, tidy memory) goes through one shared `QuickModel` (`src/main/agent/quick.ts`, built once in `src/main/index.ts`), on whichever engine is chosen. `json()` sends the zod schema as structured output where the engine can (`output_config` on the API), then checks the answer with zod and retries once. Another engine answers through its `QuickEngine`; on one without client tools, a tool loop runs one JSON-answering call per round. No other module creates an Anthropic client for a model call.

## Branding

As in Firefox, the name, logo and icons are a build-time choice between two brandings in this repository. The official
files that depict an Atelier character (the icons and installer art, whose mark is Pip, and the rendered art) are Atelier
Companion Art ([ART-LICENSE.md](../ART-LICENSE.md); `branding/official/LICENSE.md` lists them) and the rest is MPL-2.0
like the code; the Atelier name, logo, sprout mark and the six Atelier characters are trademarks, and neither licence grants
trademark rights ([TRADEMARKS.md](../TRADEMARKS.md)):

- `branding/official/`: Atelier, its wordmark, the Pip mark and icons, the installer art, and Pip as the default companion
  with all six characters offered (bundle id `com.sennechin.atelier`). Only official builds use it.
- `branding/unofficial/`: Summit, a plain icon set drawn from one SVG (`branding/unofficial/icon.svg`, by
  `scripts/app-icons/unofficial.mjs`), the name in the UI font beside the plain mark as its logo, and a neutral
  companion of its own, Companion (`companion.json`), as the only preset: it leaves out all six of `presets.json`'s
  characters (bundle id `dev.summit.browser`).

Each folder has a `branding.json` (names, bundle id, publisher, copyright line, trademark line, default preset, the
branding's own companion file if it has one, presets left out, icon files) and the same files under the same names. As in Brave, the copyright line is "Copyright © 2026 The
Atelier Authors" in both; as Firefox's `trademarkInfo`, the official branding's trademark line ("{brand}, the {brand}
logo and sprout mark, and the {brand} characters are trademarks of Chinnovations.") shows in Settings › About, translated through the catalogues, and the unofficial
one is empty. **`scripts/branding.mjs`** decides which one a build takes: `ATELIER_OFFICIAL_BRANDING=1` or `0`, else
official only when the private `internal/` folder is in use. The release workflow sets it to 1; CI and every other
checkout build Summit. From there:

- **electron-vite** gets the `__ATELIER_BRANDING__` define (read as `BRANDING` in `src/shared/branding.ts`: the names, the
  bundle id, the default companion's name and look, from the branding's `companion.json` or `presets.json`, the whole
  own preset when there is one, and the presets left out; `offeredPresets` puts the own preset first, and
  `src/shared/brandingPreset.ts` shows its text in the app language) and the `@branding` alias,
  through which the renderer takes the mark, the standard icon and the wordmark (`BrandLogo`, `BrandMark`). The HTML
  pages' `%BRAND_NAME%` is filled in at build time.
- **electron-builder.yml** is written for the official branding; `scripts/release/builderConfig.mjs` (`brandedConfig`)
  swaps in the active branding's folder and name: productName (and the packaged package.json's, so `app.name` and the
  profile folder follow), file type names, usage descriptions, the installer's shortcut and art, the Linux window class,
  and `resources/` (the runtime icon and tray). It also sets `copyright` (macOS Info.plist, Windows file properties), the
  packaged package.json's author from `publisher` (the installer's publisher), and `win.legalTrademarks` from the
  trademark line when there is one. `afterPack.mjs` compiles the branding's Icon Composer document when it
  has one. The NSIS script names its registrations after `${PRODUCT_NAME}`, and the native helpers' Info.plists take
  the branding's bundle id and name (`scripts/release/bundle.mjs`).
- **Main** names the app from the branding (`src/main/branding.ts`) and reads its icons and tray images from
  `branding/<id>/resources` in a dev run (`src/main/resources.ts`); `scripts/dev-branding.mjs` renames the dev
  Electron.app and gives it the branding's icon.
- **Text** never writes the name: the catalogues say `{brand}`, which `format()` in `src/shared/i18n/core.ts` fills in
  from the branding, like Firefox's `-brand-short-name`; other code uses `BRAND_NAME`, and shipped Markdown goes through
  `withBrand()`. `atelier://` addresses, the `.atelierpack` and `.ateliercompanion` types, IPC names and code identifiers stay as
  they are in both brandings.

## Pip, the companion

Pip is the default companion of official Atelier (the unofficial branding starts with its own neutral Companion and offers
none of the six characters; see [Branding](#branding)), and every companion is assembled at runtime from modular parts.
The engine is MPL-2.0; the parts, rigs, face layers, presets and their recipes are Atelier Companion Art
([ART-LICENSE.md](../ART-LICENSE.md)), and a fork brings its own
([companion-system.md › Bring your own designs](companion-system.md#bring-your-own-designs)). It is built from modular glTF parts, a 2D expression layer, JSON rules, shared base rigs with clips and timed events, off-screen rendering, presets and an editor. A code generator in `scripts/companion-assets/` builds every model, face layer and config from geometry. The contract (ids, types, file formats) is `src/shared/companion.ts`, and the full spec is [companion-system.md](companion-system.md).

- **Generated assets** (`npm run companion:assets`, deterministic, about 1 MB, committed under `src/renderer/public/companion/`):
  - three base rigs in meshopt-compressed glTF: Bean (round, hoodie), Sprout (tall, overalls) and Pebble (small, puffer). Each has the same 11 clips at 30 fps: a loop per mood plus the `wave` and `poke` one-shots;
  - 37 parts across seven slots: 6 heads, 4 ears, 8 hair styles, 6 hats, 4 eye accessories, 3 ear accessories and 6 props. Materials named `tint:*` take the profile's four colours, and `paint:*` keep their own;
  - a 2D face layer: 8 eye styles, 4 brow styles and 5 mouths as 512×256 SVGs with a variant per expression, and pupils on their own layer so they can follow the gaze;
  - JSON rules that a fit pass computes from the geometry: which parts each head accepts and what goes with each hat, how hats and headphones sit on each head (with hair-specific seats, since hair raises them), pupil ranges, weighted randomization with 12 palettes, timed animation events, and six presets with personalities (Pip, Juniper, Bolt, Mochi, Sage, Pepper).
- **Runtime** (`src/renderer/src/companion/`): loads the rig, hangs the head on `anchor:head` and the other parts on the head's anchors, and gives every mesh a toon material and an inverted-hull outline in a darkened skin tone. The face is a canvas texture composited from the SVG layers. An `AnimationMixer` crossfades the mood's clip, and events in the clip fire blinks, expressions, prop visibility, sparkles and squashes. Gaze follows the pointer through the pupils and a small head turn.
- **Moods** come from one presence store (`companion/presence.ts`, with the pure rules in `presenceCore.ts`) fed by every composer, the agent's event stream, the chat list and idle time, so every view of a companion or chat agrees: idle (blinks, follows the pointer), listening (while a composer has text), thinking, working, talking (mouth synced to streamed text), approval, happy (after success), sad (after an error) and sleeping (after three idle minutes). Small faces (sidebar rows, the chat chip, reply gutters) follow only their chat's state; a live figure standing in a chat also listens to that chat's composer.
- **Customization:** Settings › Companions lists every companion, and each companion's card edits its name and personality and, in place around the figure, its body, every slot, the face layers and the four colours, with palettes, undo, the shuffle styles and the presets; the welcome flow and the new-companion sheet offer a shuffled companion and the presets. The accent colour, adjusted for contrast, tints links, selection and highlights on companion surfaces; the chrome takes the profile hue instead (DS-03), and primary buttons stay neutral ink (DS-138). A preset's personality is added to the system prompt of new chats.
- **Off-screen rendering:** `renderCompanionImage` draws a still to a PNG for preset thumbnails and, on macOS, the optional Dock icon.
- **Performance and fallbacks:** files are fetched and parsed once and cloned per view; rendering pauses off-screen and in hidden windows, small views run at 30 fps, and reduced motion slows clips and skips the wave. The agent panel's small view frames head and shoulders. Without WebGL or assets, a 2D face in a tinted circle is drawn instead.

## Staying light

A browser's weight is mostly the pages it keeps open, then what it keeps loaded to be quick, then what it leaves on
disk. Each has one owner, and everything heavy is off until it is asked for.

| What | How it stays light | Where |
|---|---|---|
| Background tabs | A tab in the background sleeps after `tabSleepMinutes` (two hours unless set otherwise): its page is discarded and comes back with its history when selected. Pinned, audible, capturing, agent-controlled tabs and tabs with edited forms never sleep. Restored tabs load only when first shown. | `tabSleep.ts`, `tabs.ts` sleep and wake |
| Memory saver (`memorySaver`, on) | While the computer is short of memory, background tabs sleep after 10 minutes, and after 2 when it is critical, also when tab sleep is set to never; at critical the on-device models are let go when nothing waits on them. The reading is the operating system's own: macOS's memory pressure level, Linux's `MemAvailable`, Windows' available physical memory (under 12% or 1 GB is short, under 5% or 400 MB critical), asked every half minute. "Free" memory is not used: a healthy Mac reports almost none. | `resourceSaver.ts` |
| Energy saver (`energySaver`, on) | On battery, background tabs sleep after half an hour at most, and the on-device model is not loaded ahead of the first question. | `resourceSaver.ts`, `decisions/feature.ts` |
| On-device models | Optional downloads apart from the 54 MB one that ships. One helper process holds them; each model loads at its first use, and the whole helper stops after five minutes without a question. A model folder an update made out of date is removed a minute after start instead of waiting for the new download. | `decisions/device.ts`, `deviceMini.ts` tidy |
| Other helpers | Translation stops after five idle minutes, connector servers after ten, PDF and table workers after each request, hidden tool windows after one to five minutes. | `translate/helper.ts`, `connectors/localServers.ts` |
| Animations | The companion, the ambient field and the new-tab floor stop drawing while their window is hidden. | `companion/view.ts`, `ui/AmbientField.tsx` |
| Disk | Logs rotate at 2 MB, five kept. History keeps 5,000 entries, closed tabs 50, activity screenshots 30 days. Settings › Storage shows what each kind takes and clears it. Chromium sizes its own HTTP cache from the free disk space; there is no second cap on top. | `diagnostics/logger.ts`, `coreStorage.ts` |

The task manager (⇧Esc) shows what every tab and helper holds right now.

Both savers only bring forward what already happens to a background tab, so nothing new can be lost by them, and
each has its switch in Settings › General › Tabs. Not done, on purpose: pages are not prerendered or preconnected
ahead of a click (it trades memory, battery and privacy for speed), and Chromium's own throttling of background
timers and occluded windows is left on everywhere except tabs the agent is driving.

## Security model

| Concern | Atelier |
|---|---|
| Renderer isolation | `app.enableSandbox()`, `contextIsolation`, no `nodeIntegration`, no `webviewTag`, webview attach blocked |
| Fuses | `runAsNode`, `NODE_OPTIONS` and `--inspect` off; cookie encryption, ASAR integrity and ASAR-only loading on; `grantFileProtocolExtraPrivileges` off. Verified with `npx @electron/fuses read --app`. |
| UI origin | `app://atelier/` with CSP `script-src 'self' 'wasm-unsafe-eval'` (the meshopt decoder compiles WebAssembly); requests that try to leave the UI folder are rejected |
| IPC | UI channels and every service method check the sender (the chrome's main frame) and validate arguments with Zod; page replies are accepted only from the main frame of the tab that was asked |
| Pages vs. agent | the agent bridge lives in the isolated world and exposes nothing to pages; the agent cannot act on `atelier://` pages |
| Agent safety | approval for consequential actions, a hard block on passwords and payment fields, `javascript_exec` and `file_upload` disabled, page content treated as untrusted |
| Secrets | the API key and connector tokens are encrypted with `safeStorage` (Keychain on macOS) and written with mode 0600; memory never holds secrets |
| Local MCP server | listens on loopback only, refuses browser origins and foreign hosts, and fails closed on a missing or wrong bearer token; chat tokens die with each launch and open one chat; the outside secret is encrypted and revocable |
| Import | the other browser's files are only read (databases from a copy), never changed: bookmarks, history, tabs, search engines and saved addresses (into the encrypted wallet; card tables are never queried), plus sign-in cookies only when ticked (Chromium on macOS); passwords only from a CSV export |

## Sign-in compatibility

"Sign in with Google, Microsoft, Apple, Meta, GitHub, Amazon, X, LinkedIn or Yahoo", directly or from another site's button, leans on browser mechanics Electron doesn't all give a browser by default. Each is measured on the local smoke server by `src/main/smokeBrowser/signInCompat.ts` (127.0.0.1 plays the site, `localhost` the provider, and `idp.localhost` a registered provider), and what a site sees of Atelier by `src/main/smokeBrowser/identity.ts`, `chromeSurface.ts` and `signInIdentity.ts` (`accounts.google.localhost` is mapped to Google's sign-in under `ATELIER_SMOKE_SIGNIN_HOSTS`). The per-provider pages come from the registry in `src/shared/signInHosts.ts`.

On a sign-in page Atelier adds nothing of its own to the page: no DevTools attachment for standing overrides (`src/main/cdp.ts`; the agent attaches only while it acts), and none of the page preload's main-world parts (`src/preload/page.ts`), so the WebAuthn fail-fast below doesn't run there either. The exceptions are the chrome surface, which sign-in pages expect, and the window geometry stand-in, which only fills in a missing window frame.

| Mechanism | Status | Limits |
|---|---|---|
| Browser identity | Stock Chromium everywhere: the reduced Chrome User-Agent with no Electron or Atelier token, the same in every session, window and popup (`src/main/userAgent.ts`), and the matching `Sec-CH-UA` client hints on navigations, frames and workers (`src/main/clientHints.ts`). | The brands are Chromium's, not Google Chrome's. |
| `window.chrome` (the chrome surface) | Filled in to match the web-page surface of desktop Chrome 156, where Electron leaves an empty object (Google's sign-in needs it): `chrome.loadTimes()` and `chrome.csi()` from the page's own `performance.timing` and navigation entry; `chrome.app` (`isInstalled`, `getDetails`, `getIsInstalled`, `installState`, `runningState`, `InstallState`, `RunningState`); `chrome.runtime`'s web-page half (`connect` and `sendMessage`, with the API's argument checks and errors, and the `ContextType`, `OnInstalledReason`, `OnRestartRequiredReason`, `PlatformArch`, `PlatformNaclArch`, `PlatformOs` and `RequestUpdateCheckStatus` enums). Every function reads as native code (`Function.prototype.toString`, name, length, no prototype on the API methods); every property is a plain enumerable data property. Only what is missing is filled. `src/preload/chromeSurfaceWorld.ts` runs in the page's world at document start, before any page script, through a session frame preload (`src/preload/chromeSurface.ts`, registered by `src/main/chromeSurface.ts` on every browsing session), in every frame of tabs and popups (both set `nodeIntegrationInSubFrames`) and on sign-in pages; about:blank iframes, where Electron runs no preload, are filled when the page first reaches them through `contentWindow` or `contentDocument`. | Not on `chrome-extension:` or atelier:// pages. `chrome.runtime` is there on every page, as Google's pages expect. With a well-formed extension id, `sendMessage` and `connect` find no receiver, as for an extension that isn't installed. An about:blank frame reached only through `window.frames` isn't filled. |
| Google's sign-in identity | Chrome, as everywhere (`identity: 'chromium'` in the registry): the Chrome User-Agent, its client hints and the chrome surface, on `accounts.google.*`, `accounts.youtube.com` and `myaccount.google.com`, in tabs and popups. Before, Atelier presented Firefox there, which contradicts `navigator.userAgentData` and Chrome-only APIs on Chromium. | Experiments' "Google sign-in: present as Firefox" (`google-signin-firefox`, off) switches Google's sign-in pages back to Firefox without a rebuild or restart (`src/main/signInIdentity.ts`: Firefox's User-Agent on every request and in `navigator`, no client hints), should Google refuse the Chrome identity. |
| OAuth popups (`window.open(url, name, 'popup,width=…')`) | A real popup window with an origin strip (`src/main/popups.ts`). `window.opener` stays, the provider's `postMessage` reaches the opener, `window.close()` closes the window and the opener sees `popup.closed`. Named windows are reused, and `noopener` and `noreferrer` are honoured. | A popup's own `window.open` opens a tab in the front window, without an opener. A popup closes with the tab that opened it. |
| `window.open(url)` without popup features | A tab around the page Chromium created (`createWindow` adopts the guest, `CreateTabOptions.guest`, with a tab's own preferences and preload), as the web platform expects: the call returns the window and `window.opener` stays. The tab stays open when its opener closes. `target=_blank` links take the same path and keep their implicit `noopener`. Before, Atelier opened its own tab: the call returned `null` and the opener was lost. | |
| Redirect flows (query and `form_post`) | Full-page redirects come back with the code. The site's `SameSite=Lax` state cookie comes back on the GET return. | A `form_post` return is a cross-site POST, so Lax cookies stay behind, as in every browser. |
| FedCM, Google One Tap | Off: `--disable-features=FedCm`, merged into any existing value before ready (`src/main/signInEarly.ts`). `'IdentityCredential' in window` is false and an identity request rejects at once (`NotSupportedError`), so Google Identity Services uses its popup or redirect flow. With FedCM on, Electron fetched the accounts and rejected with `NetworkError` (it has no FedCM sheet), and GIS would not fall back. | No FedCM sign-in, and no One Tap through FedCM. |
| Passkeys and WebAuthn | `isUserVerifyingPlatformAuthenticatorAvailable()` is false. In every frame except the registry's sign-in pages, the page preload (`src/preload/page/webauthn.ts`, using the table in `src/shared/webauthnPolicy.ts`) rejects at once, with `NotAllowedError`, the calls only a passkey sheet could answer: platform attachment, a required discoverable credential or user verification, `get()` without `allowCredentials`, and credentials that live only on this device or a phone. A conditional (autofill) request waits until the page aborts it, and never holds Chromium's single request slot. `getClientCapabilities()` reports no hybrid, no conditional get or create, and no platform authenticator. `isConditionalMediationAvailable()` is false. Security-key calls (a second factor with `usb`/`nfc`/`ble` credentials) go to Chromium with their timeout capped at 90 s. Before, a passkey call never settled until the site's own timeout, and every later call failed with "A request is already pending". | There's no passkey sheet, no phone QR sign-in (hybrid), no PIN entry and no iCloud Keychain. A security key works only for touch-only calls. On the registry's sign-in pages Atelier adds no page script, and popup windows run no page preload. A passkey call there still waits for the provider's timeout. The availability check is false there too, and the providers show "Try another way". |
| Touch ID and iCloud Keychain passkeys | `src/main/signInCompat.ts` reads the packaged app's own signature at start-up (`src/main/codeSignature.ts`: the executable's embedded signature, once, no subprocess) and turns on what it allows. `app.configureWebAuthn({ touchID })` needs a team signature with `keychain-access-groups` = `<TEAM_ID>.<bundle id>.webauthn`. `app.configureWebAuthn({ platformPasskeys: true })`, Apple's system passkey sheet (iCloud Keychain and other providers), needs Apple's browser passkey entitlement `com.apple.developer.web-browser.public-key-credential`, which lets macOS serve any relying party. With the sheet on, tabs pass `--atelier-system-passkeys` to the page preload, which then passes every call in top and same-origin frames. Discoverable sign-in uses the `select-webauthn-account` chooser (`src/main/features/signInCompat.ts`): one account is used as it is, and several are offered as buttons. | Both entitlements are restricted: they need a Developer ID certificate and an embedded provisioning profile that grants them, or macOS refuses to launch the app. So `build/entitlements.mac.plist` never holds them; the "Developer ID + browser passkeys" signing mode generates them next to the profile (`scripts/release/entitlements.mjs`, docs/release.md). Touch ID credentials are device-bound and not synced; configuring Touch ID in an unentitled build stalled Electron's main thread in testing, which is why it is gated. Electron's platform passkeys can't serve cross-origin iframes, don't support `prf` or `largeBlob`, and report `https://<rpId>` as the origin. Chromium's own iCloud Keychain authenticator is compiled in but has no switch in Electron. |
| Third-party cookies | Allowed by default (`blockThirdPartyCookies` defaults to false), so embedded sign-in iframes (`accounts.google.com`, `login.microsoftonline.com`) get their session. With blocking on, `src/main/privacy.ts` exempts requests to a registry sign-in page and a sign-in page's own cross-site requests. A site you blocked stays blocked. | Blocking strips cookie headers only: `document.cookie` in frames is untouched. A provider's main site outside its sign-in pages (`facebook.com/plugins`) is an ordinary third party. |
| Storage Access API | `hasStorageAccess()` is true, and `requestStorageAccess()` resolves when cookies are allowed. A permission override grants `storage-access` there, and for sign-in providers while blocking is on. Before, the permission table refused it, and the call rejected with `NotAllowedError` even with access in hand. | `requestStorageAccessFor` (`top-level-storage-access`) stays refused. |
| Window geometry (`outerWidth`, `outerHeight`, `screenX`, `screenY`) | The host window's outer frame. Chromium on macOS gives a page in a `WebContentsView` its window's frame only once the view has been laid out and drawn, so a fresh tab's first page (about a second behind other apps or on a locked screen) and a background tab until it is shown would read a 0 x 0 window at 0,0, a headless tell. While Chromium still reports 0, the page preload (`src/preload/page/windowGeometry.ts`, every frame, sign-in pages too) asks main (`src/main/windowGeometry.ts`, `PAGE.window`) for the window's bounds before any page script runs and wraps those getters (a Proxy, so name and `[native code]` stay) to answer with them; main sends new bounds as the window moves or resizes, and the native getters go back the moment Chromium has its own value. No debugger is attached. | A page Chromium has already placed gets nothing. Until it is placed, a getter's source reads `function () { [native code] }` rather than `function get outerWidth() { [native code] }`. |

## Packs runtime

Packs ([packs.md](packs.md)) are Atelier add-ons, separate from Web Store extensions. `src/main/packs/feature.ts` builds the `PackStore` (`<userData>/packs/`), the `PacksRuntime` and the service, and registers the builder tools; index.ts binds the merged services and the companion exporter (`bindPacks`).

- **Validation.** `validatePack` (`manifest.ts`) checks an in-memory file map, so a folder, an `.atelierpack` and a draft go through the same rules; installed packs are re-validated and re-hashed at every start, and one changed on disk loads switched off.
- **Sandbox.** `atelier-pack` is a privileged standard, secure scheme. Each pack gets `persist:atelier-pack-<id>` (a draft under `test_pack` gets the in-memory `atelier-pack-test-<id>`): the protocol handler serves only that pack's files (and Atelier's tool host page under `__atelier/`), http, https, ws and file are refused in the session, the webRequest lockdown allows only the pack's own address, and every permission and download is denied. `src/preload/pack.ts`, registered as a session frame preload, exposes `window.atelier`; `bridge.ts` answers each op after checking the sender (top frame of its own pack's address), that the pack is on, the op's zod arguments and its permission. `atelier.fetch` runs in main with `credentials: 'omit'`, manual redirects re-checked against the allowlist, and size and time caps.
- **Contributions.** `PacksRuntime.sync()` runs on every store change: pack skills into `SkillStore.setPackSkills` (read-only, between your shared skills and the built-ins when resolving `/name`; the built-in skills pack's switch is `setBuiltinsHidden`), tweak CSS and scripts through `setPackTweakRules` (merged after your own tweaks' rules), accents through `setPackAccents` (`AccentChoice` `pack:<id>/<theme>`), and tools through `registerClientTool`/`unregisterClientTool` as `pk_<id>_<name>`. A command-bar provider (group `packs`, action `{ kind: 'pack' }` run by `runPackCommand`) and a page menu section (order 70) read the store live.
- **Tools.** `PackToolHost` keeps one hidden off-screen window per pack, loading `__atelier/tool-host.html`, which imports each tool module and serves calls through `atelier.tools.serve`; calls queue one at a time so the page a call reads is its own, time out after a minute, and an idle host closes after five.
- **Trust.** `signing.ts` holds your author key (Ed25519, private half sealed with safeStorage) and the pins (`trusted-keys.json`). Every install goes through `service.ts`'s review token; only `confirmInstall` installs.

## Extensions runtime

Extensions run on Electron's own `session.extensions` (`src/main/extensions/adapter.ts`), and Atelier fills the APIs Electron leaves out with its shims: `src/preload/extensionShim.ts` (serialized into the extension's worker and pages by the worker and frame preloads) talks to `src/main/extensions/shim.ts`, which checks every payload with zod and routes it to `ExtensionsHost` (`host.ts`). The shims cover action, commands, permissions, tabs.create/query and the tabs events, windows and its events, native messaging, and, for manifests that ask for them, `privacy`, `declarativeContent`, `webNavigation` and `contextMenus`. Events an extension listens for (tabs, webNavigation, windows, a setting's onChange, menu clicks) reach only contexts that registered a listener (the `tabs.listen` op); a sleeping worker is woken for them. An extension iframe inside a tab (a password manager's fill list) hears its own events through its frame.

- **Frames.** `webNavigation.ts` maps Electron's frame events (did-start-navigation, did-frame-navigate, dom-ready, did-frame-finish-load, did-navigate-in-page, did-fail-load) to Chrome's events and uses Chromium's own extension frame ids (0 for the main frame, the frame-tree node id otherwise), the ids `tabs.sendMessage({ frameId })` and a sender's `frameId` already use. Only tabs in the extension's own profile session answer.
- **Browser settings.** `privacySettings.ts` holds chrome.privacy's `services.*`. An extension may hold `passwordSavingEnabled` (most recently installed wins, applies while it runs, kept across restarts); address and card autofill are `not_controllable`. `ExtensionsHost.passwordSavingHeldOff` feeds autofill: each tab's controller gets its settings through `stepAsideForPasswordExtension` (`src/main/autofill/offers.ts`), which turns off Atelier's password suggestions, generated passwords and save prompts while an extension holds password saving off and `autofill.yieldToPasswordExtension` is on.
- **storage.sync.** Electron's binding fails every call, so `src/shared/extensionStorageSync.ts` maps sync onto storage.local under a reserved prefix (sync's quotas and change events; storage.local no longer lists those keys). The preloads install it in workers and pages; for store installs, `contentCompat.ts` writes `atelier-compat/content.js` into Atelier's copy and puts it first in every `content_scripts` entry, so content scripts share the same data. Unpacked folders are never written to, so their content scripts keep Electron's failing sync.
- **Native messaging.** `nativeMessaging.ts` finds a host in Atelier's `NativeMessagingHosts` folder, then Chrome's user and system folders (a smoke run reads only its own folder), matches `allowed_origins` against the id (store installs keep the store id because the package key is written into the manifest), and starts the host as native messaging hosts expect: no shell, the origin and `--parent-window=0` as arguments, the host's folder as working directory and the environment without Electron's switches (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`). Frames are 4-byte little-endian lengths, 1 MB from a host and 64 MB to it. A worker holds a ServiceWorkerMain task while a port is open, so it stays alive; a page's ports end with the page.
- **Popups.** `popup.ts` sizes the popup view to the page's preferred size within the extension popup limits (25 to 800 by 600) and closes it on blur, Esc, `window.close()` or a window resize.
- **Apple Passwords.** `applePasswords.ts` is the macOS card (Settings › Passwords and autofill, and the welcome import step): it downloads Apple's iCloud Passwords from the Web Store (never bundled), verifies it, asks once (`beginStoreInstall`), installs it through `installPackage`, allows its one host and opens its popup. Its status comes from Apple's helper on disk (`checkHelper`), the extension running, its own toolbar icon (`actionIconPath`: "PasswordsToolbar" paired, "PasswordsToolbarUnpaired" not), and the helper's replies on the port, which the host reports to observers (`observe`); `applePasswordsState` (`src/shared/applePasswords.ts`) turns those into the card's words. Whether Apple's helper accepts Atelier as its caller can only be seen on a real Mac: the card then says the helper closed the connection.

## Testing

- `npm test`: the unit tests (Vitest). Besides the core logic (chats and per-chat sessions against a scripted client, companions and ownership, settings migration, tab state, shell services, the sidebar's ordering, chat surfaces, the companion card, settings pages and the UI kit), they cover URL and internal-page rules, history ranking, key parsing and CDP events, the approval guard, `app://` path safety, the tool router and halt rule, member schemas, request and tool building, chat log compaction, routine schedules, skills, connector validation, companion profiles and migration, importers (Chromium and Firefox SQLite fixtures, including timestamps beyond 2^53), download naming, memory path confinement and service schemas. For the companion they also cover the pure logic (compatibility and hat rules, normalizing, seeded randomization, event scheduling, face resolution), framing and the face plan, and the generated assets themselves: every contract id, file, clip, face variant and config is present and valid, and sizes stay within budget.
- The MCP server's auth and dispatch, outside access and the shell helpers have their own tests. `tests/internal.test.ts` checks that every build has the Claude subscription engine next to the API key, and what the private `internal/` folder may add to packaging. The engine's own tests (`tests/claudeCode*.test.ts`, `tests/engine*.test.ts`) run against an offline stand-in for Claude Code.
- `npm run smoke`: the end-to-end checks in real Electron, with no API key needed and no tokens spent. Chats talk to an offline stand-in for the Messages API (`src/main/smokeClient.ts`), so no request leaves the machine. On top of the browser toolset checks, it covers the memory tool round trip and path confinement, bookmarks, a real download, peek, split view, refusing to act on Atelier pages, live companions rendering without errors, the look editor and the new-companion sheet's preset thumbnails. The core checks (`src/main/smokeBase.ts`) add: settings migration from an older file, a live theme switch updating `data-theme`, creating and switching companions with the last one protected, a chat started from the new tab page and answered in the panel, separate sessions and logs for concurrent chats, the sidebar listing pinned tabs, tabs and chats, the tab shortcuts following the sidebar order, and ⌘D only adding a bookmark. The companion presence checks (`src/main/smokePresence.ts`) measure the sidebar's chat faces (20 px, the head filling the frame with no body), type into an empty chat to see its waiting companion listen while the draft exists, and check the live waiting companion's size on the chat page and in the panel. The getting-started checks (`src/main/smokeFirstWeek.ts`) run last, since they finish setup.
- After the base checks the smoke run goes through its groups in order, each printed in front of its checks' names. `ATELIER_SMOKE_ONLY=<group>[,<group>…]` (any case) runs only those (`src/main/smokeGroups.ts`):
  - `BROWSER` (`src/main/smokeBrowser/`): windows and tabs, the address bar and the new-tab search, menus, dialogs and downloads, settings, sites and permissions, the chat panel and chats in tabs, and what sites see of Atelier at sign-in;
  - `VOICE-PASSWORDS` (`src/main/smokeVoicePasswords/`): speech and transcription, voice and the quick-ask launcher, meetings and meeting capture, passwords and autofill;
  - `FILES-CONNECTORS` (`src/main/smokeFilesConnectors/`): profiles, attachments and the composer, Library files, connectors, the rich chat turn (documents, compaction, reply tools) and extensions, including Apple Passwords;
  - `AGENT-WORKSPACE` (`src/main/smokeAgentWorkspace/`): the workspace (projects, folders, search, versions, Recently Deleted), the agent's requests and approvals, memory, skills and routines, apps and tables, the chat tools and setup;
  - `MAINTENANCE` (`src/main/smokeMaintenance/`): diagnostics, migrations, updates, the tray and other system integration, native helpers, the public-release check and languages;
  - `TWEAKS`, `MEDIA`, `PRIVACY`, `TRANSLATE`, `READER`, `PACKS`, `DECISIONS` (each feature's `smoke.ts`, or `src/main/smokeMedia/`) and last `LAYOUT` (`src/main/smokeLayout/`).
- CI (`.github/workflows/ci.yml`) runs the whole smoke suite on macOS, Windows and Linux, headed (Linux under xvfb, its pointer parked off the window as a person's would rest), without `internal/`, and skips no check. The macOS and Windows runners' screens are small (1024×768), and the run prints its window and work area first. `ATELIER_SMOKE_WINDOW=<width>x<height>` runs in a window that size, to reproduce a CI failure on a bigger screen. Checks press only what is on screen and uncovered: a row is scrolled into view and hit-tested before a drag starts on it.
- With `ATELIER_SMOKE_SHOTS=<dir>` (and `ATELIER_SMOKE_THEME=light|dark`), `src/main/smokeShots.ts` also saves a screenshot of every core surface as it looks on screen, page views composited in: both layouts, the collapsed sidebar, the panel, chat pages, All chats, the destinations, Settings, the companion card and sheets, a confirmation, the welcome flow and close-ups of the address pill. `src/main/smokeScene.ts` adds the design scene at the design window size (1470×923): the companion card over a chat page with the bookmarks bar, the chat page alone, an empty chat as a page and in the panel, and retina close-ups of the sidebar rows at rest and on hover.
- The layout audit (`src/main/smokeLayout/`, also alone with `ATELIER_SMOKE_ONLY=layout`) opens every page (the new-tab page, each atelier:// and Settings page, a chat page and a chat in the side panel) at 900, 1280, 1470 and 1920 px wide and at 1280 with the panel open. In each it measures the chrome's DOM for content that overflows its box or runs off screen, text that is clipped, squeezed or overlaps a neighbour, and a page that scrolls sideways, writes `layout-report.json` and a screenshot per page under `ATELIER_SMOKE_SHOTS`, and fails on any finding (`ATELIER_LAYOUT_REPORT_ONLY=1` only reports; `ATELIER_LAYOUT_PAGES=<regex>` narrows it). Tooltips are closed before each capture, and the product closes them on any page switch, so shots never depend on where the cursor rests. With `ATELIER_SMOKE_LANG=nl` the run starts with Atelier in Dutch, so the audit and its shots check the Dutch labels at every width (pair it with `ATELIER_SMOKE_ONLY=layout`: the other checks read English).
- The smoke run never starts the real Claude Code; `ATELIER_SMOKE_FAKE_CLAUDE=1` puts the offline stand-in (`tests/fixtures/fake-claude.mjs`) behind your Claude subscription and adds its screenshots to the agent and workspace group (`src/main/smokeAgentWorkspace/index.ts`). The public-release check (`src/main/smokeMaintenance/release.ts`) proves a public build offers your Claude subscription and the API key.
- **Network guard:** `scripts/smoke.mjs` runs the app with Chromium's net log and fails the run when any request names a host outside this machine (`scripts/smoke/netGuard.mjs`: loopback and reserved test names only), and `src/main/smoke.ts` fences the main process's own `fetch` for the whole run. Settings › Search draws each engine's initial rather than fetching its favicon, so opening Settings contacts no search engine.
- The same smoke test passes inside the packaged, fused app (`npm run smoke:packaged`). That run reads its fixture folders from the repo (`ATELIER_SMOKE_FIXTURES`) and runs the JS fake helpers with its own Node (`ATELIER_SMOKE_NODE`), since the fused binary can't run as Node.

## What Atelier includes

| Area | What is there |
|---|---|
| Tabs, address bar, history, back and forward, zoom, context menu | Built in, as in any Chromium browser |
| Bookmarks, bookmarks bar, downloads manager, find-in-page, history page | Built in |
| Split view, link peek | Two tabs side by side, and a preview of a link without leaving the page |
| Agent driving real tabs with a visible control state | Browser toolset, CDP input, overlay |
| Consequential-action approval; agent kept away from secrets | Approval before anything consequential, and a hard block on passwords and payment fields |
| Memory and activity memory | The memory tool with editable files, plus opt-in activity memory with a schedule and pause, stored locally (`src/main/activity/`) |
| Integrations | Through MCP connectors (any remote MCP server) |
| Skills, routines, scheduling | Skills the companion uses, and routines that run on a schedule |
| Companions and avatar animation | Modular parts with generated art: 3 rigs with 11 clips and timed events, 37 parts, a 2D expression layer, JSON fit rules, 6 presets with personalities, a full editor, the Dock icon, nine moods |
| Chat history | Every chat kept on this computer and listed in All chats |
| Onboarding and browser import | Bookmarks and history, passwords from CSV exports (`src/main/passwords/csvImport.ts`), and ChatGPT or Claude conversation exports |
| Web search and reading | Server-side web search and fetch |
| Ad and tracker blocking, permission prompts | A built-in blocker, on by default, and per-site permission prompts |
| Code sandbox | Anthropic's server-side code execution as the per-chat "Files and documents" ability (`src/main/agent/documents.ts`), off by default |
| Voice and meeting transcription | The on-device speech helper (`native/speech`) for dictation, meetings and file transcription: on macOS 26 Apple's SpeechAnalyzer with SpeechTranscriber (`Engine.swift`, `Analyzer.swift`, `Models.swift`; one analyzer per source for the whole session), SFSpeechRecognizer before that and for languages the newer engine doesn't support. `CallWatch.swift` reports which processes hold the microphone (Core Audio process objects, macOS 14.4+) for calls in desktop apps, and a call's other side is ScreenCaptureKit filtered to that app, on the same Screen Recording grant |
| Passwords, passkeys, autofill | Saved logins in a keychain-encrypted vault with autofill; passkeys still need the platform AutoFill APIs |
| Chrome Web Store extensions | On Electron's own `session.extensions` behind an adapter (`src/main/extensions/adapter.ts`); Atelier verifies and unzips Web Store packages itself. `electron-chrome-extensions` can replace the adapter by widening its `apis` list |
| Packs: add-ons people and companions build and share | [packs.md](packs.md): signed `.atelierpack` files, links, community indexes and updates; skills, site tweaks, accents, companions, connectors, panels, commands, page menu items and sandboxed agent tools; companions build, test and propose them, people review and install |
| Long-session context management | 60-step cap (`MAX_STEPS`; off with the `unlimitedSteps` setting) plus server-side compaction as a per-chat capability (`src/main/agent/compaction.ts`) |
