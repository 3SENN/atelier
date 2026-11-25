# Privacy

Atelier runs on your computer. It has no Atelier account, no analytics, no telemetry and no Atelier server: nothing you do in
Atelier is sent to the Atelier project. Besides the sites you visit, the app contacts only the services listed below, and
most of them only when you turn a feature on or use it. Builds with the unofficial branding (Summit) behave the same.

## What Atelier keeps on this computer

Everything lives in Atelier's data folder (`~/Library/Application Support/Atelier` on macOS, `%APPDATA%\Atelier` on Windows,
`~/.config/Atelier` on Linux; a build named Summit uses a `Summit` folder):

- **Browsing data:** history, bookmarks, open tabs and windows, downloads, site settings and permissions, and each
  profile's cookies, cache and site storage (in Chromium's own storage, one partition per profile).
- **Your companion's data:** chats, memory, companions, skills, routines, connectors, apps and installed packs, the
  workspace and its search index, and, when you turn it on, activity memory.
- **Meetings:** recordings and transcripts of meetings you record.
- **Secrets, encrypted with your system keychain** (macOS Keychain, Windows DPAPI, the Linux secret store): your API
  keys, connector tokens, saved passwords, addresses and cards (your own details in Settings › You are one of those
  addresses, not a copy), pack keys and pack sign-ins.
- **Settings and usage:** your settings, and how much you spent on model calls.
- **Logs:** a local log for troubleshooting, rotated at 2 MB, with keys, tokens, URL queries and your home folder
  removed. Crash dumps are written only when you turn crash reports on, and stay on this computer.

Importing from another browser only reads that browser's files on this computer and changes nothing there; saved
addresses go into the encrypted wallet, and payment cards are never imported (their tables are never queried).

Settings › Reset clears your data and settings. Uninstalling the app leaves the data folder; delete it by hand to
remove everything.

## What Atelier contacts, and when

| Service | Why | When | What is sent |
|---|---|---|---|
| **Your model provider**: Anthropic (`api.anthropic.com`), or your organisation's gateway when a policy sets one | The companion: chats, routines, memory, meeting summaries, quick asks, translation with the companion | When you have added a key and use the companion | Your messages and what the companion needs for them: the page and tab content it reads, attachments, the tools it may use, and your key. Your name, email, phone and address from Settings › You go into new chats unless you turn "Your companion knows these" off there, and each such chat keeps them with its conversation on this computer; changing them or turning that off applies to new chats. Private chats never include them. Anthropic's SDK adds the OS, architecture and runtime version. Anthropic's privacy policy applies to what it receives |
| **Your Claude subscription**: Claude Code, Anthropic's own program on your computer | The companion, as above, when you choose your Claude subscription as the engine | Only when you choose it in Settings › Model and key | Atelier hands your messages and what the companion needs for them to Claude Code on your computer, and Claude Code sends them to Anthropic under your own Claude account, under Anthropic's terms and privacy policy. Atelier never sees or stores your Claude sign-in |
| Anthropic's **web search and web fetch** tools | Searching the web and reading pages for the companion | During chats, while web tools are on (the default) | Search queries and addresses, run on Anthropic's side |
| **Quick-decision providers** you add (Typesafe, OpenRouter, Experiential Labs, OpenAI, or your own server) | Fast decisions, such as what a new-tab entry means | Off unless you add a provider and a key | The short text being decided on, and your key |
| **Atelier's own models** on Hugging Face (`huggingface.co/3SENN/atelier-decisions`) | Downloading atelier-mini (new kinds of questions) and atelier-step (browser tasks); the small decision model comes with Atelier | Only when you press Download in Settings › Quick decisions › On this computer | Plain downloads of the model files, through your system's proxy. The models then run on this computer: what they decide on never leaves it |
| **Connectors (MCP servers)** you add | Tools for the companion | Only connectors you add | Tool calls and their results, and the sign-in (OAuth) exchange with the connector. Remote connectors that sign in with a token are called by Anthropic on Atelier's behalf, so that token goes to Anthropic with the request. Local connectors run on your computer and can reach whatever they are built to |
| **GitHub releases** (`github.com/3SENN/atelier/releases`) | Updates, and the list of versions that are no longer supported | Release builds only: at start, every 4 hours, on wake and when you come back online | Ordinary download requests (the version and file names), no cookies or identifiers |
| **Ad and tracker blocker lists** (`raw.githubusercontent.com/ghostery/adblocker`) | The blocker's filter lists | At start, while blocking is on (the default), only when no cached copy exists | Plain downloads |
| **Cookie-banner lists** (`secure.fanboy.co.nz`, `ublockorigin.github.io`) | Hiding cookie banners | Off unless you choose lists; then checked daily, refreshed weekly | Plain downloads |
| **Search suggestions** from your search engine (Google, DuckDuckGo, Bing, Ecosia or Brave) | Suggestions while you type in the address bar | Off unless you turn them on | What you type, without cookies |
| **Your search engine** | Searching from the address bar | When you search | Your query, as an ordinary page visit |
| **Chrome Web Store** (`clients2.google.com` and Google's download servers) | Installing and updating Chrome extensions, and importing extensions from Chrome | When you install or import one; update checks every 5 hours only while store extensions are installed | Extension ids and versions, and the Chromium version |
| **Spell-check dictionaries** (Google's servers, as in Chrome) | Spell checking | Windows and Linux, for your languages (macOS uses the system's) | Dictionary downloads |
| **Pack indexes** (`raw.githubusercontent.com/3SENN/atelier-packs`, and any index you add) | Browsing, installing and updating packs | When you open Browse or install a pack; a daily update check for packs installed from an index or with an update address | Plain downloads; a private organisation index also gets its token |
| **Hosts an installed pack declares** | What the pack does, and its sign-ins | Only packs you install, only to the hosts their review showed you | Whatever the pack sends |
| **Sites you visit or point at** | Pages, link previews, page attachments, saved web apps, favicons, connector icons | When you browse or use those features | Ordinary requests to that site |
| **Apple or Microsoft speech services** | Dictation and meeting transcription | When you use them. macOS transcribes on the device when the language allows and downloads speech models from Apple; otherwise audio goes to Apple. Windows dictation can use Microsoft's online speech service | Audio |
| A DNS lookup of `example.com` | Checking that the connection is back | When the system reports going from offline to online | A DNS query |

Extensions you install can contact whatever their permissions allow. Page translation on macOS uses Apple's on-device
Translation framework; "Translate with your companion" sends the page text to your model provider instead.

## What Atelier never does

- No analytics, usage statistics, telemetry or advertising identifiers.
- No crash or problem uploads: crash dumps stay local, and **Report a problem** makes a zip on your computer and opens
  an email draft that you can read, change and send yourself.
- No account, and no data sent to the Atelier project.
- No user id or profile details added to model requests.

## Servers Atelier runs on your computer

Some features listen for connections on your computer: the sign-in callback for connectors, the local servers packs can
start (on `127.0.0.1`, or on your Wi-Fi with https when a pack asks and you allow it), and "Let Claude Code use Atelier"
(off by default). They accept connections; they don't send anything out.

## Questions

Ask in the repository's issues, or write to [contact@chinnovations.nl](mailto:contact@chinnovations.nl). Report
security problems as described in [SECURITY.md](SECURITY.md).
