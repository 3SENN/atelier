/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../../ui/logic/format'
import { MenuList } from './MenuList'
import { SEARCH_THRESHOLD, closeInnermost, openPath, placeSubmenu, unionBox, type Box } from './logic'
import type { KitHandlers, KitItem } from './types'
import { t } from '../../i18n/useT'
import { windowViewport } from '../host/windowSize'

// A menu whose rows open side cards (DS-94, SH-54): submenus cascade about
// 3 px beside the parent card, each with its own scrolling list (and search
// row when long), the parent row stays highlighted, Escape and ← close the
// innermost level first, and a pointer heading for an open submenu keeps it
// open. Every card is marked data-kit-card, so hosts tell inside from outside.

export interface CascadeMenuProps {
  items: KitItem[]
  label: string
  /** A search row on the root list. */
  search?: string
  handlers: KitHandlers
  /** Width of submenu cards. */
  submenuWidth?: number
  /** Where submenus prefer to open (the main menu opens them to the right). */
  prefer?: 'right' | 'left'
  /** Hears the union of every open card (the root card's own box included by the caller). */
  onSubmenusBounds?(box: Box | null): void
  /** Keyboard focus starts in the root list. */
  autoFocus?: boolean
}

interface Level {
  /** The parent row's item id; its rows are looked up afresh when the items change. */
  id: string
  /** The parent row's box when it opened. */
  row: Box
  /** The parent card's box. */
  parent: Box
  how: 'pointer' | 'keyboard'
}

/** The items behind each open level, walking ids from the root; stops where a row has gone. */
function resolveChain(items: readonly KitItem[], levels: readonly Level[]): KitItem[] {
  const out: KitItem[] = []
  let rows: readonly KitItem[] = items
  for (const level of levels) {
    const item = rows.find((r) => r.id === level.id && (r.submenu || r.panel))
    if (!item) break
    out.push(item)
    rows = item.submenu ?? []
  }
  return out
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

export function CascadeMenu({ items, label, search, handlers, submenuWidth = 240, prefer = 'right', onSubmenusBounds, autoFocus = true }: CascadeMenuProps): ReactElement {
  const [levels, setLevels] = useState<Level[]>([])
  const [path, setPath] = useState<number[]>([])
  const [boxes, setBoxes] = useState<Record<number, { box: Box; side: 'right' | 'left' }>>({})
  const [focusLevel, setFocusLevel] = useState(0)

  const open = useCallback((level: number, index: number, item: KitItem, row: HTMLElement, how: 'pointer' | 'keyboard') => {
    const card = row.closest('[data-kit-card]')
    if (!card) return
    setPath((p) => openPath(p, level, index))
    setLevels((ls) => [...ls.slice(0, level), { id: item.id, row: boxOf(row), parent: boxOf(card), how }])
    if (how === 'keyboard') setFocusLevel(level + 1)
  }, [])

  const closeFrom = useCallback((level: number) => {
    // Closing level n keeps levels above it.
    setPath((p) => p.slice(0, level))
    setLevels((ls) => ls.slice(0, level))
    setBoxes((b) => Object.fromEntries(Object.entries(b).filter(([k]) => Number(k) <= level)))
    setFocusLevel((f) => Math.min(f, level))
  }, [])

  const closeInner = useCallback(() => {
    setPath((p) => closeInnermost(p))
    setLevels((ls) => ls.slice(0, -1))
    setFocusLevel((f) => Math.max(0, f - 1))
  }, [])

  // New rows (a refreshed model) keep open submenus whose rows still exist, so a zoom click doesn't fold More Tools away.
  const chain = resolveChain(items, levels)
  useEffect(() => {
    if (chain.length < levels.length) closeFrom(chain.length)
  }, [chain.length, levels.length, closeFrom])

  useEffect(() => {
    const open = levels.map((_, i) => boxes[i + 1]?.box).filter((b): b is Box => !!b)
    onSubmenusBounds?.(unionBox(open))
  }, [boxes, levels, onSubmenusBounds])

  // Focus returns to the parent level's list when a level closes from the keyboard.
  const lists = useRef<Record<number, HTMLElement | null>>({})
  // Side cards go into the overlay frame when there is one (fixed children of
  // its transformed root use window coordinates), else into the body.
  const [portal, setPortal] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => setPortal(lists.current[0]?.closest<HTMLElement>('.ov-frame') ?? document.body), [])
  useEffect(() => {
    const el = lists.current[focusLevel]
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('.kit-search input, .kit-list')?.focus({ preventScroll: true })
  }, [focusLevel])

  const levelItems = (level: number): KitItem[] => (level === 0 ? items : (chain[level - 1]?.submenu ?? []))

  const list = (level: number, rows: KitItem[], side: 'right' | 'left', searchText?: string): ReactElement => (
    <MenuList
      items={rows}
      label={level === 0 ? label : (chain[level - 1]?.label ?? label)}
      level={level}
      side={side}
      search={searchText}
      openIndex={path[level] ?? null}
      openBox={boxes[level + 1]?.box ?? null}
      openSide={boxes[level + 1]?.side ?? prefer}
      autoFocus={level === 0 ? autoFocus && focusLevel === 0 : focusLevel === level}
      handlers={handlers}
      onOpen={(index, row, how) => {
        const item = rows[index]
        if (item) open(level, index, item, row, how)
      }}
      onCloseChild={() => closeFrom(level)}
      onCloseLevel={() => closeFrom(level - 1)}
    />
  )

  return (
    <>
      <div ref={(el) => void (lists.current[0] = el)}>{list(0, items, prefer, search)}</div>
      {portal && levels.map((lv, i) => {
        const level = i + 1
        const item = chain[i]
        if (!item) return null
        const rows = levelItems(level)
        const searchText = item.search ?? (rows.length > SEARCH_THRESHOLD ? t('menus.kit.search') : undefined)
        return createPortal(
          <SideCard
            key={`${level}:${lv.id}`}
            level={level}
            entry={lv}
            item={item}
            width={submenuWidth}
            prefer={prefer}
            label={item.label}
            listRef={(el) => void (lists.current[level] = el)}
            onPlaced={(box, side) => setBoxes((b) => (b[level]?.box.left === box.left && b[level]?.box.top === box.top && b[level]?.box.height === box.height ? b : { ...b, [level]: { box, side } }))}
            onPanelKey={(e) => {
              if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement))) {
                e.preventDefault()
                e.stopPropagation()
                closeInner()
              }
            }}
            autoFocusPanel={focusLevel === level}
          >
            {item.panel ? item.panel() : list(level, rows, boxes[level]?.side ?? prefer, searchText)}
          </SideCard>,
          portal,
        )
      })}
    </>
  )
}

