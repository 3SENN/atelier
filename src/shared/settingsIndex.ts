/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings search index: every settings row, so the command
// bar and the settings search find it. atelier://settings/<page>?highlight=<anchor>
// scrolls to the row and highlights it for about 2 s. Each area keeps its
// rows together in its own region.
import type { SETTINGS_PAGES } from './url'

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id'] | (string & {})

export interface SettingsIndexEntry {
  id: string
  page: SettingsPageId
  /** A message key (shown through t()). */
  title: string
  keywords: string[]
  /** The row's data-settings-anchor; '' for a whole page. */
  anchor: string
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  { id: 'page-general', page: 'general', title: 'settings.general.title', keywords: ['general', 'startup', 'quit', 'tabs'], anchor: '' },
  { id: 'page-appearance', page: 'appearance', title: 'settings.appearance.title', keywords: ['appearance', 'look', 'theme', 'colours', 'colors', 'layout'], anchor: '' },
  { id: 'page-languages', page: 'languages', title: 'settings.languages.title', keywords: ['languages', 'language', 'locale', 'spellcheck', 'accept-language'], anchor: '' },
  { id: 'page-default-browser', page: 'default-browser', title: 'settings.defaultBrowser.title', keywords: ['default browser', 'default', 'open links'], anchor: '' },
  { id: 'page-notifications', page: 'notifications', title: 'settings.notifications.title', keywords: ['notifications', 'alerts', 'banners', 'badge'], anchor: '' },
  { id: 'page-privacy', page: 'privacy', title: 'settings.privacy.title', keywords: ['privacy', 'security', 'tracking', 'cookies'], anchor: '' },
  { id: 'page-import', page: 'import', title: 'settings.import.title', keywords: ['import', 'bring over', 'migrate', 'chrome', 'firefox', 'safari', 'arc'], anchor: '' },
  { id: 'page-storage', page: 'storage', title: 'settings.storagePage.title', keywords: ['storage', 'disk', 'space', 'size', 'free up'], anchor: '' },
  { id: 'page-about', page: 'about', title: 'settings.about.title', keywords: ['about', 'version', 'licences', 'licenses', 'acknowledgements'], anchor: '' },
  { id: 'page-dock-icon', page: 'dock-icon', title: 'settings.dock.title', keywords: ['dock', 'icon', 'app icon'], anchor: '' },
  // docs/decisions.md
  { id: 'page-decisions', page: 'decisions', title: 'decisions.title', keywords: ['quick decisions', 'decision model', 'decisions', 'jev', 'kev', 'clef', 'luna', 'system one', 'typesafe', 'openrouter', 'experiential labs', 'faster', 'rules'], anchor: '' },
  { id: 'decisions-on', page: 'decisions', title: 'decisions.on', keywords: ['turn on decision model', 'turn off decision model', 'quick decisions on'], anchor: 'decisions-on' },
  { id: 'decisions-providers', page: 'decisions', title: 'decisions.section.providers', keywords: ['decision model provider', 'decision key', 'jev key', 'openrouter key', 'experiential labs key', 'own server', 'local model', 'kev'], anchor: 'decisions-providers' },
  { id: 'decisions-models', page: 'decisions', title: 'decisions.section.models', keywords: ['decision models', 'backup model', 'fallback', 'model order', 'free decision model', 'model version'], anchor: 'decisions-models' },
  { id: 'decisions-mode', page: 'decisions', title: 'decisions.mode', keywords: ['compare first', 'use it', 'compare decisions'], anchor: 'decisions-mode' },
  { id: 'decisions-uses', page: 'decisions', title: 'decisions.section.uses', keywords: ['group tabs by topic', 'effort per message', 'search or ask', 'labeling', 'label items', 'worth remembering', 'skills that fit', 'needs you', 'dictation', 'voice'], anchor: 'decisions-uses' },
  { id: 'decisions-summary', page: 'model', title: 'decisions.title', keywords: ['quick decisions', 'decision model'], anchor: 'decisions-summary' },
  { id: 'step-limit', page: 'model', title: 'settings.model.unlimitedSteps', keywords: ['step limit', 'max steps', 'steps', 'no cap', 'unlimited', 'long tasks', 'continue', 'paused'], anchor: 'step-limit' },
  { id: 'warn-before-quit', page: 'general', title: 'settings.general.warnBeforeQuit', keywords: ['quit', 'warn', 'command q', 'close app'], anchor: 'warn-before-quit' },
  { id: 'confirm-close-tabs', page: 'general', title: 'settings.general.confirmCloseTabs', keywords: ['close tabs', 'confirm', 'window'], anchor: 'confirm-close-tabs' },
  { id: 'keep-awake', page: 'general', title: 'settings.general.keepAwake', keywords: ['sleep', 'awake', 'caffeinate', 'routines'], anchor: 'keep-awake' },
  { id: 'tab-sleep', page: 'general', title: 'settings.general.tabSleep', keywords: ['tab sleep', 'discard tabs', 'inactive tabs'], anchor: 'tab-sleep' },
  { id: 'memory-saver', page: 'general', title: 'settings.general.memorySaver', keywords: ['memory saver', 'ram', 'performance', 'light', 'slow'], anchor: 'memory-saver' },
  { id: 'energy-saver', page: 'general', title: 'settings.general.energySaver', keywords: ['energy saver', 'battery', 'power', 'performance'], anchor: 'energy-saver' },
  { id: 'theme', page: 'appearance', title: 'settings.appearance.mode', keywords: ['theme', 'dark mode', 'light mode', 'system'], anchor: 'theme' },
  { id: 'profile-hue', page: 'appearance', title: 'settings.appearance.hue', keywords: ['hue', 'profile colour', 'profile color', 'colour'], anchor: 'profile-hue' },
  { id: 'sidebar-tint', page: 'appearance', title: 'settings.appearance.tint', keywords: ['tint', 'sidebar colour', 'transparency'], anchor: 'sidebar-tint' },
  { id: 'companion-floor', page: 'appearance', title: 'settings.appearance.companionFloor', keywords: ['companions on new tab', 'floor', 'lounge', 'new tab', 'companions'], anchor: 'companion-floor' },
  { id: 'accent', page: 'appearance', title: 'settings.appearance.accent', keywords: ['accent', 'companion colour', 'highlight'], anchor: 'accent' },
  { id: 'layout', page: 'appearance', title: 'settings.appearance.layout', keywords: ['layout', 'sidebar', 'top tabs', 'vertical tabs', 'horizontal tabs'], anchor: 'layout' },
  { id: 'font-size', page: 'appearance', title: 'settings.appearance.fontSize', keywords: ['font size', 'text size', 'type size'], anchor: 'font-size' },
  { id: 'density', page: 'appearance', title: 'settings.appearance.density', keywords: ['density', 'compact', 'comfortable', 'spacing'], anchor: 'density' },
  { id: 'interface-zoom', page: 'appearance', title: 'settings.appearance.uiZoom', keywords: ['zoom', 'interface zoom', 'scale', 'bigger', 'smaller'], anchor: 'interface-zoom' },
  { id: 'chat-zoom', page: 'appearance', title: 'settings.appearance.chatZoom', keywords: ['chat zoom', 'chat text size', 'reading size'], anchor: 'chat-zoom' },
  { id: 'bookmarks-bar', page: 'appearance', title: 'settings.appearance.bookmarksBar', keywords: ['bookmarks bar', 'favourites bar', 'favorites bar'], anchor: 'bookmarks-bar' },
  { id: 'full-urls', page: 'appearance', title: 'settings.appearance.fullUrls', keywords: ['full address', 'full url', 'show url'], anchor: 'full-urls' },
  { id: 'picture-in-picture', page: 'appearance', title: 'settings.appearance.pip', keywords: ['picture in picture', 'pip', 'video'], anchor: 'picture-in-picture' },
  { id: 'media-card', page: 'appearance', title: 'settings.appearance.mediaCard', keywords: ['media', 'now playing', 'music', 'controls'], anchor: 'media-card' },
  { id: 'now-playing', page: 'appearance', title: 'media.settings.button', keywords: ['media', 'now playing', 'music', 'video', 'speed', 'toolbar'], anchor: 'now-playing' },
  { id: 'reduce-motion', page: 'appearance', title: 'settings.appearance.reduceMotion', keywords: ['motion', 'animation', 'reduce motion', 'accessibility'], anchor: 'reduce-motion' },
  { id: 'languages-mode', page: 'languages', title: 'settings.languages.mode', keywords: ['languages', 'system languages', 'preferred languages', 'order'], anchor: 'languages-mode' },
  { id: 'languages-add', page: 'languages', title: 'settings.languages.add', keywords: ['add language', 'locale', 'spellcheck'], anchor: 'languages-add' },
  { id: 'default-browser', page: 'default-browser', title: 'settings.defaultBrowser.make', keywords: ['default browser', 'make default', 'open links in atelier'], anchor: 'default-browser' },
  { id: 'notifications', page: 'notifications', title: 'settings.notifications.enabled', keywords: ['notifications', 'alerts', 'turn off notifications'], anchor: 'notifications' },
  { id: 'notification-sounds', page: 'notifications', title: 'settings.notifications.sounds', keywords: ['sounds', 'notification sound', 'silent'], anchor: 'notification-sounds' },
  { id: 'notify-needs-you', page: 'notifications', title: 'settings.notifications.category.needsYou', keywords: ['approvals', 'needs you', 'permission requests'], anchor: 'notify-needs-you' },
  { id: 'notify-routine-results', page: 'notifications', title: 'settings.notifications.category.routineResults', keywords: ['routines', 'routine results', 'scheduled'], anchor: 'notify-routine-results' },
  { id: 'notify-chat-updates', page: 'notifications', title: 'settings.notifications.category.chatUpdates', keywords: ['chat finished', 'replies', 'chat updates'], anchor: 'notify-chat-updates' },
  { id: 'notify-meetings', page: 'notifications', title: 'settings.notifications.category.meetings', keywords: ['meetings', 'calendar', 'meeting starts'], anchor: 'notify-meetings' },
  { id: 'notify-downloads', page: 'notifications', title: 'settings.notifications.category.downloads', keywords: ['downloads', 'download finished'], anchor: 'notify-downloads' },
  { id: 'notify-passwords', page: 'notifications', title: 'settings.notifications.category.passwords', keywords: ['passwords', 'saved password', 'leaked'], anchor: 'notify-passwords' },
  { id: 'notify-packs', page: 'notifications', title: 'settings.notifications.category.packs', keywords: ['packs', 'pack notifications', 'add-ons'], anchor: 'notify-packs' },
  { id: 'adblock', page: 'privacy', title: 'settings.privacy.adblock', keywords: ['ad blocker', 'ads', 'trackers', 'block ads'], anchor: 'adblock' },
  // privacy pack
  { id: 'https-first', page: 'privacy', title: 'privacyPack.index.https', keywords: ['https', 'https-first', 'secure connection', 'http', 'not secure', 'encryption'], anchor: 'https-first' },
  { id: 'cookie-banners', page: 'privacy', title: 'privacyPack.index.cookies', keywords: ['cookie banners', 'cookie consent', 'gdpr', 'consent pop-ups', 'reject cookies', 'annoyances'], anchor: 'cookie-banners' },
  { id: 'site-settings', page: 'privacy', title: 'settings.privacy.sites', keywords: ['site settings', 'permissions', 'camera', 'microphone', 'location', 'pop-ups'], anchor: 'site-settings' },
  // permissions hub: the row that opens atelier://settings/access
  { id: 'permissions-hub', page: 'privacy', title: 'permissionsHub.row.title', keywords: ['permissions', 'privacy and security', 'microphone', 'camera', 'location', 'screen recording', 'speech recognition', 'calendars', 'reminders', 'full disk access', 'notifications', 'system settings', 'block', 'quiet notifications'], anchor: 'permissions-hub' },
  { id: 'history', page: 'privacy', title: 'settings.privacy.history.row', keywords: ['history', 'clear history', 'browsing history'], anchor: 'history' },
  { id: 'clear-cache', page: 'privacy', title: 'settings.privacy.cache', keywords: ['cache', 'clear cache', 'cached images'], anchor: 'clear-cache' },
  { id: 'clear-cookies', page: 'privacy', title: 'settings.privacy.cookies', keywords: ['cookies', 'site data', 'sign out', 'local storage'], anchor: 'clear-cookies' },
  { id: 'clear-browsing-data', page: 'privacy', title: 'settings.privacy.clearAll', keywords: ['clear browsing data', 'delete history', 'time range'], anchor: 'clear-browsing-data' },
  { id: 'import-browser', page: 'import', title: 'settings.import.browsers.label', keywords: ['import', 'bookmarks', 'history', 'tabs', 'search engines', 'chrome', 'firefox', 'safari'], anchor: 'import-browser' },
  { id: 'storage-usage', page: 'storage', title: 'settings.storagePage.used', keywords: ['storage', 'space used', 'disk usage'], anchor: 'storage-usage' },
  { id: 'storage-cache', page: 'storage', title: 'settings.storagePage.cache', keywords: ['clear cache', 'free space'], anchor: 'storage-cache' },
  { id: 'storage-images', page: 'storage', title: 'settings.storagePage.images', keywords: ['chat images', 'screenshots', 'old images', 'free space'], anchor: 'storage-images' },
  { id: 'reset', page: 'storage', title: 'settings.storagePage.reset.row', keywords: ['reset', 'factory reset', 'start over', 'delete everything', 'erase'], anchor: 'reset' },
  { id: 'dock-icon', page: 'dock-icon', title: 'settings.dock.choice', keywords: ['dock icon', 'app icon', 'companion icon'], anchor: 'dock-icon' },
  { id: 'downloads-folder', page: 'downloads', title: 'downloads.settings.folder', keywords: ['downloads', 'download folder', 'location', 'save to', 'path'], anchor: 'downloads-folder' },
  { id: 'downloads-ask', page: 'downloads', title: 'downloads.settings.ask', keywords: ['ask where to save', 'save dialog', 'save as', 'downloads'], anchor: 'downloads-ask' },
  { id: 'downloads-list', page: 'downloads', title: 'downloads.settings.list', keywords: ['downloads', 'download history', 'files'], anchor: 'downloads-list' },
  // Transcription, passwords and voice
  { id: 'transcription-setup', page: 'transcription', title: 'speech.index.setup', keywords: ['meeting setup', 'permissions', 'microphone access', 'speech recognition', 'screen recording', 'privacy'], anchor: 'transcription-setup' },
  { id: 'transcription-mode', page: 'transcription', title: 'speech.index.mode', keywords: ['record audio only', 'audio only', 'recorder', 'transcribe meetings', 'take notes', 'no transcript', 'meeting mode'], anchor: 'transcription-mode' },
  { id: 'transcription-mic', page: 'transcription', title: 'speech.index.mic', keywords: ['microphone', 'mic', 'input device', 'headset', 'audio input', 'transcription'], anchor: 'transcription-mic' },
  { id: 'transcription-language', page: 'transcription', title: 'speech.index.language', keywords: ['language', 'locale', 'recognition language', 'second language', 'on-device', 'transcription', 'speech model', 'prepare speech', 'download language'], anchor: 'transcription-language' },
  { id: 'transcription-vocabulary', page: 'transcription', title: 'speech.index.vocabulary', keywords: ['vocabulary', 'names', 'jargon', 'custom words', 'context hints'], anchor: 'transcription-vocabulary' },
  { id: 'transcription-summary', page: 'transcription', title: 'speech.index.summary', keywords: ['summary', 'summarize', 'meeting notes', 'action items', 'after meeting'], anchor: 'transcription-summary' },
  { id: 'transcription-alerts', page: 'transcription', title: 'speech.index.alerts', keywords: ['meeting alerts', 'calendar', 'reminder', 'zoom', 'google meet', 'teams', 'desktop apps', 'facetime', 'webex', 'slack huddle', 'discord', 'take notes'], anchor: 'transcription-alerts' },
  { id: 'transcription-record', page: 'transcription', title: 'speech.index.record', keywords: ['audio recordings', 'keep audio', 'record meetings', 'playback'], anchor: 'transcription-record' },
  { id: 'transcription-levels', page: 'transcription', title: 'speech.index.levels', keywords: ['sensitivity', 'levels', 'gain', 'test microphone', 'mic check', 'volume'], anchor: 'transcription-levels' },
  { id: 'passwords-apple', page: 'passwords', title: 'passwords.apple.index.switch', keywords: ['apple passwords', 'icloud passwords', 'icloud keychain', 'keychain', 'passwords app', 'mac'], anchor: 'passwords-apple' },
  { id: 'passwords-apple-yield', page: 'passwords', title: 'passwords.apple.index.yield', keywords: ['password extension', 'password manager extension', 'step aside', '1password', 'bitwarden', 'icloud passwords'], anchor: 'passwords-apple-yield' },
  { id: 'passwords-manager', page: 'passwords', title: 'passwords.index.manager', keywords: ['passwords', 'password manager', 'logins', 'sign-ins', 'keychain', 'saved passwords'], anchor: 'passwords-manager' },
  { id: 'passwords-import', page: 'passwords', title: 'passwords.index.import', keywords: ['import passwords', 'csv', 'chrome', 'firefox', 'safari', '1password', 'bitwarden', 'passwords app'], anchor: 'passwords-import' },
  { id: 'passwords-offer-logins', page: 'passwords', title: 'passwords.index.offerLogins', keywords: ['autofill', 'fill passwords', 'sign in'], anchor: 'passwords-offer-logins' },
  { id: 'passwords-offer-save', page: 'passwords', title: 'passwords.index.offerSave', keywords: ['save passwords', 'ask to save'], anchor: 'passwords-offer-save' },
  { id: 'passwords-offer-generated', page: 'passwords', title: 'passwords.index.generated', keywords: ['generate password', 'strong password', 'suggest'], anchor: 'passwords-offer-generated' },
  { id: 'passwords-never', page: 'passwords', title: 'passwords.index.never', keywords: ['never save', 'blocked sites', 'allow again'], anchor: 'passwords-never' },
  { id: 'passwords-addresses', page: 'passwords', title: 'passwords.index.addresses', keywords: ['address', 'autofill', 'shipping', 'phone', 'email'], anchor: 'passwords-addresses' },
  { id: 'passwords-cards', page: 'passwords', title: 'passwords.index.cards', keywords: ['credit card', 'payment', 'card', 'autofill', 'checkout'], anchor: 'passwords-cards' },
  { id: 'voice-hold', page: 'voice', title: 'voice.settings.enable', keywords: ['voice', 'hold to talk', 'dictation', 'microphone', 'speak'], anchor: 'voice-hold' },
  { id: 'voice-keys', page: 'voice', title: 'voice.settings.chord', keywords: ['voice', 'shortcut', 'keys', 'option space', 'chord'], anchor: 'voice-keys' },
  { id: 'voice-target', page: 'voice', title: 'voice.settings.target', keywords: ['voice', 'dictate', 'field', 'companion'], anchor: 'voice-target' },
  { id: 'voice-rewrite', page: 'voice', title: 'voice.settings.rewrite', keywords: ['voice', 'rewrite', 'edit field'], anchor: 'voice-rewrite' },
  { id: 'voice-sounds', page: 'voice', title: 'voice.settings.sounds', keywords: ['voice', 'sounds', 'tones', 'audio feedback'], anchor: 'voice-sounds' },
  { id: 'voice-screenshot', page: 'voice', title: 'voice.settings.screenshot', keywords: ['voice', 'screenshot', 'capture'], anchor: 'voice-screenshot' },
  { id: 'voice-source', page: 'voice', title: 'voice.settings.source', keywords: ['voice', 'screenshot', 'screen recording', 'tab'], anchor: 'voice-source' },
  { id: 'voice-modifier', page: 'voice', title: 'voice.settings.modifier', keywords: ['voice', 'read aloud', 'speak replies', 'shift'], anchor: 'voice-modifier' },
  { id: 'voice-voice', page: 'voice', title: 'voice.settings.voice', keywords: ['voice', 'read aloud', 'speech', 'system voice'], anchor: 'voice-voice' },
  { id: 'voice-launcher', page: 'voice', title: 'voice.settings.launcher', keywords: ['voice', 'quick ask', 'launcher', 'global shortcut', 'any app'], anchor: 'voice-launcher' },
  { id: 'voice-test-mic', page: 'voice', title: 'voice.settings.testMic', keywords: ['voice', 'test microphone', 'mic check'], anchor: 'voice-test-mic' },
  // Memory tidying, activity memory, calendar and site suggestions
  { id: 'memory.tidy', page: 'memory', title: 'memory.tidy.switch', keywords: ['tidy', 'nightly', 'memory', 'clean up', 'notes', 'reorganize'], anchor: 'tidy-memory' },
  { id: 'activity.enabled', page: 'activity', title: 'memory.activity.switch', keywords: ['activity', 'browsing', 'capture', 'remember', 'pause', 'history'], anchor: 'activity-enabled' },
  { id: 'activity.hours', page: 'activity', title: 'memory.activity.hoursSwitch', keywords: ['hours', 'schedule', 'days', 'weekdays', 'time'], anchor: 'activity-hours' },
  { id: 'activity.excluded', page: 'activity', title: 'memory.activity.excluded', keywords: ['exclude', 'sites', 'health', 'banking', 'adult', 'dating', 'privacy'], anchor: 'activity-excluded' },
  { id: 'activity.retention', page: 'activity', title: 'memory.activity.retention', keywords: ['retention', 'keep', 'thumbnails', 'screenshots', 'days'], anchor: 'activity-retention' },
  { id: 'activity.insights', page: 'activity', title: 'memory.activity.insights', keywords: ['insights', 'suggestions', 'to-do', 'routines', 'proactive'], anchor: 'activity-proactive' },
  { id: 'activity.clear', page: 'activity', title: 'memory.activity.clear', keywords: ['clear', 'delete', 'erase', 'activity'], anchor: 'activity-clear' },
  { id: 'calendar.events', page: 'permissions', title: 'platform.calendar.events', keywords: ['calendar', 'events', 'meetings', 'schedule', 'this mac', 'eventkit'], anchor: 'calendar-events' },
  { id: 'calendar.reminders', page: 'permissions', title: 'platform.calendar.reminders', keywords: ['reminders', 'to-do', 'tasks', 'this mac'], anchor: 'calendar-reminders' },
  { id: 'site-suggestions', page: 'permissions', title: 'platform.suggestion.setting.title', keywords: ['suggestions', 'sites', 'open in app', 'connectors', 'ready-made tasks'], anchor: 'site-suggestions' },
  // ST-56
  { id: 'about.check-updates', page: 'about', title: 'updates.about.check', keywords: ['update', 'updates', 'version', 'upgrade', 'release', 'restart'], anchor: 'check-updates' },
  { id: 'about.auto-download', page: 'about', title: 'updates.about.autoDownload', keywords: ['update', 'download', 'automatic', 'background'], anchor: 'auto-download' },
  // BackgroundSettings on General
  { id: 'open-at-login', page: 'general', title: 'system.general.openAtLogin', keywords: ['login', 'log in', 'startup', 'start up', 'launch', 'autostart', 'boot', 'open at login'], anchor: 'open-at-login' },
  { id: 'run-in-background', page: 'general', title: 'system.general.background.index', keywords: ['background', 'tray', 'menu bar', 'notification area', 'system tray', 'keep running', 'close windows', 'dock'], anchor: 'run-in-background' },
  // LID_PAUSE_ANCHOR on Transcription, HAPTICS_ANCHOR on General; src/renderer/src/native
  { id: 'lid-pause', page: 'transcription', title: 'native.lid.row', keywords: ['lid', 'close the lid', 'clamshell', 'sleep', 'pause recording', 'meeting recording', 'transcription'], anchor: 'lid-pause' },
  { id: 'haptics', page: 'general', title: 'native.haptics.row', keywords: ['haptics', 'haptic feedback', 'trackpad', 'force touch', 'tap', 'split view'], anchor: 'haptics' },
  // ── reader settings rows ── (RD-05)
  { id: 'reader-button', page: 'appearance', title: 'reader.settings.button', keywords: ['reader', 'reader view', 'reading mode', 'immersive reader', 'article', 'book'], anchor: 'reader-button' },
  { id: 'reader-font', page: 'appearance', title: 'reader.font.label', keywords: ['reader', 'typeface', 'font', 'serif', 'sans'], anchor: 'reader-font' },
  { id: 'reader-size', page: 'appearance', title: 'reader.size.label', keywords: ['reader', 'text size', 'font size', 'bigger text'], anchor: 'reader-size' },
  { id: 'reader-width', page: 'appearance', title: 'reader.width.label', keywords: ['reader', 'line width', 'column', 'measure'], anchor: 'reader-width' },
  { id: 'reader-theme', page: 'appearance', title: 'reader.theme.label', keywords: ['reader', 'sepia', 'page colour', 'page color', 'dark'], anchor: 'reader-theme' },
  { id: 'reader-voice', page: 'appearance', title: 'reader.view.voice', keywords: ['read aloud', 'voice', 'speech', 'text to speech', 'listen'], anchor: 'reader-voice' },
  { id: 'reader-rate', page: 'appearance', title: 'reader.settings.rate', keywords: ['read aloud', 'speed', 'rate', 'listen'], anchor: 'reader-rate' },
  // ── translate settings rows ── (TR-12: Settings › Languages › Translation)
  { id: 'translate-offer', page: 'languages', title: 'translate.settings.offer', keywords: ['translate', 'translation', 'translate page', 'foreign language', 'offer to translate'], anchor: 'translate-offer' },
  { id: 'translate-target', page: 'languages', title: 'translate.settings.target', keywords: ['translate', 'translate into', 'target language'], anchor: 'translate-target' },
  { id: 'translate-companion', page: 'languages', title: 'translate.settings.companion', keywords: ['translate', 'companion', 'ai translation', 'model'], anchor: 'translate-companion' },
  { id: 'translate-on-device', page: 'languages', title: 'translate.settings.onDevice', keywords: ['translate', 'on device', 'offline', 'apple translation', 'download languages'], anchor: 'translate-on-device' },
  { id: 'translate-always', page: 'languages', title: 'translate.settings.always', keywords: ['translate', 'always translate', 'automatic translation'], anchor: 'translate-always' },
  { id: 'translate-never', page: 'languages', title: 'translate.settings.never', keywords: ['translate', 'never translate', 'language'], anchor: 'translate-never' },
  { id: 'translate-never-sites', page: 'languages', title: 'translate.settings.neverSites', keywords: ['translate', 'never translate', 'site', 'website'], anchor: 'translate-never-sites' },
]

/** The address that opens a row's page with the row highlighted. */
export function settingsRowUrl(entry: Pick<SettingsIndexEntry, 'page' | 'anchor'>): string {
  return entry.anchor ? `atelier://settings/${entry.page}?highlight=${encodeURIComponent(entry.anchor)}` : `atelier://settings/${entry.page}`
}
