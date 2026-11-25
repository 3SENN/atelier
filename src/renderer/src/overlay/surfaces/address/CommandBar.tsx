/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import type { CommandBarProps, CommandBarResult } from '@shared/overlay/address'
import { copyValue, flattenGroups, stepSelection, type OmniboxAction, type OmniboxCompletion, type OmniboxGroup, type OmniboxRow } from '@shared/omnibox'
import { displayHost } from '@shared/domains'
import { Clock, Command, Globe, LayoutGrid, MessageSquareText, Search, Settings, Sparkles, Star, X } from 'lucide-react'
import { atelier, call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { askFirst, askHinted, completesInline, enterAction, enterOptions, hintQuery, type AskHint } from './enter'
import { groupLabel, highlight } from './rows'
import { windowViewport } from '../../host/windowSize'

// The command bar (SH-35, SH-36, DS-23, DS-110): drawn over the pill in the
// interactive overlay, so the field turns solid in place and the
// suggestions grow down from it without hiding the page. Every group comes
// from main's omnibox providers; the bar only ranks keys and selection.

const ROW_ICONS: Record<string, ReactNode> = {
  typed: <Search size={15} aria-hidden />,
  top: <Globe size={15} aria-hidden />,
  ask: <Sparkles size={15} aria-hidden />,
  suggest: <Search size={15} aria-hidden />,
  tabs: <LayoutGrid size={15} aria-hidden />,
  bookmarks: <Star size={15} aria-hidden />,
  history: <Clock size={15} aria-hidden />,
  commands: <Command size={15} aria-hidden />,
  settings: <Settings size={15} aria-hidden />,
  chats: <MessageSquareText size={15} aria-hidden />,
}

/** How long typing pauses before the search-or-ask question goes out (DC-14, as on the new tab). */
const HINT_PAUSE_MS = 350

export function rowIcon(row: OmniboxRow): ReactNode {
  if (row.icon && /^(https?:|data:image\/)/.test(row.icon)) return <img className="cb-row__fav" src={row.icon} alt="" draggable={false} />
  return ROW_ICONS[row.group] ?? <Globe size={15} aria-hidden />
}

/** The field's text split for the untouched address: the registrable domain strong, the rest muted. */
function addressMirror(text: string): ReactNode | null {
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  const host = parsed.hostname
  const at = text.indexOf(host)
  if (at < 0) return null
  const reg = displayHost(text).registrable
  const regAt = reg ? text.indexOf(reg, at) : -1
  if (regAt < 0) return null
  return (
    <>
      <span className="cb-mirror__dim">{text.slice(0, regAt)}</span>
      <span className="cb-mirror__strong">{text.slice(regAt, regAt + reg.length)}</span>
      <span className="cb-mirror__dim">{text.slice(regAt + reg.length)}</span>
    </>
  )
}

export function CommandBar({ props, resolve, close, anchorRect, viewport }: SurfaceComponentProps<CommandBarProps>): ReactElement {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(props.text)
  const [typed, setTyped] = useState(props.text)
  const [touched, setTouched] = useState(false)
  const [groups, setGroups] = useState<OmniboxGroup[]>([])
  /** The text the shown rows answer: Enter pressed before the rows for what's typed arrive asks again rather than running stale ones. */
  const [groupsFor, setGroupsFor] = useState<string | null>(null)
  const [selected, setSelected] = useState(-1)
  const [completion, setCompletion] = useState<OmniboxCompletion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  /** → on the untouched field drops the two-tone mirror and shows the plain, full address. */
  const [revealed, setRevealed] = useState(false)
  /** DC-14: what a decision model made of the typed text after a pause. */
  const [hint, setHint] = useState<AskHint | null>(null)
  const seq = useRef(0)
  const deleting = useRef(false)
  const done = useRef(false)
  const latest = useRef({ value, touched, typed, selected })
  latest.current = { value, touched, typed, selected }

  // A sure "ask" for the text in the field puts the Ask row first, so Enter asks; arrows move through that order.
  const askOn = askHinted(hint, typed, completion)
  const shown = useMemo(() => {
    const visible = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !removed.has(r.id)) })).filter((g) => g.rows.length > 0)
    return askOn ? askFirst(visible) : visible
  }, [groups, removed, askOn])
  const rows = useMemo(() => flattenGroups(shown), [shown])

  const runQuery = (text: string): void => {
    const id = ++seq.current
    setError(null)
    if (!text.trim()) {
      setGroupsFor(null)
      setGroups([])
      setCompletion(null)
      setSelected(-1)
      return
    }
    void call('omnibox', 'query', text).then(
      (next) => {
        if (id !== seq.current) return
        setGroupsFor(text)
        setGroups(next)
        setSelected(-1)
      },
      () => undefined,
    )
    if (deleting.current) {
      setCompletion(null)
      return
    }
    void call('omnibox', 'complete', text).then(
      (c) => {
        if (id !== seq.current) return
        setCompletion(c)
        const field = input.current
        // Inline only when it extends what was typed; a typo shows as a hint instead.
        if (completesInline(c, text) && field) {
          const full = text + c.text.slice(text.length)
          setValue(full)
          requestAnimationFrame(() => field.setSelectionRange(text.length, full.length))
        }
      },
      () => undefined,
    )
  }

  useEffect(() => {
    const field = input.current
    if (!field) return
    field.focus()
    if (props.selectAll) field.select()
    else field.setSelectionRange(field.value.length, field.value.length)
    if (props.submit) void commit(null)
    else if (!props.selectAll && props.text) runQuery(props.text)
    // Mount only: later props come from the field itself.
  }, [])

  // DC-14 (Settings › Quick decisions): a pause in typing asks whether the text is a search or a
  // question, never per key and never in a private window. A hint for older text, or one that
  // arrives after a row was picked, changes nothing.
  useEffect(() => {
    const query = touched ? hintQuery(typed, atelier.initial.window.kind === 'private') : null
    if (!query) return
    const timer = setTimeout(() => {
      call('decisions', 'searchOrAsk', query, 'search').then(
        (kind) => {
          const now = latest.current
          if (now.typed.trim() === query && now.selected < 0) setHint({ text: query, kind })
        },
        () => undefined,
      )
    }, HINT_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [typed, touched])

  // Closing without running anything keeps the unfinished text for the tab (Esc clears it first).
  useEffect(
    () => () => {
      if (done.current) return
      const { value: text, touched: changed } = latest.current
      void call('omnibox', 'setDraft', props.tabId, changed && text.trim() ? text : null).catch(() => undefined)
    },
    [props.tabId],
  )

  const finish = (result: CommandBarResult): void => {
    done.current = true
    resolve(result)
  }

  /** Runs a row (or what's typed), here or in a new tab (enterOptions: ⌘ behind, ⌥ in front). */
  async function commit(row: OmniboxRow | null, where: { background?: true; newTab?: true } = {}): Promise<void> {
    const text = latest.current.value
    // Without a picked row: the completion or the top row when they answer what's typed now, else fresh rows.
    let action: OmniboxAction | null = row?.action ?? enterAction({ value: text, typed: latest.current.typed, completion, rowsFor: groupsFor, rows })
    if (!action) {
      if (!text.trim()) return
      const fresh = await call('omnibox', 'query', text).catch(() => [] as OmniboxGroup[])
      action = flattenGroups(askOn ? askFirst(fresh) : fresh)[0]?.action ?? null
      if (!action) return
    }
    try {
      const result = await call('omnibox', 'commit', props.tabId, typed, action, where)
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.ask) finish({ kind: 'ask', text: result.ask })
      else finish({ kind: 'done' })
    } catch (err) {
      setError(errorText(err))
    }
  }

  const choose = (index: number): void => {
    setSelected(index)
    const row = rows[index]
    if (row && (row.url || row.action.kind === 'navigate')) setValue(row.url ?? (row.action.kind === 'navigate' ? row.action.url : value))
  }

  const removeRow = (row: OmniboxRow): void => {
    if (!row.url) return
    void call('omnibox', 'removeHistory', row.url).catch(() => undefined)
    setRemoved((s) => new Set(s).add(row.id))
    setSelected(-1)
    input.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const mod = e.metaKey || e.ctrlKey
    deleting.current = e.key === 'Backspace' || e.key === 'Delete'
    if (e.key === 'Escape') {
      e.preventDefault()
      done.current = true
      void call('omnibox', 'setDraft', props.tabId, null).catch(() => undefined)
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void commit(selected >= 0 ? (rows[selected] ?? null) : null, enterOptions(e))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      // DS-110: on an empty new tab, Tab hands the text to the page's ask field.
      if (props.blank && !e.shiftKey) {
        finish({ kind: 'focus-ask', text: value })
        return
      }
      const next = stepSelection(selected, rows.length, e.shiftKey ? -1 : 1, true)
      if (next === -1) {
        setSelected(-1)
        setValue(typed)
      } else choose(next)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return
      e.preventDefault()
      const next = stepSelection(selected, rows.length, e.key === 'ArrowDown' ? 1 : -1, false)
      // ↑ from the first row restores what you typed.
      if (next === -1) {
        setSelected(-1)
        setValue(typed)
      } else choose(next)
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.shiftKey && !mod && !e.altKey) {
      const field = e.currentTarget
      const start = field.selectionStart ?? 0
      const end = field.selectionEnd ?? 0
      // → and ← accept an inline completion: it becomes what you typed.
      if (completion && !completion.typo && field.value === completion.text && start < end && end === field.value.length) {
        e.preventDefault()
        const at = e.key === 'ArrowRight' ? field.value.length : start
        setTyped(field.value)
        setTouched(true)
        setCompletion(null)
        field.setSelectionRange(at, at)
        return
      }
      if (e.key === 'ArrowRight' && !touched && !revealed) {
        e.preventDefault()
        setRevealed(true)
        field.setSelectionRange(field.value.length, field.value.length)
      }
    } else if (mod && e.key.toLowerCase() === 'c') {
      const field = e.currentTarget
      const text = copyValue(field.value, [field.selectionStart ?? 0, field.selectionEnd ?? 0], props.url)
      if (text) {
        e.preventDefault()
        void navigator.clipboard.writeText(text).catch(() => undefined)
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey && selected >= 0 && rows[selected]?.removable) {
      e.preventDefault()
      removeRow(rows[selected] as OmniboxRow)
    }
  }

  const typo = completion?.typo && completion.input === typed ? completion : null
  const mirror = !touched && !revealed && props.selectAll ? addressMirror(value) : null
  // The ring sits 2 px outside the pill, so the surface is 4 px wider than its anchor.
  const width = (anchorRect?.width ?? 516) + 4
  const maxCard = Math.max(160, (viewport?.height ?? windowViewport().height) - (anchorRect?.y ?? 0) - 64)
  const open = rows.length > 0 || error !== null
  let index = -1
  return (
    <div className={cx('cb', open && 'cb--open')} style={{ width }} role="presentation">
      <div className="cb-field">
        <Search size={16} className="cb-field__lead" aria-hidden />
        <div className="cb-field__box">
          {mirror && (
            <div className="cb-mirror" aria-hidden>
              {mirror}
            </div>
          )}
          <input
            ref={input}
            data-autofocus
            className={cx('cb-field__input', mirror !== null && 'cb-field__input--mirrored')}
            value={value}
            placeholder={t('address.pill.placeholder')}
            aria-label={t('address.pill.label')}
            role="combobox"
            aria-expanded={open}
            aria-controls="cb-list"
            aria-autocomplete="both"
            aria-activedescendant={selected >= 0 ? `cb-row-${selected}` : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              const text = e.target.value
              setValue(text)
              setTyped(text)
              setTouched(true)
              runQuery(text)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {typo && <span className="cb-field__typo">{t('address.row.open')} {displayHost(typo.url).display}</span>}
        {props.blank && (
          <span className="cb-field__hint" title={t('address.pill.blankHintLabel', { companion: props.companion })}>
            <kbd className="cb-kbd">Tab</kbd>
            {t('address.pill.blankHint')}
          </span>
        )}
      </div>
      {open && (
        <div className="cb-card" style={{ maxHeight: maxCard }}>
          {error && (
            <p className="cb-error" role="alert">
              {error}
            </p>
          )}
          <ul className="cb-list" id="cb-list" role="listbox" aria-label={t('address.bar.suggestions')}>
            {shown.map((group) => (
              <li key={group.group} role="presentation" className="cb-group">
                {group.group !== 'typed' && group.group !== 'ask' && <div className="cb-group__label">{groupLabel(group.group, t)}</div>}
                <ul role="group" aria-label={groupLabel(group.group, t)}>
                  {group.rows.map((row) => {
                    index += 1
                    const i = index
                    const title = row.group === 'ask' ? t('address.row.ask', { companion: props.companion }) : row.title
                    return (
                      <li
                        key={row.id}
                        id={`cb-row-${i}`}
                        role="option"
                        aria-selected={i === selected}
                        data-group={row.group}
                        className={cx('cb-row', i === selected && 'cb-row--selected')}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setSelected(i)}
                        onClick={(e) => void commit(row, enterOptions(e))}
                        onAuxClick={(e) => {
                          if (e.button === 1) void commit(row, { background: true })
                        }}
                      >
                        <span className="cb-row__icon">{rowIcon(row)}</span>
                        <span className="cb-row__text">
                          <span className="cb-row__title">{row.group === 'ask' ? title : highlight(title, row.match)}</span>
                          {(row.group === 'ask' ? row.action.kind === 'ask' && row.action.text : row.subtitle) && (
                            <span className="cb-row__sub">{row.group === 'ask' && row.action.kind === 'ask' ? row.action.text : row.subtitle}</span>
                          )}
                        </span>
                        {row.removable && (
                          <button
                            type="button"
                            className="cb-row__remove"
                            aria-label={t('address.row.remove')}
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation()
                              removeRow(row)
                            }}
                          >
                            <X size={13} aria-hidden />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
