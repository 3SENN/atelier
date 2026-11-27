# Releasing Atelier

This runbook covers how Atelier is packaged, signed, notarized, published and rolled back. The scripts live in `scripts/release/`. The packaging config is `electron-builder.yml` (everything fixed) plus `electron-builder.config.mjs` (what the environment decides: the app id, the signing mode, the identity, notarization). CI is `.github/workflows/release.yml`, with an optional signed build in `.github/workflows/ci.yml`.

Nothing secret or personal is committed. The Team ID, signing identities, certificates, provisioning profiles, notarization credentials, the support email, website and GitHub repo all come from environment variables, or from GitHub Actions secrets and variables. The only identifiers committed are the brandings' default app ids, `com.sennechin.atelier` for official Atelier and `dev.summit.browser` for the unofficial Summit (`branding/*/branding.json`). The scripts never tag, commit or push: you do that.

## Placeholders in this runbook

| Placeholder | What it is | Where it goes |
|---|---|---|
| `<TEAMID>` | Your 10-character Apple Team ID (developer.apple.com › Account › Membership details) | `ATELIER_TEAM_ID`, and `APPLE_TEAM_ID` when you notarize with an Apple ID. In GitHub Actions: the `ATELIER_TEAM_ID` variable and the `APPLE_TEAM_ID` secret |
| `<SHA-1>` | The 40-character hash of your Developer ID Application certificate, as `security find-identity -v -p codesigning` lists it | `ATELIER_SIGN_IDENTITY` (or `CSC_NAME`). CI imports the certificate itself from the `MAC_CSC_LINK` secret instead |
| `Developer ID Application: Your Name (TEAMID)` | The same certificate by name | `ATELIER_SIGN_IDENTITY` (or `CSC_NAME`, or the `MAC_CSC_NAME` secret) |
| `<bundle id>` | The app id you sign as. `com.sennechin.atelier` is the official build's; a fork registers its own | `ATELIER_BUNDLE_ID` (the `ATELIER_BUNDLE_ID` variable in GitHub Actions) |
| `<notary-profile>` | The name you give a notarytool profile in your keychain | `APPLE_KEYCHAIN_PROFILE` (local builds only; CI uses the API key) |
| `<apple-id>` | The Apple ID email of an account on your team | `APPLE_ID` (the `APPLE_ID` secret), or only once, when storing `<notary-profile>` |

There is no default Team ID and no default certificate. Unsigned, ad hoc and plain Developer ID builds work without `ATELIER_TEAM_ID`; the passkeys mode, `npm run asc` and `verify.mjs`'s app id check stop with an error naming `ATELIER_TEAM_ID` until it is set.

## Private values (`internal/release.env`)

Official builds keep their identity in the private `internal/` folder's `release.env` (gitignored): plain `KEY=VALUE` lines, with `#` comments, such as `ATELIER_TEAM_ID=<TEAMID>`, `ATELIER_SIGN_IDENTITY=<SHA-1>` and `APPLE_KEYCHAIN_PROFILE=<notary-profile>`. When the file exists, the release commands (`npm run release` and `npm run package:mac`/`:win`/`:linux` through `release.mjs`, plus `asc.mjs` and `verify.mjs`) read it first, through `loadReleaseEnv` in `scripts/release/config.mjs`, and pass it on to the build. A variable already set in the environment always wins over the file, even an empty one. A plain `npm run package` reads only the real environment, so it builds unsigned unless you set the variables yourself. Anyone else, and CI, simply sets the variables.

## Builds for other people vs your own

A build that updates itself from a GitHub release repo goes to other people, so it must be a **public release**
(`ATELIER_PUBLIC_RELEASE=1`): it takes updates from the public repo and never bundles anything from the private `internal/` folder.
`release.mjs` refuses a build with an update feed that isn't one. A maintainer's own build sets no release repo, so its
updater stays off. A published official release therefore looks like this:

```sh
ATELIER_PUBLIC_RELEASE=1 ATELIER_RELEASE_OWNER=3SENN ATELIER_RELEASE_REPO=atelier npm run release -- --publish
```

## What a release produces

