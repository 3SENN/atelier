/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest'
import { chromiumEngine, engineId, firefoxEngines } from '../src/main/importFormats'

describe('Chromium search engine import', () => {
  const search = 'https://example.test/search'

  it.each([
    ['/search?pc={moz:distributionID}&q={searchTerms}', '/search?q=%s'],
    ['/search?pc={moz:distributionID}&lang={locale}&q={searchTerms}', '/search?q=%s'],
    ['/search?client=desktop&pc={moz:distributionID}&q={searchTerms}&lang={locale}', '/search?client=desktop&q=%s'],
    ['/search/{searchTerms}?pc={moz:distributionID}#results', '/search/%s#results'],
    ['/search?pc={moz:distributionID}&q={searchTerms}&view=a%2Fb#top', '/search?q=%s&view=a%2Fb#top'],
    ['/app#/find?q={searchTerms}&pc={moz:distributionID}', '/app#/find?q=%s'],
    ['/app?theme=light#/find?pc={moz:distributionID}&q={searchTerms}', '/app?theme=light#/find?q=%s'],
  ])('keeps the remaining parameters in %s', (input, expected) => {
    expect(chromiumEngine({ short_name: ' Example ', url: 'https://example.test' + input })).toEqual({
      name: 'Example',
      template: 'https://example.test' + expected,
    })
  })

  it('keeps supported placeholders and rejects a URL with no search term', () => {
    expect(chromiumEngine({ short_name: 'Example', url: search + '?q={searchTerms}&ie={inputEncoding?}' })?.template)
      .toBe(search + '?q=%s&ie=UTF-8')
    expect(chromiumEngine({ short_name: 'Example', url: search + '?q=static' })).toBeNull()
  })
})

it('imports a Firefox engine whose first parameter is an unsupported placeholder', () => {
  expect(firefoxEngines({
    engines: [
      { _name: 'No search endpoint', _urls: [] },
      {
        _name: 'Bing',
        _urls: [{
          type: 'text/html',
          template: 'https://www.bing.com/search',
          params: [
            { name: 'pc', value: '{moz:distributionID}' },
            { name: 'q', value: '{searchTerms}' },
          ],
        }],
      },
    ],
  })).toEqual([{ name: 'Bing', template: 'https://www.bing.com/search?q=%s' }])
})

it('uses the first available search engine ID and falls back for an empty slug', () => {
  expect(engineId(' Example & Search ', new Set(['example-search', 'example-search-2']))).toBe('example-search-3')
  expect(engineId('★', new Set())).toBe('engine')
})
