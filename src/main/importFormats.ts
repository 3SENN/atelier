/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// File formats other browsers keep their data in (ST-46): Safari's
// XML property lists, Chromium's session files (SNSS), Firefox's
// LZ4-compressed JSON (mozlz4) and the search-engine tables. Pure parsers, so
// each is tested on fixtures; the reading and copying is in importBrowsers.ts.

// ---- XML property lists (plutil -convert xml1) ----

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10))
    return ENTITIES[e.toLowerCase()] ?? _
  })
}

/** Parses an XML plist document into plain values; throws on malformed input. */
export function parseXmlPlist(xml: string): PlistValue {
  const tokens = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) ?? []
  let i = 0
  const next = (): string => tokens[i++] ?? ''
  const skipSpace = (): void => {
    while (i < tokens.length && !(tokens[i] ?? '').startsWith('<')) i++
  }
  const text = (close: string): string => {
    let out = ''
    while (i < tokens.length && tokens[i] !== close) out += next()
    if (next() !== close) throw new Error('Malformed property list.')
    return decodeEntities(out)
  }
  const value = (depth: number): PlistValue => {
    if (depth > 128) throw new Error('Property list nested too deeply.')
    skipSpace()
    const tag = next()
    switch (tag) {
      case '<string>':
        return text('</string>')
      case '<string/>':
        return ''
      case '<integer>':
        return Number.parseInt(text('</integer>').trim(), 10)
      case '<real>':
        return Number.parseFloat(text('</real>').trim())
      case '<true/>':
        return true
      case '<false/>':
        return false
      case '<date>':
        return new Date(text('</date>').trim())
      case '<data>':
        return Uint8Array.from(Buffer.from(text('</data>').replace(/\s+/g, ''), 'base64'))
      case '<data/>':
        return new Uint8Array()
      case '<array/>':
        return []
      case '<dict/>':
        return {}
      case '<array>': {
        const out: PlistValue[] = []
        for (;;) {
          skipSpace()
          if (tokens[i] === '</array>') {
            i++
            return out
          }
          if (i >= tokens.length) throw new Error('Malformed property list.')
          out.push(value(depth + 1))
        }
      }
      case '<dict>': {
        const out: Record<string, PlistValue> = {}
        for (;;) {
          skipSpace()
          const t = next()
          if (t === '</dict>') return out
          if (t !== '<key>') throw new Error('Malformed property list.')
          const key = text('</key>')
          out[key] = value(depth + 1)
        }
      }
      default:
        throw new Error('Malformed property list.')
    }
  }
  skipSpace()
  if (!next().startsWith('<plist')) throw new Error('Not a property list.')
  return value(0)
}

/** Flattens Safari's Bookmarks.plist tree (folders and the reading list) into URL bookmarks. */
export function safariBookmarks(root: PlistValue): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = []
  const visit = (node: PlistValue, depth: number): void => {
    if (depth > 64 || !node || typeof node !== 'object' || Array.isArray(node) || node instanceof Date || node instanceof Uint8Array) return
    const n = node as Record<string, PlistValue>
    if (n.WebBookmarkType === 'WebBookmarkTypeLeaf' && typeof n.URLString === 'string') {
      const uri = n.URIDictionary
      const title = uri && typeof uri === 'object' && !Array.isArray(uri) && typeof (uri as Record<string, PlistValue>).title === 'string' ? ((uri as Record<string, PlistValue>).title as string) : n.URLString
      out.push({ url: n.URLString, title })
    }
    if (Array.isArray(n.Children)) for (const child of n.Children) visit(child, depth + 1)
  }
  visit(root, 0)
  return out
}

/** Safari keeps visit times as seconds since 2001-01-01. */
export function safariTimeToMs(seconds: number): number {
  return Math.round((seconds + 978_307_200) * 1000)
}

// ---- Firefox: mozlz4 (LZ4 block with a magic header) ----

const MOZLZ4_MAGIC = 'mozLz40\0'

/** Decompresses one raw LZ4 block. */
export function lz4Block(input: Uint8Array, outputSize: number): Uint8Array {
  if (outputSize > 256 * 1024 * 1024) throw new Error('This file is too large to import.')
  const out = new Uint8Array(outputSize)
  let ip = 0
  let op = 0
  while (ip < input.length) {
    const token = input[ip++] ?? 0
    let literal = token >> 4
    if (literal === 15) {
      let b: number
      do {
        b = input[ip++] ?? 0
        literal += b
      } while (b === 255 && ip < input.length)
    }
    if (op + literal > out.length || ip + literal > input.length) throw new Error('Corrupt compressed data.')
    out.set(input.subarray(ip, ip + literal), op)
    ip += literal
    op += literal
    if (ip >= input.length) break
    const offset = (input[ip] ?? 0) | ((input[ip + 1] ?? 0) << 8)
    ip += 2
    if (offset === 0 || offset > op) throw new Error('Corrupt compressed data.')
    let match = (token & 15) + 4
    if ((token & 15) === 15) {
      let b: number
      do {
        b = input[ip++] ?? 0
        match += b
      } while (b === 255 && ip < input.length)
    }
    if (op + match > out.length) throw new Error('Corrupt compressed data.')
    // Byte by byte: a match may overlap what it copies.
    for (let k = 0; k < match; k++, op++) out[op] = out[op - offset] ?? 0
  }
  return out.subarray(0, op)
}

