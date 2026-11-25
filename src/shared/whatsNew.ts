/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME, BRANDING } from './branding'
import type { WhatsNewEntry } from './updates'

// What's new, keyed by version, newest first.
// The release script refuses a release whose package.json version has no
// entry. Keep each highlight to a title and one or two plain sentences: the
// card combines every entry since the version you last saw.
export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    version: '1.7.1',
    date: '2026-11-25',
    title: 'Menus open again',
    highlights: [
      {
        title: 'Menus open again',
        body: 'Switch chat, Extensions and the site suggestion button could open as a thin line, or not at all. They now always open at full size, under the button you clicked.',
      },
      {
        title: `${BRAND_NAME}’s models, by name`,
        body: 'Settings › Quick decisions names each of your models on this computer and its version, and says when atelier-mini helps atelier-nano.',
      },
      {
        title: 'Tidier forms and switches',
        body: 'Fields side by side line up, forms are evenly spaced, and switches in Settings read like the rows around them.',
      },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-11-25',
    title: `${BRAND_NAME}’s own models`,
    highlights: [
      {
        title: 'Quick decisions on this computer',
        body: `${BRAND_NAME}’s own small decision model is built in: no key, a few milliseconds a decision, and nothing leaves your computer. Turn it on in Settings › Quick decisions › On this computer.`,
      },
      {
        title: 'Browser tasks, page by page',
        body: 'Download Browser tasks in Settings › Quick decisions, and your companion hands routine stretches of a task, like checking out or filling in a form, to a small model on your computer.',
      },
      {
        title: 'Your details, in one place',
        body: 'Add your name, email, phone and address once in Settings › You. Forms offer them first, and your companion knows them for tasks you give it.',
      },
      {
        title: 'Addresses come along',
        body: 'Importing from another browser now brings your saved addresses too, never your cards, and nothing is added twice.',
      },
    ],
  },
  {
    version: '1.6.1',
    date: '2026-11-19',
    title: 'Updates work',
    highlights: [
      {
        title: `${BRAND_NAME} updates itself`,
        body: `${BRAND_NAME} couldn’t check for new versions and showed Update failed. It now finds them and updates itself, as it was meant to.`,
        platforms: ['darwin'],
      },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-11-19',
    title: 'Your Claude subscription',
    highlights: [
      {
        title: 'Use your Claude subscription',
        body: `Companions can now run on your own paid Claude plan. ${BRAND_NAME} runs Claude Code on your computer, signed in with your own Claude account. Choose it in Settings › Model and key.`,
      },
      {
        title: 'No step limit',
        body: 'A long task pauses for Continue after 60 steps. Turn on No step limit in Settings › Model and key to let it keep going until it’s done or you press Stop.',
      },
      {
        title: 'Check what matters',
        body: 'Companions can get things wrong. The welcome and Settings now remind you to check important facts before you rely on them.',
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-11-17',
    title: BRANDING.official ? 'Apex is now Atelier' : `${BRAND_NAME} 1.5`,
    highlights: [
      // The new name is the official branding's (TRADEMARKS.md); other builds were never called Apex.
      ...(BRANDING.official
        ? [
            {
              title: 'Apex is now Atelier',
              body: 'The same browser, the same companion and everything you made, under a new name. An atelier is where you make things your own, and that is what Atelier is for.',
            },
          ]
        : []),
      {
        title: 'Packs have a new file type',
        body: 'Packs, apps, worlds and companions you share are now .atelierpack, .atelierapp, .atelierworld and .ateliercompanion files.',
      },
      {
        title: 'Settings save while a page loads',
        body: 'Changing a setting while a tab was loading a page could fail. It now always saves, and changing other settings no longer refreshes every page’s permissions.',
      },
      {
        title: 'Up to date',
        body: `${BRAND_NAME} now runs on Electron 45.3.2, with the newest Anthropic SDK and fixes in the libraries it uses.`,
      },
    ],
  },
  {
    version: '1.4.5',
    date: '2026-11-17',
    title: `${BRAND_NAME} is open source`,
    highlights: [
      {
        title: `${BRAND_NAME} is open source`,
        body: 'The whole browser and its companion are now free and open source. Read the code, build it yourself or help make it better: Settings › About shows where to find it.',
      },
      {
        title: 'Boosts are now Tweaks',
        body: 'Site tweaks are what boosts used to be, and Hide element is the new name for the zapper. Everything you made keeps working.',
      },
      {
        title: 'Reviews show everything a companion says',
        body: 'Importing a companion or installing a pack now shows everything it tells the assistant: each skill’s instructions and steps, and each routine’s prompt.',
      },
      {
        title: 'Phone controllers keep up',
        body: 'A button you let go of on a phone controller always reaches the game, even after a long session.',
      },
      {
        title: 'The side panel has room for its title',
        body: 'On Windows and Linux, the side panel no longer squeezes its title to make room for window buttons that aren’t there.',
      },
      {
        title: 'Runs on your API key',
        body: `${BRAND_NAME}’s companion runs on Claude through your own Anthropic API key. If you used Claude Code before, add a key in Settings › Model and key.`,
      },
      {
        title: 'Security updates',
        body: `The libraries ${BRAND_NAME} uses for its local servers and connections now include the latest security fixes.`,
      },
    ],
  },
  {
    version: '1.4.4',
    date: '2026-11-12',
    title: 'Tab drags stay on your screen',
    highlights: [
      {
        title: 'No more black screen when you drag a tab',
        body: 'Dragging a tab could slide your Mac to an empty black desktop with only the tab on it. The tab now stays with you, on the screen you are working on.',
      },
    ],
  },
  {
    version: '1.4.3',
    date: '2026-11-12',
    title: 'Drop a tab beside the page',
    highlights: [
      {
        title: 'Drop a tab to split the view',
        body: 'Drag a tab from the sidebar, or from the floating sidebar, onto the left or right of the page, and it opens there side by side.',
      },
      {
        title: 'Fewer surprise windows',
        body: 'A tab let go just past the window’s edge now stays where it was, and a drag you cancel with Escape no longer splits the page.',
      },
    ],
  },
  {
    version: '1.4.2',
    date: '2026-11-12',
    title: 'Your tabs in the floating sidebar',
    highlights: [
      {
        title: 'The floating sidebar lists your tabs',
        body: 'With the sidebar hidden, the one that slides in at the window’s left edge now shows all your tabs, and keeps up as you open and close them.',
      },
    ],
  },
  {
    version: '1.4.1',
    date: '2026-11-11',
    title: 'Quicker calls, and a sidebar that shows when you reach for it',
    highlights: [
      {
        title: 'Quick decisions, with a model of your own',
        body: `${BRAND_NAME} makes small calls all day, like whether a reply is waiting on you or whether to search or ask. In Settings › Quick decisions you can let small decision models make them, from the providers you pick, in your order. It stays off until you turn it on.`,
      },
      {
        title: 'Group tabs',
        body: 'Group your tabs by site, or by topic with a decision model, from the tab menu or the command bar. Undo puts them back.',
      },
      {
        title: 'The hidden sidebar shows again',
        body: 'With the sidebar hidden, moving to the window’s left edge shows it and keeps it there, instead of flickering away.',
      },
      {
        title: 'Sites that ignored every click',
        body: `With Hide cookie banners on, sites using TrustArc’s newer cookie popup, like digitalocean.com, took no clicks. ${BRAND_NAME} now declines that popup and the page works.`,
      },
      {
        title: 'PDFs on Linux',
        body: `Reading a PDF no longer crashes ${BRAND_NAME}.`,
        platforms: ['linux'],
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-11-09',
    title: 'Apps that run a little server of their own',
    highlights: [
      {
        title: 'A web server for your apps',
        body: 'An app can start its own small web server on this computer, or on your Wi-Fi when you allowed that at install, to serve pages to your phone or another computer and talk with them live.',
      },
      {
        title: 'Phones as controllers',
        body: 'Build from the new Phone controller starter: scan the code with your phone, and its tilt and buttons reach your app as you move.',
      },
      {
        title: 'Always in view, one tap to stop',
        body: `While an app shares something, ${BRAND_NAME} shows a bar over its tab with how many are connected and a Stop button.`,
      },
    ],
  },
  {
    version: '1.3.4',
    date: '2026-11-06',
    title: 'Steadier, on Mac and Windows',
    highlights: [
      {
        title: 'Dragging a tab shows it again',
        body: 'When you drag a tab, a chip with its name follows your pointer again.',
      },
      {
        title: 'Send is never held up',
        body: 'An attachment could stay on “Preparing…” after it was ready and keep Send waiting. It now shows ready as soon as it is.',
      },
      {
        title: 'Web apps open where they belong',
        body: 'A web app opens back in the tab it was saved from, never in a private window.',
      },
      {
        title: 'Closing the last window',
        body: `Closing ${BRAND_NAME}’s last window quits ${BRAND_NAME}, or keeps it in the tray when it runs in the background, and your tabs are back the next time.`,
        platforms: ['win32', 'linux'],
      },
      {
        title: 'Recordings that survive a crash, on Windows too',
        body: `If ${BRAND_NAME} crashes, Windows shuts down or you sign out mid-meeting, the recording is saved, or put back together the next time ${BRAND_NAME} starts.`,
        platforms: ['win32'],
      },
    ],
  },
  {
    version: '1.3.3',
    date: '2026-11-06',
    title: 'Packs and Workspace, made simple',
    highlights: [
      {
        title: 'Packs you can tell apart',
        body: 'Each pack is a card that says what it is: an app, a game, a world, skills, a look, a companion or tools. Filter by type, open it, or turn it on and off right from the card.',
      },
      {
        title: 'One pack, one panel',
        body: 'Click a pack to see what’s inside and what it can do. The technical details stay folded away under About this pack.',
      },
      {
        title: 'Workspace in four tabs',
        body: 'Home, Projects, Files and Apps, with Search everything at the top and Recently deleted beside the tabs. Your tables now live in Files.',
      },
      {
        title: 'The timeline is in History',
        body: 'Your browsing by day moved to History: switch between List and Timeline at the top.',
      },
    ],
  },
  {
    version: '1.3.2',
    date: '2026-11-06',
    title: 'Record meetings your way',
    highlights: [
      {
        title: 'Record audio only',
        body: 'Settings › Transcription › Meetings: transcribe and take notes, or just record the audio of a meeting, online or in person. You can transcribe a recording later.',
      },
      {
        title: `A recording, even when ${BRAND_NAME} can’t transcribe`,
        body: `With Speech Recognition off, or a language this Mac can’t transcribe, a meeting is recorded as audio instead, and ${BRAND_NAME} says why.`,
        windows: `With online speech recognition off, or a language this PC can’t transcribe, a meeting is recorded as audio instead, and ${BRAND_NAME} says why.`,
      },
      {
        title: 'Recordings that survive a crash',
        body: `Quitting mid-meeting saves the recording first. If ${BRAND_NAME} crashes or your Mac loses power, the recording is put back together the next time ${BRAND_NAME} starts.`,
        windows: `Quitting mid-meeting, or Windows shutting down, saves the recording first. If ${BRAND_NAME} crashes or your PC loses power, the recording is put back together the next time ${BRAND_NAME} starts.`,
      },
      {
        title: 'One language, unless you pick two',
        body: 'Meetings listen in one language. For meetings where people switch languages, choose a second one in Settings › Transcription.',
      },
      {
        title: 'Worlds opens again',
        body: 'A mistake since 1.2.5 kept Worlds from opening. It opens again, and holding Shift runs.',
      },
      {
        title: 'Cards in your language',
        body: `Meeting cards, the recording widget and the wrap-up now follow ${BRAND_NAME}’s language.`,
      },
    ],
  },
  {
    version: '1.3.1',
    date: '2026-11-05',
    title: 'Meetings in two languages, and your apps your way',
    highlights: [
      {
        title: 'Meetings in two languages',
        body: 'Meetings listen in your second language at the same time, so when someone switches between English and Dutch, each part is written in the language that was spoken. Settings › Transcription picks it from your Mac’s languages.',
        // Windows' speech helper hears one language (native/speech-win).
        platforms: ['darwin'],
      },
      {
        title: 'Every app in one place',
        body: 'Workspace › Apps lists your saved websites, apps from packs and apps your companions made. Right-click one to keep it in your sidebar as a row or as just its icon.',
      },
      {
        title: 'Packs are easy to find',
        body: 'Packs is in the sidebar’s More menu, the main menu and the Extensions menu, and Apps has Manage packs.',
      },
      {
        title: `Apps that look like ${BRAND_NAME}`,
        body: `Apps your companions build now use ${BRAND_NAME}’s own look in light and dark, and your companion checks each one before saying it’s ready.`,
      },
      {
        title: 'Smaller fixes',
        body: 'You can select and copy text in chats, Connectors starts in More, and transcribing a recording no longer loses text when the language changes.',
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-11-05',
    title: 'A workspace that fits you',
    highlights: [
      {
        title: 'Setup gets to know you',
        body: 'Your companion now chats with you during setup about what you do, what you want help with and what you do every week, then shows the workspace it would set up before changing anything.',
      },
      {
        title: 'Only what you need',
        body: 'Your sidebar shows the rows you’ll use, recurring things become routines, and only the apps you use are offered to connect.',
      },
      {
        title: 'About you, in Settings › You',
        body: 'See and change what your companions know about you, match your sidebar to it, or talk it through again.',
      },
      {
        title: 'Websites as apps',
        body: 'Right-click a tab and choose Save as App. Your web apps are listed in Workspace › Apps with the sites you use most, and opening one goes back to its own tab.',
      },
      {
        title: 'One place to change a look',
        body: 'Customize look, from Settings or a new companion, now opens the companion’s card with the bubbles around it.',
      },
      {
        title: 'A tidier bookmarks bar',
        body: 'Long titles shrink to make room before anything moves behind », short ones stay whole, and Open all shows how many it opens.',
      },
    ],
  },
  {
    version: '1.2.5',
    date: '2026-11-05',
    title: 'Companions on the move',
    highlights: [
      {
        title: 'Your companions walk',
        body: 'On the new tab page they step along when they stroll, and in Worlds you walk around as your companion. Hold Shift to run.',
      },
      {
        title: 'Full screen stays full screen',
        body: 'Clicking another app no longer pulls a playing video out of full screen. It stays until you leave it.',
      },
      {
        title: 'The sidebar slides out at the edge',
        body: 'With the sidebar hidden, move the pointer to the left edge of the window and it slides out, even when the window doesn’t touch the screen’s edge.',
      },
    ],
  },
  {
    version: '1.2.4',
    date: '2026-11-05',
    title: 'Your downloads, one click away',
    highlights: [
      {
        title: 'The downloads list opens again',
        body: 'Click the downloads button and your files show right under it: open one, show it in Finder, or see them all.',
        windows: 'Click the downloads button and your files show right under it: open one, show it in File Explorer, or see them all.',
      },
    ],
  },
  {
    version: '1.2.3',
    date: '2026-11-05',
    title: 'Popups show up again',
    highlights: [
      {
        title: 'Downloads and update notes appear right away',
        body: 'The downloads list and this card show where they should, without opening the profile menu first.',
      },
    ],
  },
  {
    version: '1.2.2',
    date: '2026-11-05',
    title: 'Clear in one go',
    highlights: [
      {
        title: 'Clear your tabs and chats',
        body: 'Hover over Your tabs or Chats in the sidebar and press Clear to close them all at once. Pinned ones stay, and Undo brings the rest back.',
      },
      {
        title: 'Update notes that wait for you',
        body: 'This card now shows in full, stays until you close it, and no longer gets in the way of menus or your downloads.',
      },
    ],
  },
  {
    version: '1.2.1',
    date: '2026-11-05',
    title: 'Skills of their own',
    highlights: [
      {
        title: 'A companion keeps its own skills',
        body: 'Ask a companion to learn how you like something done, and it gives itself a skill only it has. It can improve that skill later, and you save each change.',
      },
      {
        title: 'Skills go along when you share',
        body: 'Sharing or duplicating a companion now takes its skills with it, with their steps and files.',
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-11-05',
    title: 'Apps, games and worlds',
    highlights: [
      {
        title: `Apps and games in ${BRAND_NAME}`,
        body: 'Packs can now hold full apps and games that open in a tab. Find them on Packs › Browse, or open an .atelierapp someone sent you. Your companions can play their characters.',
      },
      {
        title: 'Build one with your companion',
        body: 'Ask for an app or a game in any chat. Your companion builds and tests it with you, and Share… saves it as a file you can send.',
      },
      {
        title: 'Worlds',
        body: 'Walk around a place as your companion, talk to the people who live there, and step into places that open apps. Build your own and share it as an .atelierworld.',
      },
    ],
  },
  {
    version: '1.1.2',
    date: '2026-11-02',
    title: 'Tab links in chat, and steadier tab drags',
    highlights: [
      {
        title: 'Go to a tab from the chat',
        body: 'When your companion mentions one of your tabs, click it to go there, even in another window. A link to a page you already have open goes to that tab.',
      },
      {
        title: 'Drag tabs where you mean',
        body: 'Split view opens where the zones show it will, and the pin target no longer pushes your tabs down when you start dragging.',
      },
    ],
  },
  {
    version: '1.1.1',
    date: '2026-11-02',
    title: 'Routines from a chat save again',
    highlights: [
      {
        title: 'Save a routine your companion suggests',
        body: 'When your companion proposes a routine in a chat, Save adds it and switches it on, instead of showing an error.',
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-11-02',
    title: 'Packs: add what you need, and share it',
    highlights: [
      {
        title: 'Install packs',
        body: 'Packs add skills, tools, panels, site tweaks, accents and companions in one go. Browse the community index on the Packs page, or open a pack someone sent you.',
      },
      {
        title: 'Your companion builds them with you',
        body: 'Describe what you want on Packs › New pack. Your companion writes and tests it, and you see what it can do before anything is installed.',
      },
      {
        title: 'Share what you made',
        body: 'Share a skill, site tweak, app or companion as a pack, signed with your own key. Updates that ask for more always wait for you.',
      },
      {
        title: 'The agent keeps to its own tab',
        body: 'While your companion works in a page, you can keep using another tab. It works out of sight and never takes yours.',
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-31',
    title: `${BRAND_NAME} 1.0`,
    highlights: [
      // Pip and its icon are the official branding's (TRADEMARKS.md); other builds leave this one out.
      ...(BRANDING.official
        ? [
            {
              title: 'Pip is the new face of Atelier',
              body: 'The app icon, menu bar and welcome now show Pip, and the welcome flow keeps the companion clear of every word.',
            },
          ]
        : []),
      {
        title: 'Search, translate and read',
        body: 'Search the web from the address bar or a new tab, translate pages on your Mac, and open articles in a calm reader with read aloud.',
      },
      {
        title: 'Sign in like any browser',
        body: 'Sign-in pages for Google, Microsoft, Apple and others just work, and you can bring your sign-ins over from your old browser.',
      },
      {
        title: 'Meetings in any app',
        body: `${BRAND_NAME} offers to take notes when a call starts in Zoom, Teams, FaceTime, Slack or a browser tab, with on-device transcription.`,
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-29',
    title: `${BRAND_NAME}, with your companion beside every tab`,
    highlights: [
      {
        title: 'A companion that works in your tabs',
        body: 'Ask in the side panel and your companion reads, clicks and types in the pages you already have open, asking first before anything that matters.',
      },
      {
        title: 'Chats that keep going',
        body: 'Start a chat, switch to something else, and come back when it needs you. Routines run on their own schedule.',
      },
      {
        title: 'Your keys, your computer',
        body: `${BRAND_NAME} uses your own Anthropic key. Chats, memory and settings stay on this computer.`,
      },
      {
        title: 'Updates that wait for you',
        body: `${BRAND_NAME} downloads updates in the background and restarts only when you say so. Windows and tabs come back afterwards.`,
      },
    ],
  },
]
