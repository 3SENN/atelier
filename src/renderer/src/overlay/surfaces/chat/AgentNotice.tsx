/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { GripVertical, MessageSquare, PanelRight, PanelRightClose, ShieldCheck, Square } from 'lucide-react'
import { NOTICE_GAP, NOTICE_STEP, movedPosition } from '@shared/agentControl'
import { accentVariables } from '@shared/accent'
import type { AgentNoticeProps } from '@shared/overlay/chat'
import { call } from '../../../api'
import { useT } from '../../../i18n/useT'
import { useMotion } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { ACTION_LABEL, actionCall, noticeContent, type NoticeAction } from './logic'
import { windowViewport } from '../../host/windowSize'
import './atWork.css'

// OV-21: the floating notice over a tab the agent holds. It says which
// companion is in control and what it is doing, and offers take over, hand
// back, open chat, stop and side by side; on a human check it asks you to
// solve it. Draggable (pointer or arrow keys), and its spot is kept per tab
// by main. It sits on its own opaque card, so it reads on any page.

export function AgentNotice({ props, anchorRect, viewport: shownIn, exiting }: SurfaceComponentProps<AgentNoticeProps>): ReactElement {
  // The host always passes the window's viewport; fall back to the window itself when it doesn't.
  const viewport = shownIn ?? { x: 0, y: 0, width: windowViewport().width, height: windowViewport().height }
  const t = useT()
  const { reduced } = useMotion()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const seenNudge = useRef(props.nudge)
  const start = useRef<{ px: number; py: number } | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const content = noticeContent(props, now, seenNudge.current)

  // The solved confirmation is time-bound; one re-render ends it.
  useEffect(() => {
    if (!props.solvedAt) return
    const timer = setTimeout(() => setNow(Date.now()), 2300)
    return () => clearTimeout(timer)
  }, [props.solvedAt])

  // A nudge is called out once, then fades back to the activity.
  useEffect(() => {
    if (props.nudge <= seenNudge.current) return
    const timer = setTimeout(() => {
      seenNudge.current = props.nudge
      setNow(Date.now())
    }, 4000)
    return () => clearTimeout(timer)
  }, [props.nudge])

  const run = (action: NoticeAction): void => {
    if (busy) return
    const { method, args } = actionCall(action, props)
    setBusy(action)
    void (call as (ns: string, m: string, ...a: unknown[]) => Promise<unknown>)('agent', method, ...args).finally(() => setBusy(null))
  }

  // ---- moving the notice ----
  // The anchor is the tab (default spot) or a point on it (a dragged spot); either way the tab's origin follows.
  const origin = (): { x: number; y: number } =>
    props.position && anchorRect ? { x: anchorRect.x - props.position.x, y: anchorRect.y - props.position.y } : (anchorRect ?? { x: viewport.x, y: viewport.y })
  const tabSize = (): { width: number; height: number } => {
    if (!props.position && anchorRect) return { width: anchorRect.width, height: anchorRect.height }
    const o = origin()
    return { width: viewport.x + viewport.width - o.x, height: viewport.y + viewport.height - o.y }
  }
  // Where the frame is in tab px, from the same rule the host places it by (top-centre, NOTICE_GAP below the anchor).
  const frameRect = (): { x: number; y: number; width: number; height: number } | null => {
    const el = card.current
    if (!el) return null
    const width = el.offsetWidth
    const height = el.offsetHeight
    const centre = props.position ? props.position.x : tabSize().width / 2
    const top = (props.position?.y ?? 0) + NOTICE_GAP
    return { x: centre - width / 2, y: top, width, height }
  }
  const commit = (delta: { x: number; y: number }): void => {
    const frame = frameRect()
    if (!frame) return
    void call('agent', 'moveNotice', props.tabId, movedPosition(frame, delta, tabSize()))
  }
  const onGripDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { px: e.screenX, py: e.screenY }
    setDrag({ x: 0, y: 0 })
  }
  const onGripMove = (e: PointerEvent<HTMLButtonElement>): void => {
    if (!start.current) return
    setDrag({ x: e.screenX - start.current.px, y: e.screenY - start.current.py })
  }
  const onGripUp = (e: PointerEvent<HTMLButtonElement>): void => {
    if (!start.current) return
    const delta = { x: e.screenX - start.current.px, y: e.screenY - start.current.py }
    start.current = null
    setDrag(null)
    if (Math.abs(delta.x) + Math.abs(delta.y) > 2) commit(delta)
  }
  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const step = e.shiftKey ? NOTICE_STEP * 4 : NOTICE_STEP
    const deltas: Record<string, { x: number; y: number }> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }
    if (e.key === 'Home') {
      e.preventDefault()
      void call('agent', 'moveNotice', props.tabId, null)
      return
    }
    const delta = deltas[e.key]
    if (!delta) return
    e.preventDefault()
    commit(delta)
  }

  const style = {
    ...accentVariables(props.companion.accent),
    ['--at-glow' as string]: props.companion.glow,
    ...(drag ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : {}),
  } as CSSProperties
  const ToneIcon = content.tone === 'solved' || content.tone === 'challenge' ? ShieldCheck : null
  const label = (action: Exclude<NoticeAction, 'beside'>): string => t(ACTION_LABEL[action])
  return (
    <div
      ref={card}
      className="at-notice"
      data-tone={content.tone}
      data-nudged={content.nudged || undefined}
      data-dragging={drag ? '' : undefined}
      data-exiting={exiting || undefined}
      data-reduced={reduced || undefined}
      style={style}
      role="region"
      aria-label={t('atWork.notice.label', { name: props.companion.name })}
      // Escape leaves the notice without dismissing it: it stays while the agent holds the tab.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        ;(document.activeElement as HTMLElement | null)?.blur()
      }}
    >
      <button
        type="button"
        className="at-notice__grip"
        aria-label={t('atWork.notice.drag')}
        title={t('atWork.notice.dragHint')}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={() => {
          start.current = null
          setDrag(null)
        }}
        onKeyDown={onGripKey}
      >
        <GripVertical aria-hidden="true" />
      </button>
      <span className="at-notice__mark" aria-hidden="true">
        {ToneIcon ? <ToneIcon /> : <i />}
      </span>
      <div className="at-notice__text" role="status" aria-live="polite">
        <span className="at-notice__title">{content.title}</span>
        {content.detail && <span className="at-notice__detail">{content.detail}</span>}
      </div>
      <div className="at-notice__actions">
        {content.primary && (
          <button type="button" className="at-notice__primary" onClick={() => run(content.primary as NoticeAction)} aria-busy={busy === content.primary || undefined} disabled={busy !== null}>
            {label(content.primary as Exclude<NoticeAction, 'beside'>)}
          </button>
        )}
        {content.actions.map((action) => {
          if (action === 'beside') {
            const text = props.beside ? t('atWork.notice.besideOff') : t('atWork.notice.besideOn')
            return (
              <button key={action} type="button" className="at-notice__icon" aria-pressed={props.beside} aria-label={text} title={text} onClick={() => run(action)} disabled={busy !== null}>
                {props.beside ? <PanelRightClose aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
              </button>
            )
          }
          if (action === 'open-chat') {
            return (
              <button key={action} type="button" className="at-notice__icon" aria-label={label(action)} title={label(action)} onClick={() => run(action)} disabled={busy !== null}>
                <MessageSquare aria-hidden="true" />
              </button>
            )
          }
          if (action === 'stop') {
            return (
              <button key={action} type="button" className="at-notice__icon at-notice__icon--stop" aria-label={label(action)} title={label(action)} onClick={() => run(action)} disabled={busy !== null}>
                <Square aria-hidden="true" />
              </button>
            )
          }
          return (
            <button key={action} type="button" className="at-notice__secondary" onClick={() => run(action)} disabled={busy !== null}>
              {label(action)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