/** Reads a Firefox .jsonlz4 / .mozlz4 file's JSON. */
export function readMozLz4(data: Uint8Array): unknown {
  const header = Buffer.from(data.subarray(0, 8)).toString('latin1')
  if (header !== MOZLZ4_MAGIC || data.length < 12) throw new Error('Not a Firefox compressed file.')
  const size = Buffer.from(data.subarray(8, 12)).readUInt32LE(0)
  return JSON.parse(Buffer.from(lz4Block(data.subarray(12), size)).toString('utf8')) as unknown
}

export interface ImportedTab {
  url: string
  title: string
  pinned: boolean
}

/** Open and pinned tabs from Firefox's sessionstore (recovery.jsonlz4): each tab's current entry. */
export function firefoxSessionTabs(session: unknown): ImportedTab[] {
  const out: ImportedTab[] = []
  const windows = (session as { windows?: unknown } | null)?.windows
  if (!Array.isArray(windows)) return out
  for (const win of windows) {
    const tabs = (win as { tabs?: unknown } | null)?.tabs
    if (!Array.isArray(tabs)) continue
    for (const tab of tabs) {
      const t = tab as { entries?: unknown; index?: unknown; pinned?: unknown } | null
      if (!t || !Array.isArray(t.entries) || t.entries.length === 0) continue
      const index = typeof t.index === 'number' ? Math.min(t.entries.length, Math.max(1, t.index)) - 1 : t.entries.length - 1
      const entry = t.entries[index] as { url?: unknown; title?: unknown } | undefined
      if (entry && typeof entry.url === 'string' && /^https?:/i.test(entry.url)) {
        out.push({ url: entry.url, title: typeof entry.title === 'string' ? entry.title : entry.url, pinned: t.pinned === true })
      }
    }
  }
  return out
}

// ---- Chromium: SNSS session files ----

// Command ids from Chromium's session_service_commands.cc.
const SNSS = {
  setTabWindow: 0,
  setTabIndexInWindow: 2,
  updateTabNavigation: 6,
  setSelectedNavigationIndex: 7,
  setPinnedState: 12,
  tabClosed: 16,
  windowClosed: 17,
} as const

/** Reads a Pickle string (int32 length, bytes, padded to 4). */
function pickleString(buf: Buffer, at: number): { value: string; next: number } | null {
  if (at + 4 > buf.length) return null
  const len = buf.readInt32LE(at)
  if (len < 0 || at + 4 + len > buf.length) return null
  const value = buf.toString('utf8', at + 4, at + 4 + len)
  return { value, next: at + 4 + Math.ceil(len / 4) * 4 }
}

/** Reads a Pickle string16 (int32 count of UTF-16 units, padded to 4). */
function pickleString16(buf: Buffer, at: number): { value: string; next: number } | null {
  if (at + 4 > buf.length) return null
  const count = buf.readInt32LE(at)
  const bytes = count * 2
  if (count < 0 || at + 4 + bytes > buf.length) return null
  const value = buf.toString('utf16le', at + 4, at + 4 + bytes)
  return { value, next: at + 4 + Math.ceil(bytes / 4) * 4 }
}

/**
 * Open tabs from a Chromium session file: the navigation each tab has
 * selected, and whether it is pinned. Closed tabs and windows are dropped.
 * Unknown commands are skipped, so newer files still read.
 */
