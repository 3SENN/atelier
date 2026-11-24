/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { chromiumSessionTabs } from '../src/main/importFormats'

// A synthetic SNSS stream with the command layouts used by session import.
function session(...commands: Buffer[]): Buffer {
  const header = Buffer.alloc(8)
  header.write('SNSS')
  header.writeInt32LE(1, 4)
  return Buffer.concat([header, ...commands])
}

function command(id: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(3)
  header.writeUInt16LE(payload.length + 1)
  header.writeUInt8(id, 2)
  return Buffer.concat([header, payload])
}

function ints(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => data.writeInt32LE(value, index * 4))
  return data
}

function pickleText(text: string, encoding: 'utf8' | 'utf16le'): Buffer {
  const bytes = Buffer.from(text, encoding)
  const data = Buffer.alloc(4 + Math.ceil(bytes.length / 4) * 4)
  data.writeInt32LE(encoding === 'utf16le' ? bytes.length / 2 : bytes.length)
  bytes.copy(data, 4)
  return data
}

function navigation(tab: number, index: number, url: string, title: string): Buffer {
  const pickle = Buffer.concat([ints(tab, index), pickleText(url, 'utf8'), pickleText(title, 'utf16le')])
  return command(6, Buffer.concat([ints(pickle.length), pickle]))
}

describe('Chromium SNSS session import', () => {
  it('restores selected and pinned tabs in window order and drops closed tabs and windows', () => {
    const stream = session(
      navigation(10, 0, 'https://example.test/chosen', 'Café 🧭'),
      navigation(10, 1, 'https://example.test/later', 'Later'),
      command(7, ints(10, 0)), // Select the earlier navigation.
      command(12, ints(10, 1)), // Pin the tab.
      navigation(20, 0, 'https://example.test/first', ''),
      command(0, ints(1, 10)), // Put both tabs in window 1.
      command(0, ints(1, 20)),
      command(2, ints(10, 1)), // Set tab 20 before tab 10.
      command(2, ints(20, 0)),
      navigation(30, 0, 'https://example.test/closed-tab', 'Closed tab'),
      command(16, ints(30)),
      navigation(40, 0, 'https://example.test/closed-window', 'Closed window'),
      command(0, ints(2, 40)),
      command(17, ints(2)),
    )

    expect(chromiumSessionTabs(stream)).toEqual([
      { url: 'https://example.test/first', title: 'https://example.test/first', pinned: false },
      { url: 'https://example.test/chosen', title: 'Café 🧭', pinned: true },
    ])
  })

  it('rejects an otherwise sized header with the wrong magic', () => {
    const stream = session()
    stream.write('NOPE')

    expect(() => chromiumSessionTabs(stream)).toThrow('Not a Chromium session file.')
  })

  it('keeps complete tabs before a truncated command', () => {
    const partial = navigation(2, 0, 'https://example.test/incomplete', 'Incomplete').subarray(0, -1)
    const stream = session(navigation(1, 0, 'https://example.test/complete', 'Complete'), partial)

    expect(chromiumSessionTabs(stream)).toEqual([
      { url: 'https://example.test/complete', title: 'Complete', pinned: false },
    ])
  })
})
