/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  firefoxSessionTabs,
  lz4Block,
  parseXmlPlist,
  readMozLz4,
  safariBookmarks,
  safariTimeToMs,
} from '../src/main/importFormats'

describe('Safari property lists', () => {
  it('reads nested values, XML entities and binary data', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0">
        <dict>
          <key>title</key><string>Research &amp; Design &#x2F; Notes</string>
          <key>items</key><array><integer>2</integer><real>1.5</real><true/><false/></array>
          <key>added</key><date>2026-01-01T00:00:00Z</date>
          <key>bytes</key><data>AQ I=</data>
        </dict>
      </plist>`
    expect(parseXmlPlist(xml)).toEqual({
      title: 'Research & Design / Notes',
      items: [2, 1.5, true, false],
      added: new Date('2026-01-01T00:00:00Z'),
      bytes: Uint8Array.of(1, 2),
    })
  })

  it('rejects a missing plist root and malformed values', () => {
    expect(() => parseXmlPlist('<html/>')).toThrow('Not a property list.')
    expect(() => parseXmlPlist('<plist><string>unfinished</plist>')).toThrow('Malformed property list.')
  })

  it('rejects a value nested past 128 levels', () => {
    const nested = '<array>'.repeat(129) + '<string/>' + '</array>'.repeat(129)
    expect(() => parseXmlPlist('<plist>' + nested + '</plist>')).toThrow('Property list nested too deeply.')
  })

  it('flattens nested bookmarks, uses a URL fallback and ignores incomplete leaves', () => {
    expect(safariBookmarks({
      Children: [{
        Children: [
          { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://example.com/notes', URIDictionary: { title: 'Notes' } },
          { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://example.com/' },
          { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 2 },
        ],
      }],
    })).toEqual([
      { url: 'https://example.com/notes', title: 'Notes' },
      { url: 'https://example.com/', title: 'https://example.com/' },
    ])
  })

  it('converts Safari seconds since 2001 to Unix milliseconds', () => {
    const epoch = Date.UTC(2001, 0, 1)
    expect(safariTimeToMs(0)).toBe(epoch)
    expect(safariTimeToMs(1.2346)).toBe(epoch + 1_235)
    expect(safariTimeToMs(-1)).toBe(epoch - 1_000)
  })
})

describe('Firefox compressed files', () => {
  it('decodes overlapping LZ4 matches and final literals', () => {
    // Two literals ("ab"), an eight-byte match at offset two, then five final literals.
    const compressed = Buffer.concat([
      Buffer.of(0x24), Buffer.from('ab'), Buffer.of(2, 0, 0x50), Buffer.from('12345'),
    ])
    expect(lz4Block(compressed, 15)).toEqual(Uint8Array.from(Buffer.from('ababababab12345')))
  })

  it('rejects a corrupt LZ4 offset and truncated literals', () => {
    expect(() => lz4Block(Uint8Array.of(0x10, 0x61, 0, 0), 5)).toThrow('Corrupt compressed data.')
    expect(() => lz4Block(Uint8Array.of(0x30, 0x61), 3)).toThrow('Corrupt compressed data.')
  })

  it('reads a mozlz4 header, uncompressed size and JSON payload', () => {
    const json = Buffer.from('{"windows":[]}')
    const size = Buffer.alloc(4)
    size.writeUInt32LE(json.length)
    // This payload fits in the token's four-bit literal length.
    const file = Buffer.concat([Buffer.from('mozLz40\0'), size, Buffer.of(json.length << 4), json])
    expect(readMozLz4(file)).toEqual({ windows: [] })
  })

  it('rejects wrong magic bytes and a short mozlz4 header', () => {
    expect(() => readMozLz4(Buffer.from('notLz40\0' + '\0'.repeat(4)))).toThrow('Not a Firefox compressed file.')
    expect(() => readMozLz4(Buffer.from('mozLz40\0'))).toThrow('Not a Firefox compressed file.')
  })
})

describe('Firefox session tabs', () => {
  it('selects active entries and keeps pinned tabs while skipping non-web entries', () => {
    const session = {
      windows: [
        {
          tabs: [
            {
              pinned: true,
              index: 1,
              entries: [
                { url: 'https://example.com/current', title: 'Current' },
                { url: 'https://example.com/next', title: 'Next' },
              ],
            },
            { entries: [{ url: 'https://example.com/previous' }, { url: 'https://example.com/latest' }] },
            { entries: [{ url: 'about:blank' }] },
            { entries: [] },
            null,
          ],
        },
        {},
      ],
    }
    expect(firefoxSessionTabs(session)).toEqual([
      { url: 'https://example.com/current', title: 'Current', pinned: true },
      { url: 'https://example.com/latest', title: 'https://example.com/latest', pinned: false },
    ])
  })

  it('returns no tabs when the session has no windows array', () => {
    expect(firefoxSessionTabs(null)).toEqual([])
    expect(firefoxSessionTabs({ windows: 'invalid' })).toEqual([])
  })
})