| Platform | Artifacts | Updates |
|---|---|---|
| macOS (arm64 and x64) | `Atelier-<v>-arm64.dmg`, `Atelier-<v>.dmg`, and a `.zip` of each | Squirrel.Mac installs from the zip. It needs a signed, notarized app. |
| Windows (x64 and arm64) | `Atelier-Setup-<v>.exe`, one NSIS installer holding both. It installs per user, with a choice of folder. | Needs a signed installer. |
| Linux (x64) | `Atelier-<v>.AppImage` and `atelierbrowser_<v>_amd64.deb` | The AppImage updates itself. A deb can't, so it says so in About. |
| Every release | `latest*.yml` (the update feeds), `SHA256SUMS`, `atelier-support.json` | |

The installers register Atelier as a browser the OS can offer. They never take an existing default; the person chooses Atelier in the OS settings, or from Atelier's getting-started page.
- **macOS:** URL schemes and document types in Info.plist.
- **Windows:** `build/installer.nsh` adds StartMenuInternet capabilities, http and https, `.html` and `.htm` as "Open with" choices, and `.ateliercompanion`. Uninstalling removes all of it.
- **Linux:** the desktop entry's MimeType, plus a shared-mime-info entry for `.ateliercompanion`.

## Environment

### The build (`scripts/release/config.mjs`)