export function chromiumSessionTabs(data: Uint8Array): ImportedTab[] {
  const buf = Buffer.from(data)
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'SNSS') throw new Error('Not a Chromium session file.')
  const tabs = new Map<number, { navs: Map<number, { url: string; title: string }>; selected: number | null; pinned: boolean; window: number | null; index: number }>()
  const closedWindows = new Set<number>()
  const tab = (id: number) => {
    let t = tabs.get(id)
    if (!t) {
      t = { navs: new Map(), selected: null, pinned: false, window: null, index: tabs.size }
      tabs.set(id, t)
    }
    return t
  }
  let at = 8
  while (at + 3 <= buf.length) {
    const size = buf.readUInt16LE(at)
    if (size < 1 || at + 2 + size > buf.length) break
    const id = buf.readUInt8(at + 2)
    const payload = buf.subarray(at + 3, at + 2 + size)
    at += 2 + size
    try {
      if (id === SNSS.updateTabNavigation) {
        // A Pickle: uint32 payload size, then tab id, index, url, title.
        if (payload.length < 12) continue
        const tabId = payload.readInt32LE(4)
        const index = payload.readInt32LE(8)
        const url = pickleString(payload, 12)
        if (!url) continue
        const title = pickleString16(payload, url.next)
        tab(tabId).navs.set(index, { url: url.value, title: title?.value ?? '' })
      } else if (id === SNSS.setSelectedNavigationIndex && payload.length >= 8) {
        tab(payload.readInt32LE(0)).selected = payload.readInt32LE(4)
      } else if (id === SNSS.setPinnedState && payload.length >= 5) {
        tab(payload.readInt32LE(0)).pinned = payload.readUInt8(4) !== 0
      } else if (id === SNSS.setTabWindow && payload.length >= 8) {
        tab(payload.readInt32LE(4)).window = payload.readInt32LE(0)
      } else if (id === SNSS.setTabIndexInWindow && payload.length >= 8) {
        tab(payload.readInt32LE(0)).index = payload.readInt32LE(4)
      } else if (id === SNSS.tabClosed && payload.length >= 4) {
        tabs.delete(payload.readInt32LE(0))
      } else if (id === SNSS.windowClosed && payload.length >= 4) {
        closedWindows.add(payload.readInt32LE(0))
      }
    } catch {
      // A truncated command; skip it.
    }
  }
  const out: Array<ImportedTab & { order: number }> = []
  for (const t of tabs.values()) {
    if (t.window !== null && closedWindows.has(t.window)) continue
    const indexes = [...t.navs.keys()].sort((a, b) => a - b)
    const pick = t.selected !== null && t.navs.has(t.selected) ? t.selected : indexes[indexes.length - 1]
    const nav = pick === undefined ? undefined : t.navs.get(pick)
    if (nav && /^https?:/i.test(nav.url)) out.push({ url: nav.url, title: nav.title || nav.url, pinned: t.pinned, order: (t.window ?? 0) * 10_000 + t.index })
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...tab }) => tab)
}

// ---- search engines ----

export interface ImportedEngine {
  name: string
  template: string
}

/** Chromium's keywords table: '{searchTerms}' becomes Atelier's '%s'; Google's own placeholders are dropped. */
export function chromiumEngine(row: { short_name: string; url: string }): ImportedEngine | null {
  return engineFrom(row.short_name, row.url)
}

/** Firefox's search.json: engines with a GET search URL template. */
export function firefoxEngines(json: unknown): ImportedEngine[] {
  const engines = (json as { engines?: unknown } | null)?.engines
  if (!Array.isArray(engines)) return []
  const out: ImportedEngine[] = []
  for (const e of engines) {
    const engine = e as { _name?: unknown; _urls?: unknown } | null
    if (!engine || typeof engine._name !== 'string' || !Array.isArray(engine._urls)) continue
    const search = engine._urls.find((u) => (u as { type?: unknown; rels?: unknown }).type === 'text/html' || (u as { type?: unknown }).type === undefined) as
      | { template?: unknown; params?: unknown }
      | undefined
    if (!search || typeof search.template !== 'string') continue
    let template = search.template
    if (Array.isArray(search.params) && search.params.length > 0) {
      const query = (search.params as Array<{ name?: unknown; value?: unknown }>)
        .filter((p) => typeof p.name === 'string' && typeof p.value === 'string')
        .map((p) => `${encodeURIComponent(p.name as string)}=${p.value as string}`)
        .join('&')
      if (query) template += (template.includes('?') ? '&' : '?') + query
    }
    const parsed = engineFrom(engine._name, template)
    if (parsed) out.push(parsed)
  }
  return out
}

function engineFrom(name: string, url: string): ImportedEngine | null {
  const clean = name.trim().slice(0, 60)
  if (!clean || !url.includes('{searchTerms}')) return null
  const template = url
    .replace(/\{searchTerms\}/g, '%s')
    .replace(/\{google:[A-Za-z]+\}/g, '')
    .replace(/\{(inputEncoding|outputEncoding)\??\}/g, 'UTF-8')
    // Preserve query separators in both the URL and any fragment-based route.
    .replace(/(^|#)([^?#]*)\?([^#]*)/g, (_, separator: string, base: string, query: string) => {
      const params = query.split('&').filter((param) => !/^\w+=\{[^}]*\}$/.test(param))
      return `${separator}${base}${params.length ? '?' + params.join('&') : ''}`
    })
  if (!/^https?:\/\/[^\s]*%s/.test(template) || template.length > 2048 || /\{[^}]*\}/.test(template)) return null
  return { name: clean, template }
}

/** An id for an imported engine that doesn't clash with the ones already saved. */
export function engineId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'engine'
  let id = /^[a-z0-9]/.test(base) ? base : `e-${base}`
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}