interface SideCardProps {
  level: number
  entry: Level
  item: KitItem
  width: number
  prefer: 'right' | 'left'
  label: string
  children: ReactNode
  listRef(el: HTMLElement | null): void
  onPlaced(box: Box, side: 'right' | 'left'): void
  onPanelKey(e: KeyboardEvent): void
  autoFocusPanel: boolean
}

/** A submenu card beside its parent row. */
function SideCard({ level, entry, item, width, prefer, label, children, listRef, onPlaced, onPanelKey, autoFocusPanel }: SideCardProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number; side: 'right' | 'left' } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const at = placeSubmenu(entry.row, entry.parent, { width: el.offsetWidth, height: el.scrollHeight }, { width: windowViewport().width, height: windowViewport().height }, { prefer })
      setPlace((p) => (p && p.left === at.left && p.top === at.top && p.maxHeight === at.maxHeight ? p : at))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [entry, prefer])

  useLayoutEffect(() => {
    const el = ref.current
    if (place && el) onPlaced({ left: place.left, top: place.top, width: el.offsetWidth, height: Math.min(el.scrollHeight, place.maxHeight) }, place.side)
  })

  useEffect(() => {
    // A panel (the appearance flyout) takes focus on its first control when opened from the keyboard.
    if (autoFocusPanel && item.panel) ref.current?.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus({ preventScroll: true })
  }, [autoFocusPanel, !!item.panel])

  // Transparent until placed (not hidden), so a keyboard-opened list can take focus as it mounts.
  const style = { width, left: place?.left ?? 0, top: place?.top ?? 0, maxHeight: place?.maxHeight, ...(place ? {} : { opacity: 0, pointerEvents: 'none' }) } as CSSProperties
  return (
    <div
      ref={(el) => {
        ref.current = el
        listRef(el)
      }}
      className={cx('kit-card', 'kit-card--side', item.panel && 'kit-card--panel')}
      style={style}
      data-kit-card=""
      data-level={level}
      data-placed={place ? '' : undefined}
      role={item.panel ? 'group' : 'presentation'}
      aria-label={label}
      onKeyDown={item.panel ? onPanelKey : undefined}
    >
      {children}
    </div>
  )
}