| Variable | Meaning | Default |
|---|---|---|
| `ATELIER_CHANNEL` | `dev`, `beta` or `stable`. A beta's version must look like `1.2.0-beta.1`; a stable one has no pre-release tag. | `dev` (never released) |
| `ATELIER_PUBLIC_RELEASE` | `1` for a build anyone may download (see "Public builds"). The release workflow sets it unless the repository variable is `0`. | off |
| `ATELIER_RELEASE_OWNER`, `ATELIER_RELEASE_REPO` | The GitHub repo releases go to. Without them, no update feed is written and the updater stays off. | none |
| `ATELIER_SUPPORT_EMAIL`, `ATELIER_WEBSITE` | Used in the feedback and problem-report drafts, and in About. The website must be https. | empty |
| `ATELIER_UPDATES` | `0` turns the updater off even when it could work. | on when possible |
| `ATELIER_INTERNAL` | `0` builds from public code only, even with the maintainer's private `internal/` folder in the checkout (`scripts/internal.mjs`). | on when the folder is there |
| `ATELIER_BUNDLE_ID` | The app id (`appId`, `CFBundleIdentifier`, the Windows AppUserModelId). The native helpers become `<id>.speech`, `<id>.calendar` and `<id>.translate`. | `com.sennechin.atelier` |
| `ATELIER_OFFICIAL_BRANDING` | `1` builds official Atelier (the name, icons and Pip in `branding/official/`), `0` the unofficial Summit; unset, official only with the private `internal/` folder ([architecture › Branding](architecture.md#branding)). **Official releases must set `1`:** `release.mjs` refuses to release or publish any other branding (only `--package-only` builds Summit), so the maintainer keeps `ATELIER_OFFICIAL_BRANDING=1` in `internal/release.env` rather than relying on the folder. The release workflow sets `1` in `3SENN/atelier` and `0` anywhere else. | on with `internal/`, else off |
| `ATELIER_TEAM_ID` | Your Apple Team ID, `<TEAMID>`. It goes into the passkeys entitlements and is checked against the provisioning profile. Required for the passkeys mode and `npm run asc`. | none |

The updater is on only when all of these hold: the build has a repo, its channel is beta or stable, it is signed (macOS and Windows), and `ATELIER_UPDATES` isn't `0`. A macOS or Windows build that meets all of these except the signature can't install an update, so it announces one instead (`RELEASE.updateNotices`): it reads the latest release's `latest.yml` or `latest-mac.yml` on the same schedule, and when that names a newer version it shows the update pill, menu items and About row, whose Download opens the release page (`src/main/updates/notices.ts`). The app reads all of this as `RELEASE` (`src/shared/release.ts`).

### Signing and notarization

Each piece is used only when its variables are present. Otherwise that step is skipped with a warning. A `--publish` run refuses to publish an unsigned macOS or Windows build, or a macOS build that isn't notarized.

| Platform | Variables |
|---|---|
| macOS signing | `ATELIER_SIGN_IDENTITY`: a keychain identity by SHA-1 (`<SHA-1>`) or by name (`Developer ID Application: Your Name (TEAMID)`, with or without the `Developer ID Application: ` prefix). `CSC_NAME` works the same way. Or `CSC_LINK` (a base64 `.p12`) with `CSC_KEY_PASSWORD` |
| macOS browser passkeys | `ATELIER_PROVISIONING_PROFILE` (the Developer ID `.provisionprofile`), and `ATELIER_TEAM_ID` (`<TEAMID>`). See "Browser passkeys and iCloud Passwords" |
| macOS notarization | One of: `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`; `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`; or `APPLE_KEYCHAIN_PROFILE`, a notarytool profile in your keychain (`<notary-profile>`, see below) |
| Windows, certificate | `WIN_CSC_LINK` (or `CSC_LINK`) with `WIN_CSC_KEY_PASSWORD` |
| Windows, Azure Trusted Signing | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `ATELIER_AZURE_ENDPOINT`, `ATELIER_AZURE_ACCOUNT`, `ATELIER_AZURE_CERT_PROFILE` and `ATELIER_AZURE_PUBLISHER` |
| Publishing | `GH_TOKEN` |

Notes on how signing behaves:
- **`electron-builder.yml` keeps `mac.identity: null`,** so a plain `npm run package` never signs with whatever your keychain holds. `electron-builder.config.mjs` lifts this only when `ATELIER_SIGN_IDENTITY`, `CSC_NAME` or `CSC_LINK` is set (in the environment, or in `internal/release.env`). `npm run package` and `release.mjs` both use it, so they build the same thing from the same env.
- **One identity, never ambiguous:** a keychain can hold more than one valid certificate with the same name, such as a renewed "Developer ID Application: Your Name (TEAMID)" next to the one it replaces. electron-builder would sign with whichever `security find-identity` lists first. `scripts/release/identity.mjs` resolves a name to one SHA-1 before electron-builder sees it: the only match, else the preferred certificate (`ATELIER_SIGN_IDENTITY` when it is a `<SHA-1>`; there is no built-in one) when it is one of them, else an error listing the hashes. Setting `ATELIER_SIGN_IDENTITY` to a `<SHA-1>` skips the guess, and then wins over a name in `CSC_NAME`. electron-builder 26 would still hand codesign the name, so signed builds sign through `scripts/release/sign.mjs` (`mac.sign`), which keeps the hash. codesign is always called with a hash.
- **What gets signed:** the app runs under the hardened runtime, with `build/entitlements.mac.plist` (JIT, microphone, camera, location, calendars). Everything nested inside it gets `build/entitlements.mac.inherit.plist`: the Electron helpers, atelier-speech, the calendar helper, the translate helper and the haptics addon. Neither file may hold a restricted entitlement; a test and the preflight enforce it. A signed build also signs its dmg.
- **What gets notarized and stapled:** electron-builder notarizes and staples the app. `release.mjs` (`npm run package:mac` and `npm run release`) then notarizes and staples each dmg. Stapling changes the dmg, so `release.mjs` writes its new sha512 and size into `latest-mac.yml` and drops its stale blockmap. A plain `npm run package` notarizes the app only.
- **A notarytool keychain profile** keeps the Apple ID password out of the environment. Store it once, under a name you choose: `xcrun notarytool store-credentials <notary-profile> --apple-id <apple-id> --team-id <TEAMID>` (it asks for an app-specific password from account.apple.com). Then `export APPLE_KEYCHAIN_PROFILE=<notary-profile>`.

### Signing modes (macOS)

`scripts/release/entitlements.mjs` picks one from the environment. `node scripts/release/preflight.mjs` prints which, without building anything; `npm run package` starts with it.

| Mode | When | What the app is signed with |
|---|---|---|
| Unsigned (the default) | no `ATELIER_SIGN_IDENTITY`, `CSC_NAME` or `CSC_LINK` | Nothing from electron-builder; the fuses step re-signs ad hoc. No restricted entitlements. |
| Developer ID | an identity is set | Hardened runtime, `build/entitlements.mac.plist`, notarized when the notarization variables are set. |
| Developer ID + browser passkeys | an identity and `ATELIER_PROVISIONING_PROFILE` | The profile embedded as `Contents/embedded.provisionprofile`, and a generated `build/generated/entitlements.mac.passkeys.plist`: the base entitlements plus `com.apple.developer.web-browser.public-key-credential`, `com.apple.application-identifier` = `<TEAMID>.<bundle id>`, `com.apple.developer.team-identifier` = `<TEAMID>`, and `keychain-access-groups` = `<TEAMID>.<bundle id>.webauthn` for Touch ID passkeys (left out, with a warning, when the profile doesn't allow it). |

macOS refuses to launch an app that claims a restricted entitlement without a profile that grants it, so restricted keys are only ever written next to that profile. A profile without an identity is an error. Before anything is signed, the preflight decodes the profile (`security cms -D -i`) and stops with every problem it finds: the browser passkey entitlement missing, another team, another bundle id or a wildcard App ID, a development profile, or an expired one. `verify.mjs` checks the result again in the packaged app.

### GitHub Actions

| Kind | Names |
|---|---|
| Secrets | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `MAC_CSC_NAME` (optional), `MAC_PROVISIONING_PROFILE` (optional: the Developer ID `.provisionprofile`, base64), `APPLE_API_KEY_P8` (the key's contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| Variables | `ATELIER_PUBLIC_RELEASE` (optional, default `1`), `ATELIER_SUPPORT_EMAIL`, `ATELIER_WEBSITE`, `ATELIER_TEAM_ID` (`<TEAMID>`), `ATELIER_BUNDLE_ID` (optional, `<bundle id>`), `ATELIER_AZURE_ENDPOINT`, `ATELIER_AZURE_ACCOUNT`, `ATELIER_AZURE_CERT_PROFILE`, `ATELIER_AZURE_PUBLISHER` |

The owner and repo come from the repository itself. `GITHUB_TOKEN` uploads the release files. Every job in `release.yml` runs only when `github.repository` is `3SENN/atelier`, and `ATELIER_OFFICIAL_BRANDING` is `1` only there: a fork that pushes a tag gets no release, and never one with the official branding ([TRADEMARKS.md](../TRADEMARKS.md)).

CI (`ci.yml`) also has a **signed macOS build** job. It runs only when `MAC_CSC_LINK` is set, so forks and pull requests from them skip it. It imports the certificate (`CSC_LINK`; a CI keychain holds just that one, so no hash is needed), writes `MAC_PROVISIONING_PROFILE` to a file when present (the passkeys mode), notarizes when the API key or Apple ID secrets are there, then runs `verify.mjs --no-smoke` and prints the signed entitlements. Nothing is uploaded. A `notarytool` keychain profile is a local convenience; CI uses the API key.

## Local builds

- **`npm run package:mac`** (or `:win` and `:linux` on those systems) builds the app, the native helpers and the licence list, then packages an unsigned build into `dist/`. Building for another OS isn't supported, because the helpers need swiftc and dotnet.
- **`npm run smoke:packaged`** runs the smoke test inside the packaged, fused app.
- **`node scripts/release/verify.mjs --no-smoke`** checks the resources, Info.plist, signatures and fuses of every arch under `dist/`, without the smoke test (which runs the arch this machine launches natively).
- **A signed test build:** `ATELIER_TEAM_ID=<TEAMID> ATELIER_SIGN_IDENTITY=<SHA-1> npm run package`. Add `APPLE_KEYCHAIN_PROFILE=<notary-profile>` and use `npm run package:mac` to notarize the app and the dmgs too. Without notarization, Gatekeeper blocks it on other Macs.

## Browser passkeys and iCloud Passwords

**Why.** Apple's iCloud Passwords helper (the native host Apple's "iCloud Passwords" extension talks to) only starts under a parent process that is either signed with `com.apple.developer.web-browser.public-key-credential` or on Apple's own list of browsers. The same entitlement lets a browser offer iCloud Keychain passkeys for any website, as Chrome does. Apple grants it per account, on request, and only the Account Holder can ask. Until Atelier is signed with it, Settings › Passwords and autofill › Apple Passwords says "Needs a signed Atelier with Apple's browser passkey permission" when macOS refuses to start the helper, and passkeys keep the fast refusal path.

### Step by step

1. **Find your Team ID.** developer.apple.com › Account › Membership details › Team ID. That is `<TEAMID>`; put it in `ATELIER_TEAM_ID`.
2. **Register the App ID `<bundle id>`.** Certificates, Identifiers & Profiles › Identifiers › + › App IDs › App. Choose the macOS platform, the description "Atelier" and the explicit bundle ID `<bundle id>` (the value of `ATELIER_BUNDLE_ID`), then Register. The API route below (`npm run asc -- --apply`) does the same.
3. **Ask for the entitlement, as the Account Holder.** Apple's page for it is [com.apple.developer.web-browser.public-key-credential](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential). Use the request link there (the "macOS browser passkeys" / "Web Browser Public Key Credential" request). Sign in as the Account Holder, name the App ID `<bundle id>`, and describe Atelier as a web browser that makes WebAuthn requests for the sites people visit. **Expect a wait.** Approval can take days or weeks, and the request may still show "submitted" after it is approved. The reliable sign is the next step: the capability shows up on the App ID.
4. **Turn it on for the App ID.** Identifiers › `<bundle id>` › Additional Capabilities: tick the browser passkey capability, then Save. Apple documents no API capability type for it, so this step is always in the portal.
5. **Developer ID Application certificate.** If your login keychain doesn't hold one yet: Certificates › + › Developer ID Application, upload a CSR from Keychain Access, download the certificate and double-click it. `security find-identity -v -p codesigning` lists the hashes; the one you sign with is `<SHA-1>`, for `ATELIER_SIGN_IDENTITY`.
6. **Developer ID provisioning profile.** Profiles › + › Distribution › Developer ID › App ID `<bundle id>` › the certificate above. Give it a name such as "Atelier Developer ID <bundle id>", then Generate and Download. Its path goes in `ATELIER_PROVISIONING_PROFILE`. Make a new profile whenever the App ID's capabilities change: an old profile doesn't carry a new capability. Or use `npm run asc -- --apply --recreate`.
7. **Notarization credentials.** Pick one: the keychain profile (`xcrun notarytool store-credentials <notary-profile> --apple-id <apple-id> --team-id <TEAMID>`, then `APPLE_KEYCHAIN_PROFILE=<notary-profile>`), the App Store Connect API key below, or `APPLE_ID` with `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID=<TEAMID>`.
8. **Set the variables and build.**
   ```sh
   unset ELECTRON_RUN_AS_NODE
   export ATELIER_TEAM_ID=<TEAMID>
   export ATELIER_BUNDLE_ID=<bundle id>          # leave unset for com.sennechin.atelier
   export ATELIER_SIGN_IDENTITY=<SHA-1>          # or "Developer ID Application: Your Name (TEAMID)"
   export ATELIER_PROVISIONING_PROFILE="$HOME/Downloads/<profile>.provisionprofile"
   export APPLE_KEYCHAIN_PROFILE=<notary-profile>
   node scripts/release/preflight.mjs   # the mode, the identity, the profile check; builds nothing
   npm run package                      # signs and notarizes the app (npm run package:mac also notarizes the dmgs)
   ```
   The preflight prints `developer-id-passkeys for <bundle id>, team <TEAMID>, identity <SHA-1>, notarization on`. When it lists a problem, fix that first; nothing has been signed yet.
9. **Verify the build.**
   ```sh
   codesign -d --entitlements - dist/mac-arm64/Atelier.app
   codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Atelier.app
   security cms -D -i dist/mac-arm64/Atelier.app/Contents/embedded.provisionprofile | plutil -extract Entitlements xml1 -o - -
   npx @electron/fuses read --app dist/mac-arm64/Atelier.app
   node scripts/release/verify.mjs --no-smoke
   ```
   The entitlements must list `com.apple.developer.web-browser.public-key-credential` (true), `com.apple.application-identifier` `<TEAMID>.<bundle id>` and `com.apple.developer.team-identifier` `<TEAMID>`. The fuses must match `electron-builder.yml` (RunAsNode off, cookie encryption on, asar integrity on, and so on). `verify.mjs` checks the entitlements against the signing mode, the bundle id and the embedded profile, too.
10. **Notarize, then check Gatekeeper.** With notarization configured, electron-builder notarizes and staples the app, and `npm run package:mac` or `npm run release` does each dmg. Then:
    ```sh
    xcrun stapler validate dist/mac-arm64/Atelier.app
    spctl -a -vv -t exec dist/mac-arm64/Atelier.app                          # source=Notarized Developer ID
    xcrun stapler validate dist/Atelier-<v>-arm64.dmg
    spctl -a -vv -t open --context context:primary-signature dist/Atelier-<v>-arm64.dmg
    ```
11. **Test it.** Install from the dmg into /Applications and open it.
    - **iCloud Passwords:** Settings › Passwords and autofill › Apple Passwords. Turn it on, then type the 6-digit code macOS shows into the extension's popup. The status reaches "Ready". "Needs a signed Atelier…" now means the running app isn't the one you just verified.
    - **Passkeys:** at a passkey test site (webauthn.io, or your own account's passkey settings), create a passkey. The system sheet offers iCloud Keychain. Sign out, then sign in with it. Diagnostics logs "Passkeys are on" with `platformPasskeys: true`. A bare NotAllowedError with "ASAuthorizationError 1004" in DevTools means the running signature lacks the entitlement.

### The App Store Connect API (optional)

One API key can notarize and also register the bundle id and make profiles, without the portal (apart from step 4).
- **Make a key:** App Store Connect › Users and Access › Integrations › App Store Connect API › Team Keys › +. Give it a role that may manage certificates, identifiers and profiles (Admin is simplest). Download the `.p8` (Apple offers it once), and note the Key ID and the Issuer ID at the top of the page.
- **Use it:**
  ```sh
  export APPLE_API_KEY="$HOME/.appstoreconnect/AuthKey_<KEYID>.p8" APPLE_API_KEY_ID=<KEYID> APPLE_API_ISSUER=<issuer-uuid>
  npm run asc                          # dry run: reads only, and prints what it would change
  npm run asc -- --apply               # registers <bundle id>, makes the Developer ID profile and writes it
  npm run asc -- --apply --recreate    # after step 4: a fresh profile that carries the capability
  ```
  `scripts/release/asc.mjs` refuses to run without all three variables, and sends nothing then. It calls `bundleIds`, `bundleIdCapabilities` (only for `--capability <TYPE>` you name), `certificates` and `profiles`. It picks the Developer ID certificate whose SHA-1 is your signing identity, writes the profile to `build/generated/<bundle id>.provisionprofile` (gitignored), checks it with the build's preflight, and prints the `ATELIER_PROVISIONING_PROFILE` line to export. The same three variables notarize.

### What the entitlement turns on in Atelier

At startup Atelier reads its own executable's code signature (`src/main/codeSignature.ts`: the embedded signature's team and entitlements, once, no subprocess). When it is signed by a team with the browser passkey entitlement:
- **Passkeys:** `app.configureWebAuthn({ platformPasskeys: true })`, plus Touch ID when the keychain group is there. The page preload stops refusing what only a passkey sheet could answer, because there now is one (top frames and same-origin frames; Apple's sheet can't serve cross-origin iframes, which Touch ID still can). Conditional (autofill) requests still wait, as Chrome does with nothing to list.
- **Apple Passwords:** the card knows macOS will start the helper, so a closed connection reads as the helper's own doing, not as a missing signature.

Without the entitlement, nothing changes. What Electron 45 offers, as found in its API and its framework binary:
- `app.configureWebAuthn({ touchID })`: Electron's own Secure Enclave passkeys, device-bound and never synced, which need the `<TEAM>.<bundle>.webauthn` keychain group.
- `app.configureWebAuthn({ platformPasskeys: true })`: Apple's `ASAuthorizationController`, the system passkey sheet (iCloud Keychain and credential provider extensions such as 1Password). Electron documents it for apps with associated domains. The browser entitlement is what lets macOS serve any relying party. Electron's limits: no cross-origin iframes, no `prf` or `largeBlob`, and `clientDataJSON` names `https://<rpId>` as the origin, so a relying party that checks the exact origin of a subdomain page may refuse it.
- With both on, Electron uses platform passkeys unless a `select-webauthn-authenticator` listener chooses (Atelier adds none).
- Chromium's own iCloud Keychain authenticator (`device/fido/mac/icloud_keychain`, which checks the same entitlement) is compiled into Electron Framework. But Chrome's WebAuthn request delegate is what starts it, and Electron exposes no switch or feature flag for it, so Atelier uses `platformPasskeys`.

### Moving from com.atelier.browser

The official app id moved from `com.atelier.browser` to `com.sennechin.atelier`. Your data stays where it was: `~/Library/Application Support/Atelier` is named after the product name, not the app id. macOS keys some things by app id, so they start over once: the microphone, camera, calendar and speech permissions ask again, and Atelier must be chosen as the default browser again. On Windows the AppUserModelId changes with it, so pinned taskbar icons and notifications group under the new id after reinstalling.

## Cutting a release

1. **Pick the version.** A beta is `x.y.z-beta.N`; a stable release is `x.y.z`. Set it in `package.json`.
2. **Add a what's-new entry** for exactly that version in `src/shared/whatsNew.ts`. `release.mjs` refuses a release without one.
3. **Check the build:** run `npm run typecheck`, `npm test`, `npm run smoke` and `node scripts/app-icons/generate.mjs --check`.
4. **Commit, tag `v<version>` and push the tag** yourself. `.github/workflows/release.yml` then:
   1. checks that the tag matches `package.json` and opens a draft release;
   2. builds macOS (both architectures in one job, so one `latest-mac.yml` lists both), Windows and Linux;
   3. on each, runs `scripts/release/release.mjs --publish`. That script checks the branding (official only), the version, the what's-new entry and the tag. It builds with the release defines, builds the native helpers (atelier-speech, haptics, the calendar helper, and the Windows helper with .NET 8) and the licence list, then packages, signs and notarizes. Next it writes `SHA256SUMS` and `atelier-support.json`, and runs `verify.mjs`: codesign, spctl, stapler, Authenticode, the fuse check, Info.plist, the resources, and the smoke test inside the packaged app. A public build must also pass "release: a public build offers your Claude subscription and the API key". Only when every check passed does it upload the installers, blockmaps and `latest*.yml` to the draft, with the GitHub CLI (`gh`);
   4. adds one `SHA256SUMS` and `atelier-support.json` covering every platform.
5. **Review the draft on GitHub,** install it on a clean machine, then publish it. Until it's published, nobody's updater sees it.

To release without CI, push the tag first, set the variables above, install `gh`, and run `npm run release -- --publish` on each platform. It opens the draft when it's missing, but never creates the tag (`gh release create --verify-tag`). Then run `node scripts/release/checksums.mjs <folder with all installers>` and `node scripts/release/support-feed.mjs --out <folder>/atelier-support.json`, and upload both by hand. `--skip-verify` never publishes.

### Checking a download

Run this in the folder that holds the download and `SHA256SUMS`:
- macOS: `shasum -a 256 -c SHA256SUMS --ignore-missing`
- Linux: `sha256sum -c SHA256SUMS --ignore-missing`

## Rolling back

Updates only move forward, so a bad release is replaced, not withdrawn:
1. **Stop new installs:** unpublish the bad release (or mark it as a pre-release), so the updater stops offering it.
2. **Ship a fix:** release a higher version, with the previous good code or a fix.
3. **Move everyone on the bad version:** add `{ "below": "<fixed version>", "message": "…" }` to `scripts/release/support.json`, and publish it with the fixed release. Its `atelier-support.json` tells every older Atelier it's unsupported. Atelier then shows "Update now", which can be snoozed for three days.

`node scripts/release/support-feed.mjs --below 1.2.1 --message "…"` adds an entry for a single run. Messages are plain text, at most 280 characters.

## Icons and licences

- **`npm run icons`** redraws every icon from `scripts/app-icons/` into `branding/official/` and `branding/unofficial/` (see [architecture › Branding](architecture.md#branding)) and updates their hash manifests. The logo is Pip, Atelier's default companion: `node scripts/app-icons/render-pip.mjs` renders Pip's head and full body with the app's own companion renderer (hidden Electron, no network) into `branding/official/art/`, which is committed, and the generator draws everything from those masters. Re-render only when Pip's look or the renderer changes. `node scripts/app-icons/generate.mjs --previews <dir>` writes the logo variants and small-size sheets for review. It covers the app icon, Icon Composer document, `.icns` and `.ico`, the Linux set, tray images, document icons, DMG background and NSIS sidebar. CI fails when the committed files are stale. On macOS 26, `scripts/release/afterPack.mjs` compiles the official branding's `branding/official/Atelier.icon` with Xcode 26's actool into `Assets.car`, and sets `CFBundleIconName`. Older Xcode keeps `icon.icns` only.
- **`npm run licenses`** writes `src/renderer/public/licenses.json` for About › Licences: every production package in `package-lock.json` that is installed here, plus React and Electron, the native helpers' packages and the companion art's own licence (`ART-LICENSE.md`). The release rewrites it before packaging, then runs `node scripts/licenses.mjs --check`, which fails on a stale list, a missing package, or a licence Atelier can't ship (GPL, AGPL, LGPL, SSPL and patron licences). MPL-2.0 and OFL-1.1 pass, since they ship unmodified with their notices. `verify.mjs` checks that the asar carries the list.

## Public builds

A public release offers both engines: the API key and your Claude subscription, which runs the Claude Code that people install from Anthropic ([claude-subscription.md](claude-subscription.md)). It never bundles Claude Code: the maintainer's private packaging step that can bundle it in a personal build refuses `ATELIER_PUBLIC_RELEASE=1`.

The packaged smoke test fails a public release that doesn't offer both engines.

## Troubleshooting

- **"skipped macOS notarization":** the `APPLE_*` variables are incomplete. The API key and Apple ID sets each need all three; a keychain profile needs `APPLE_KEYCHAIN_PROFILE`.
- **"… your Apple Team ID: set ATELIER_TEAM_ID":** the passkeys mode, `asc.mjs` or `verify.mjs` needs `<TEAMID>`. Set it in the environment (or, for official builds, in `internal/release.env`).
- **"is ambiguous: 2 identities carry it":** two certificates share a name and no `<SHA-1>` says which one to use. Set `ATELIER_SIGN_IDENTITY` to the SHA-1 from `security find-identity -v -p codesigning`.
- **codesign fails with `errSecInternalComponent`:** codesign may not use the certificate's private key from where it runs. The login keychain is locked, or the key's access list wants a "codesign wants to sign using key…" approval that a terminal without a GUI prompt can't show. Run the build once in Terminal.app and choose Always Allow. Or, in Keychain Access, open the private key under your Developer ID Application certificate › Get Info › Access Control and add `/usr/bin/codesign`. Or run `security unlock-keychain ~/Library/Keychains/login.keychain-db` followed by `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <your login password> ~/Library/Keychains/login.keychain-db`. Check it with `codesign --sign <SHA-1> --force <a copy of /bin/echo>`.
- **A signed Atelier is killed at launch ("Killed: 9", or "Launch Constraint Violation" in Console):** it claims a restricted entitlement its embedded profile doesn't grant, or the profile is for another certificate or bundle id. Run `node scripts/release/preflight.mjs` with the same env, and `security cms -D -i Atelier.app/Contents/embedded.provisionprofile`.
- **The preflight says the profile "doesn't grant com.apple.developer.web-browser.public-key-credential":** Apple hasn't approved the request yet, the capability isn't ticked on the App ID, or the profile predates it. Make a new profile after step 4.
- **Apple Passwords says "Needs a signed Atelier with Apple's browser passkey permission":** macOS killed the helper at exec, or it left at once without a word. That is expected for unsigned and plain Developer ID builds.
- **The Dock shows a generic icon:** `CFBundleIconName` names something that isn't in `Assets.car`. `verify.mjs` checks that they match.
- **Linux smoke fails with a sandbox error:** Ubuntu 24.04 blocks unprivileged user namespaces. Run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`; CI does this already.
- **The haptics addon fails to build:** the release continues without it, with a warning. Haptics are optional.
- **The microphone, camera or calendar is refused only in a signed build:** check that the entitlement files and the usage strings in `mac.extendInfo` are present. `verify.mjs` checks the usage strings.
