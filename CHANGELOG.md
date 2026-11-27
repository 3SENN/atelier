# Changelog

All notable changes to Atelier. Versions follow [semantic versioning](https://semver.org/); dates are release dates.

## Unreleased

- **Pictures, on this computer.** Download Pictures in Settings › Quick decisions › On this computer, and a model on your computer looks at pictures for your companion. Browser tasks can now use buttons that are only an icon, such as a cart, a search or a close button the page gives no name: the model names them from how they look, and leaves alone the ones it isn’t sure of. Your companion can also sort or check many pictures on a page at once, such as which album a photo belongs in or which attachments are receipts, and find the ones that fit a description, in a fraction of a second each. The model only chooses among the answers it is given and writes nothing; whatever it isn’t sure of goes back to your companion. Nothing it looks at leaves your computer.

## 1.7.2 (2026-11-25) — Windows tells you about updates

- **Atelier on Windows tells you about new versions.** The Windows installer isn’t code-signed yet, so Atelier can’t update itself there. It now checks for new versions, at start and every few hours, and shows Get update when one is out. The button opens the download page, and you run the installer; your windows, tabs and settings stay. Settings › About says when Atelier is up to date and has Check for updates, as on Mac. If you have 1.7.1 or older on Windows, download 1.7.2 once from the website; after that, Atelier tells you.

## 1.7.1 (2026-11-25) — Menus open again

- **Menus open again.** Switch chat, Extensions and the site suggestion button could open as a thin line or not show at all, until a full-window dialog had been open. They now always open at full size, under the button you clicked, and take your clicks.
- **Atelier’s models, by name.** Settings › Quick decisions names each model on this computer and its version: atelier-nano, atelier-mini for new kinds of questions and atelier-step for browser tasks. Under atelier-nano it says when atelier-mini helps it. On this computer has one model, so the field for typing another model’s name is gone there.
- **Tidier forms and switches.** In forms such as the address and card dialogs, fields side by side line up and stacked fields are evenly spaced; the proxy form in Settings › Network has its buttons at the end. Switches in Settings read like the rows around them, and a switch in a form like its other fields.

## 1.7.0 (2026-11-25) — Atelier’s own models

- **Quick decisions on this computer.** Atelier now has its own small decision model, built in. It needs no key and no account, answers in a few milliseconds, and nothing it decides leaves your computer. Turn it on in Settings › Quick decisions › On this computer. For new kinds of questions, a larger model is an optional download there.
- **Browser tasks, page by page.** Download Browser tasks in Settings › Quick decisions › On this computer, and your companion hands routine stretches of a task to a small model on your computer: adding something to the cart and going to checkout, filling in a form, following a search. It takes about a tenth of a second a page. Whatever it isn’t sure of, paying, and any click the task didn’t ask for go back to your companion, and every click passes the same checks and approvals as your companion’s own.
- **Your details, in one place.** Add your name, email, phone and address once in Settings › You. Forms offer them first, and your companion knows them, so it can fill in a form or order for you without asking. They are one of your saved addresses, encrypted with your keychain, not a copy; a chat that knows them keeps them with the conversation. Turn off Your companion knows these to keep them out of new chats; private chats never include them.
- **Addresses come along.** Importing from Chrome, Edge, Brave, Arc, Vivaldi or Firefox now brings your saved addresses too. Cards never come over. An address you already have isn’t added twice, and saving a form with an address you already have fills in the one you saved.
- **Profiles say what they share.** Passwords, addresses and cards are shared by all your profiles. The Profiles page now says so, and deleting a profile no longer mentions logins it won’t delete.
- **Reset starts setup fresh.** After Settings › Reset, setup now really starts again, without your earlier answers.

## 1.6.1 (2026-11-19) — Updates work

- **Atelier updates itself.** On Mac, Atelier couldn’t check for new versions and showed Update failed: no release could update itself so far. It now finds new versions and updates itself. If you have 1.6.0 or older, download 1.6.1 once from the website; after that, updates come by themselves. (The Windows installer isn’t code-signed yet, so it doesn’t update itself; download new versions from the website.)

## 1.6.0 (2026-11-19) — Your Claude subscription

- **Use your Claude subscription.** Companions can now run on your own paid Claude plan, next to your Anthropic API key. Atelier runs Claude Code, Anthropic’s own program, on your computer, signed in with your own Claude account through Anthropic’s own sign-in; Atelier never sees it. Choose it in Settings › Model and key. If Claude Code isn’t installed yet, How to install Claude Code opens Anthropic’s guide.
- **No step limit.** A long task pauses for Continue after 60 steps. Turn on No step limit in Settings › Model and key to let it keep going until it’s done or you press Stop. The pause card has a button to the setting.
- **Check what matters.** Companions can get things wrong. The welcome and Settings › Model and key now remind you to check important facts before you rely on them.
- **All of it open source.** The code that runs Claude Code is now part of Atelier’s open-source code, in every build.

## 1.5.0 (2026-11-17) — Apex is now Atelier

- **Apex is now Atelier.** The same browser, the same companion and everything you made, under a new name. An atelier is where you make things your own, and that is what Atelier is for.
- **Packs have a new file type.** Packs, apps, worlds and companions you share are now .atelierpack, .atelierapp, .atelierworld and .ateliercompanion files.
- **Settings save while a page loads.** Changing a setting while a tab was loading a page could fail. It now always saves, and changing other settings no longer refreshes every page’s permissions.
- **Up to date.** Atelier now runs on Electron 45.3.2, with the newest Anthropic SDK and fixes in the libraries it uses.

## 1.4.5 (2026-11-17) — Atelier is open source

- **Atelier is open source.** The whole browser and its companion are now free and open source. Read the code, build it yourself or help make it better: Settings › About shows where to find it.
- **Boosts are now Tweaks.** Site tweaks are what boosts used to be, and Hide element is the new name for the zapper. Everything you made keeps working.
- **Reviews show everything a companion says.** Importing a companion or installing a pack now shows everything it tells the assistant: each skill’s instructions and steps, and each routine’s prompt.
- **Phone controllers keep up.** A button you let go of on a phone controller always reaches the game, even after a long session.
- **The side panel has room for its title.** On Windows and Linux, the side panel no longer squeezes its title to make room for window buttons that aren’t there.
- **Runs on your API key.** Atelier’s companion runs on Claude through your own Anthropic API key. If you used Claude Code before, add a key in Settings › Model and key.
- **Security updates.** The libraries Atelier uses for its local servers and connections now include the latest security fixes.

## 1.4.4 (2026-11-12) — Tab drags stay on your screen

- **No more black screen when you drag a tab.** Dragging a tab could slide your Mac to an empty black desktop with only the tab on it. The tab now stays with you, on the screen you are working on.

## 1.4.3 (2026-11-12) — Drop a tab beside the page

- **Drop a tab to split the view.** Drag a tab from the sidebar, or from the floating sidebar, onto the left or right of the page, and it opens there side by side.
- **Fewer surprise windows.** A tab let go just past the window’s edge now stays where it was, and a drag you cancel with Escape no longer splits the page.

## 1.4.2 (2026-11-12) — Your tabs in the floating sidebar

- **The floating sidebar lists your tabs.** With the sidebar hidden, the one that slides in at the window’s left edge now shows all your tabs, and keeps up as you open and close them.

## 1.4.1 (2026-11-11) — Quicker calls, and a sidebar that shows when you reach for it

- **Quick decisions, with a model of your own.** Atelier makes small calls all day, like whether a reply is waiting on you or whether to search or ask. In Settings › Quick decisions you can let small decision models make them, from the providers you pick, in your order. It stays off until you turn it on.
- **Group tabs.** Group your tabs by site, or by topic with a decision model, from the tab menu or the command bar. Undo puts them back.
- **The hidden sidebar shows again.** With the sidebar hidden, moving to the window’s left edge shows it and keeps it there, instead of flickering away.
- **Sites that ignored every click.** With Hide cookie banners on, sites using TrustArc’s newer cookie popup, like digitalocean.com, took no clicks. Atelier now declines that popup and the page works.
- **PDFs on Linux.** Reading a PDF no longer crashes Atelier.

## 1.4.0 (2026-11-09) — Apps that run a little server of their own

- **A web server for your apps.** An app can start its own small web server on this computer, or on your Wi-Fi when you allowed that at install, to serve pages to your phone or another computer and talk with them live.
- **Phones as controllers.** Build from the new Phone controller starter: scan the code with your phone, and its tilt and buttons reach your app as you move.
- **Always in view, one tap to stop.** While an app shares something, Atelier shows a bar over its tab with how many are connected and a Stop button.

## 1.3.4 (2026-11-06) — Steadier, on Mac and Windows

- **Dragging a tab shows it again.** When you drag a tab, a chip with its name follows your pointer again.
- **Send is never held up.** An attachment could stay on “Preparing…” after it was ready and keep Send waiting. It now shows ready as soon as it is.
- **Web apps open where they belong.** A web app opens back in the tab it was saved from, never in a private window.
- **Closing the last window.** Closing Atelier’s last window quits Atelier, or keeps it in the tray when it runs in the background, and your tabs are back the next time.
- **Recordings that survive a crash, on Windows too.** If Atelier crashes, Windows shuts down or you sign out mid-meeting, the recording is saved, or put back together the next time Atelier starts.

## 1.3.3 (2026-11-06) — Packs and Workspace, made simple

- **Packs you can tell apart.** Each pack is a card that says what it is: an app, a game, a world, skills, a look, a companion or tools. Filter by type, open it, or turn it on and off right from the card.
- **One pack, one panel.** Click a pack to see what’s inside and what it can do. The technical details stay folded away under About this pack.
- **Workspace in four tabs.** Home, Projects, Files and Apps, with Search everything at the top and Recently deleted beside the tabs. Your tables now live in Files.
- **The timeline is in History.** Your browsing by day moved to History: switch between List and Timeline at the top.

## 1.3.2 (2026-11-06) — Record meetings your way

- **Record audio only.** Settings › Transcription › Meetings: transcribe and take notes, or just record the audio of a meeting, online or in person. You can transcribe a recording later.
- **A recording, even when Atelier can’t transcribe.** With Speech Recognition off, or a language this Mac can’t transcribe, a meeting is recorded as audio instead, and Atelier says why.
- **Recordings that survive a crash.** Quitting mid-meeting saves the recording first. If Atelier crashes or your Mac loses power, the recording is put back together the next time Atelier starts.
- **One language, unless you pick two.** Meetings listen in one language. For meetings where people switch languages, choose a second one in Settings › Transcription.
- **Worlds opens again.** A mistake since 1.2.5 kept Worlds from opening. It opens again, and holding Shift runs.
- **Cards in your language.** Meeting cards, the recording widget and the wrap-up now follow Atelier’s language.

## 1.3.1 (2026-11-05) — Meetings in two languages, and your apps your way

- **Meetings in two languages.** Meetings listen in your second language at the same time, so when someone switches between English and Dutch, each part is written in the language that was spoken. Settings › Transcription picks it from your Mac’s languages.
- **Every app in one place.** Workspace › Apps lists your saved websites, apps from packs and apps your companions made. Right-click one to keep it in your sidebar as a row or as just its icon.
- **Packs are easy to find.** Packs is in the sidebar’s More menu, the main menu and the Extensions menu, and Apps has Manage packs.
- **Apps that look like Atelier.** Apps your companions build now use Atelier’s own look in light and dark, and your companion checks each one before saying it’s ready.
- **Smaller fixes.** You can select and copy text in chats, Connectors starts in More, and transcribing a recording no longer loses text when the language changes.

## 1.3.0 (2026-11-05) — A workspace that fits you

- **Setup gets to know you.** Your companion now chats with you during setup about what you do, what you want help with and what you do every week, then shows the workspace it would set up before changing anything.
- **Only what you need.** Your sidebar shows the rows you’ll use, recurring things become routines, and only the apps you use are offered to connect.
- **About you, in Settings › You.** See and change what your companions know about you, match your sidebar to it, or talk it through again.
- **Websites as apps.** Right-click a tab and choose Save as App. Your web apps are listed in Workspace › Apps with the sites you use most, and opening one goes back to its own tab.
- **One place to change a look.** Customize look, from Settings or a new companion, now opens the companion’s card with the bubbles around it.
- **A tidier bookmarks bar.** Long titles shrink to make room before anything moves behind », short ones stay whole, and Open all shows how many it opens.

## 1.2.5 (2026-11-05) — Companions on the move

- **Your companions walk.** On the new tab page they step along when they stroll, and in Worlds you walk around as your companion. Hold Shift to run.
- **Full screen stays full screen.** Clicking another app no longer pulls a playing video out of full screen. It stays until you leave it.
- **The sidebar slides out at the edge.** With the sidebar hidden, move the pointer to the left edge of the window and it slides out, even when the window doesn’t touch the screen’s edge.

## 1.2.4 (2026-11-05) — Your downloads, one click away

- **The downloads list opens again.** Click the downloads button and your files show right under it: open one, show it in Finder, or see them all.

## 1.2.3 (2026-11-05) — Popups show up again

- **Downloads and update notes appear right away.** The downloads list and this card show where they should, without opening the profile menu first.

## 1.2.2 (2026-11-05) — Clear in one go

- **Clear your tabs and chats.** Hover over Your tabs or Chats in the sidebar and press Clear to close them all at once. Pinned ones stay, and Undo brings the rest back.
- **Update notes that wait for you.** This card now shows in full, stays until you close it, and no longer gets in the way of menus or your downloads.

## 1.2.1 (2026-11-05) — Skills of their own

- **A companion keeps its own skills.** Ask a companion to learn how you like something done, and it gives itself a skill only it has. It can improve that skill later, and you save each change.
- **Skills go along when you share.** Sharing or duplicating a companion now takes its skills with it, with their steps and files.

## 1.2.0 (2026-11-05) — Apps, games and worlds

- **Apps and games in Atelier.** Packs can now hold full apps and games that open in a tab. Find them on Packs › Browse, or open an .atelierapp someone sent you. Your companions can play their characters.
- **Build one with your companion.** Ask for an app or a game in any chat. Your companion builds and tests it with you, and Share… saves it as a file you can send.
- **Worlds.** Walk around a place as your companion, talk to the people who live there, and step into places that open apps. Build your own and share it as an .atelierworld.

## 1.1.2 (2026-11-02) — Tab links in chat, and steadier tab drags

- **Go to a tab from the chat.** When your companion mentions one of your tabs, click it to go there, even in another window. A link to a page you already have open goes to that tab.
- **Drag tabs where you mean.** Split view opens where the zones show it will, and the pin target no longer pushes your tabs down when you start dragging.

## 1.1.1 (2026-11-02) — Routines from a chat save again

- **Save a routine your companion suggests.** When your companion proposes a routine in a chat, Save adds it and switches it on, instead of showing an error.

## 1.1.0 (2026-11-02) — Packs: add what you need, and share it

- **Install packs.** Packs add skills, tools, panels, site tweaks, accents and companions in one go. Browse the community index on the Packs page, or open a pack someone sent you.
- **Your companion builds them with you.** Describe what you want on Packs › New pack. Your companion writes and tests it, and you see what it can do before anything is installed.
- **Share what you made.** Share a skill, site tweak, app or companion as a pack, signed with your own key. Updates that ask for more always wait for you.
- **The agent keeps to its own tab.** While your companion works in a page, you can keep using another tab. It works out of sight and never takes yours.

## 1.0.0 (2026-10-31) — Atelier 1.0

- **Pip is the new face of Atelier.** The app icon, menu bar and welcome now show Pip, and the welcome flow keeps the companion clear of every word.
- **Search, translate and read.** Search the web from the address bar or a new tab, translate pages on your Mac, and open articles in a calm reader with read aloud.
- **Sign in like any browser.** Sign-in pages for Google, Microsoft, Apple and others just work, and you can bring your sign-ins over from your old browser.
- **Meetings in any app.** Atelier offers to take notes when a call starts in Zoom, Teams, FaceTime, Slack or a browser tab, with on-device transcription.

## 0.1.0 (2026-10-29) — Atelier, with your companion beside every tab

- **A companion that works in your tabs.** Ask in the side panel and your companion reads, clicks and types in the pages you already have open, asking first before anything that matters.
- **Chats that keep going.** Start a chat, switch to something else, and come back when it needs you. Routines run on their own schedule.
- **Your keys, your computer.** Atelier uses your own Anthropic key. Chats, memory and settings stay on this computer.
- **Updates that wait for you.** Atelier downloads updates in the background and restarts only when you say so. Windows and tabs come back afterwards.
