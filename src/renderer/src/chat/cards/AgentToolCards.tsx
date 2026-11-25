/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { AlertCircle, Blocks, CalendarClock, Check, ChevronDown, ExternalLink, FilePen, Lightbulb, MessageCircle, PanelRight, Play, Square, Wand2 } from 'lucide-react'
import type { RequestOutcome } from '@shared/agentTools'
import type { RoutineSchedule } from '@shared/routines'
import type { Routine as SavedRoutine } from '@shared/routines'
import type { Skill as SavedSkill } from '@shared/skills'
import { chatUrl, routineUrl, skillUrl } from '@shared/url'
import type { LogItem } from '../../agentLog'
import { AppPreviewCard } from '../../apps/AppPreviewCard'
import { call, errorText } from '../../api'
import { useT, type T } from '../../i18n/useT'
import { RoutineEditorSheet } from '../../routines/RoutineEditorSheet'
import { SaveAsSkillSheet } from '../../skills/SaveAsSkillSheet'
import { Button, IconButton, SkeletonRows, StatusDot, cx, toast } from '../../ui'
import { CompanionAvatar } from '../CompanionAvatar'
import { dockSubtask } from '../detailsStore'
import { useChatList, useCompanion, useRoutines } from '../hooks'
import { useChat } from '../store'
import { canContinue, delegationTone } from '../logic/details'
import { proposalSaveInput } from '../logic/requests'
import type { LogCardProps } from './registry'
import '../chatTools.css'

// The agent's inline cards in the reply (through registerLogCard): routine
// proposals and lists (SK-06), skill drafts, built apps, delegated sub-tasks
// (CH-32), files written to watched folders, and quiet records of the
// requests that docked in the tray.

type ItemOf<K extends LogItem['kind']> = Extract<LogItem, { kind: K }>

const fail = (err: unknown): void => {
  toast.show({ message: errorText(err), tone: 'error' })
}

function weekdays(days: readonly number[]): string {
  const format = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  // 4 Jan 1970 was a Sunday, so day n is that date plus n days.
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => format.format(new Date(Date.UTC(1970, 0, 4 + d, 12))))
    .join(', ')
}

/** A routine schedule in words ("Every day at 08:00", "Mon, Wed at 18:30", "Every 2 hours"). */
export function scheduleText(schedule: RoutineSchedule, t: T): string {
  switch (schedule.kind) {
    case 'daily':
      return schedule.days.length === 0 || schedule.days.length === 7 ? t('chatTools.schedule.daily', { time: schedule.time }) : t('chatTools.schedule.days', { days: weekdays(schedule.days), time: schedule.time })
    case 'interval':
      return schedule.minutes % 60 === 0 ? t('chatTools.schedule.hours', { hours: schedule.minutes / 60 }) : t('chatTools.schedule.minutes', { minutes: schedule.minutes })
    case 'once':
      return t('chatTools.schedule.once', { when: new Date(schedule.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })
    case 'cron':
      return t('chatTools.schedule.cron', { expr: schedule.expr })
  }
}

/** The quiet word for a settled request. */
export function outcomeText(outcome: RequestOutcome | null, t: T): string {
  return outcome === null ? t('chatTools.outcome.waiting') : t(`chatTools.outcome.${outcome}`)
}

async function settle(chatId: string, requestId: string, action: 'saved' | 'dismissed', savedId?: string): Promise<void> {
  await call('agent', 'respond', chatId, requestId, { kind: 'proposal', action, ...(savedId ? { savedId } : {}) })
}

// ---- SK-06: a routine proposal ----

export function RoutineProposalCard({ item, chatId }: LogCardProps<'routine-proposal'>): ReactElement {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'save' | 'dismiss' | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const settled = item.outcome !== null || savedId !== null

  const saved = async (routine: { id: string } | null): Promise<void> => {
    if (!routine) return
    setSavedId(routine.id)
    await settle(chatId, item.id, 'saved', routine.id).catch(fail)
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    try {
      // A proposal carries no `enabled`; pressing Save is saying yes to it, so it runs.
      const routine = (await call('routines', 'save', proposalSaveInput(item.draft))) as unknown as SavedRoutine
      await saved(routine)
      toast.show({ message: t('chatTools.proposal.saved'), tone: 'success', action: { label: t('chatTools.proposal.open'), onAction: () => void call('pages', 'open', routineUrl(routine.id)).catch(fail) } })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async (): Promise<void> => {
    setBusy('dismiss')
    await settle(chatId, item.id, 'dismissed').catch(fail)
    setBusy(null)
  }

  return (
    <div className={cx('cd-card', settled && 'cd-card--settled')} role="group" aria-label={t('chatTools.proposal.label')}>
      <div className="cd-card__head">
        <CalendarClock size={15} aria-hidden="true" className="cd-card__icon" />
        <span className="cd-card__eyebrow">{t('chatTools.proposal.label')}</span>
      </div>
      <p className="cd-card__title">{item.draft.name}</p>
      <p className="cd-card__meta">{scheduleText(item.draft.schedule, t)}</p>
      <p className="cd-card__body cd-card__body--clamp">{item.draft.prompt}</p>
      {settled ? (
        <p className="cd-card__state">
          {item.outcome === 'dismissed' ? t('chatTools.proposal.dismissed') : (
            <>
              <Check size={13} aria-hidden="true" /> {t('chatTools.proposal.saved')}
              {savedId && <Button size="sm" variant="ghost" onClick={() => void call('pages', 'open', routineUrl(savedId)).catch(fail)}>{t('chatTools.proposal.open')}</Button>}
            </>
          )}
        </p>
      ) : (
        <div className="cd-card__actions">
          <Button size="sm" variant="ghost" loading={busy === 'dismiss'} disabled={busy !== null} onClick={() => void dismiss()}>{t('chatTools.proposal.dismiss')}</Button>
          <Button size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>{t('chatTools.proposal.edit')}</Button>
          <Button size="sm" variant="primary" className="chat-co-button" loading={busy === 'save'} disabled={busy !== null} onClick={() => void save()}>{t('chatTools.proposal.save')}</Button>
        </div>
      )}
      {editing && (
        <RoutineEditorSheet
          draft={item.draft}
          onClose={(routine) => {
            setEditing(false)
            void saved(routine)
          }}
        />
      )}
    </div>
  )
}

// ---- SK-06: the agent lists routines as cards ----

export function RoutineListCard({ item }: LogCardProps<'routine-list'>): ReactElement {
  const t = useT()
  const routines = useRoutines()
  return (
    <div className="cd-card" role="group" aria-label={t('chatTools.routines.title')}>
      <div className="cd-card__head">
        <CalendarClock size={15} aria-hidden="true" className="cd-card__icon" />
        <span className="cd-card__eyebrow">{t('chatTools.routines.title')}</span>
        <span className="cd-card__spacer" />
        <Button size="sm" variant="ghost" onClick={() => void call('pages', 'open', 'atelier://routines').catch(fail)}>{t('chatTools.routines.all')}</Button>
      </div>
      {routines === null ? (
        <SkeletonRows rows={Math.min(3, item.routineIds.length || 1)} label={t('chatTools.routines.loading')} />
      ) : (
        <ul className="cd-rows">
          {item.routineIds.map((id) => {
            const routine = routines.find((r) => r.id === id)
            return (
              <li key={id}>
                <button type="button" className="cd-row" disabled={!routine} onClick={() => void call('pages', 'open', routineUrl(id)).catch(fail)}>
                  <span className="cd-row__label">{routine?.name ?? t('chatTools.routines.gone')}</span>
                  {routine && <span className="cd-row__meta">{routine.enabled ? scheduleText(routine.schedule as RoutineSchedule, t) : t('chatTools.routines.paused')}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ---- SK-06: a drafted skill ----

export function SkillDraftCard({ item, chatId }: LogCardProps<'skill-draft'>): ReactElement {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'save' | 'dismiss' | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const settled = item.outcome !== null || savedId !== null

  const saved = async (skill: { id: string } | null): Promise<void> => {
    if (!skill) return
    setSavedId(skill.id)
    await settle(chatId, item.id, 'saved', skill.id).catch(fail)
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    try {
      // A draft of a skill the companion already has changes that skill; steps go along either way.
      const { name, description, instructions, steps, owner, updates } = item.draft
      const skill = (await call('skills', 'save', { ...(updates ? { id: updates } : {}), name, description, instructions, ...(steps ? { steps } : {}), ...(owner ? { owner } : {}) })) as unknown as SavedSkill
      await saved(skill)
      toast.show({ message: t(item.draft.updates ? 'chatTools.skillDraft.updated' : 'chatTools.skillDraft.saved'), tone: 'success', action: { label: t('chatTools.skillDraft.open'), onAction: () => void call('pages', 'open', skillUrl(skill.id)).catch(fail) } })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={cx('cd-card', settled && 'cd-card--settled')} role="group" aria-label={t('chatTools.skillDraft.label')}>
      <div className="cd-card__head">
        <Wand2 size={15} aria-hidden="true" className="cd-card__icon" />
        <span className="cd-card__eyebrow">{t(item.draft.updates ? 'chatTools.skillDraft.updateLabel' : 'chatTools.skillDraft.label')}</span>
      </div>
      <p className="cd-card__title">/{item.draft.name}</p>
      {item.draft.description && <p className="cd-card__meta">{item.draft.description}</p>}
      <p className="cd-card__body cd-card__body--clamp">{item.draft.instructions}</p>
      {settled ? (
        <p className="cd-card__state">
          {item.outcome === 'dismissed' ? t('chatTools.skillDraft.dismissed') : (
            <>
              <Check size={13} aria-hidden="true" /> {t(item.draft.updates ? 'chatTools.skillDraft.updated' : 'chatTools.skillDraft.saved')}
              {savedId && <Button size="sm" variant="ghost" onClick={() => void call('pages', 'open', skillUrl(savedId)).catch(fail)}>{t('chatTools.skillDraft.open')}</Button>}
            </>
          )}
        </p>
      ) : (
        <div className="cd-card__actions">
          <Button size="sm" variant="ghost" loading={busy === 'dismiss'} disabled={busy !== null} onClick={() => { setBusy('dismiss'); void settle(chatId, item.id, 'dismissed').catch(fail).finally(() => setBusy(null)) }}>{t('chatTools.skillDraft.dismiss')}</Button>
          <Button size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>{t('chatTools.skillDraft.edit')}</Button>
          <Button size="sm" variant="primary" className="chat-co-button" loading={busy === 'save'} disabled={busy !== null} onClick={() => void save()}>{t(item.draft.updates ? 'chatTools.skillDraft.saveChanges' : 'chatTools.skillDraft.save')}</Button>
        </div>
      )}
      {editing && (
        <SaveAsSkillSheet
          chatId={chatId}
          draft={item.draft}
          onClose={(skill) => {
            setEditing(false)
            void saved(skill)
          }}
        />
      )}
    </div>
  )
}

// ---- the preview of a built app ----

export function AppBuiltCard({ item, chatId }: LogCardProps<'app-built'>): ReactElement {
  const t = useT()
  return (
    <div className="cd-card cd-card--app" role="group" aria-label={`${t('chatTools.app.label')}: ${item.name}`}>
      <div className="cd-card__head">
        <Blocks size={15} aria-hidden="true" className="cd-card__icon" />
        <span className="cd-card__eyebrow">{t('chatTools.app.label')}</span>
        <span className="cd-card__title cd-card__title--inline">{item.name}</span>
      </div>
      <AppPreviewCard appId={item.appId} versionId={item.versionId} chatId={chatId} requestId={item.id} />
    </div>
  )
}

// ---- CH-32: a delegated sub-task ----

export function DelegationCard({ item, chatId }: LogCardProps<'delegation'>): ReactElement {
  const t = useT()
  const tone = delegationTone(item.status)
  // DS-55: a muted caption, a hairline, the companions' faces with a status mark beside them, the label, then a closing hairline.
  const parent = useChat(chatId)
  const chats = useChatList()
  const parentId = parent.setup?.companionId ?? parent.summary?.companionId ?? null
  const childId = chats?.find((c) => c.id === item.childChatId)?.companionId ?? parentId
  const lead = useCompanion(parentId)
  const helper = useCompanion(childId)
  const faces = childId && childId !== parentId ? [lead, helper] : [helper]
  const mark = delegationMark(item.status)
  const status = t(`chatTools.delegation.status.${item.status}`)
  return (
    <section className={cx('cd-subtask', `cd-subtask--${tone}`)} role="group" aria-label={`${t('chatTools.delegation.label')}: ${item.title}, ${status}`}>
      <p className="cd-subtask__caption">{t('chatTools.delegation.label')}</p>
      <div className="cd-subtask__row">
        <span className="cd-subtask__faces" aria-hidden="true">
          {faces.map((companion, i) => (
            <CompanionAvatar key={companion?.id ?? i} companion={companion} size={26} label="" mark={null} className="cd-subtask__face" />
          ))}
          <span className={cx('cd-subtask__mark', `cd-subtask__mark--${tone}`)}>{mark}</span>
        </span>
        <span className="cd-subtask__label">{item.title}</span>
        <span className="cd-subtask__status">{status}</span>
        <span className="cd-subtask__actions">
          {canContinue(item.status) && (
            <Button size="sm" variant="ghost" icon={<Play size={13} />} onClick={() => void call('chats', 'continue', item.childChatId).catch(fail)}>{t('chatTools.delegation.continue')}</Button>
          )}
          <IconButton size="sm" label={t('chatTools.delegation.dock')} icon={<PanelRight />} onClick={() => dockSubtask(chatId, item.childChatId)} />
          <IconButton size="sm" label={t('chatTools.delegation.open')} icon={<ExternalLink />} onClick={() => void call('pages', 'open', chatUrl(item.childChatId)).catch(fail)} />
        </span>
      </div>
    </section>
  )
}

/** The status mark beside a sub-task's faces: a check when done. */
function delegationMark(status: Extract<LogItem, { kind: 'delegation' }>['status']): ReactElement {
  switch (status) {
    case 'done':
      return <Check size={11} strokeWidth={3} />
    case 'working':
      return <span className="cd-subtask__dot" />
    case 'needs-input':
      return <MessageCircle size={10} strokeWidth={3} />
    case 'needs-attention':
      return <AlertCircle size={11} strokeWidth={2.5} />
    default:
      return <Square size={8} strokeWidth={3} />
  }
}

// ---- browser steps (atelier-step, docs/decisions.md › Browser tasks) ----

/** Steps shown before "Show all": the latest ones. */
const STEPS_SHOWN = 3

export function BrowserStepsCard({ item }: LogCardProps<'browser-steps'>): ReactElement {
  const t = useT()
  const [all, setAll] = useState(false)
  const tone = item.status === 'done' ? 'success' : item.status === 'failed' || item.status === 'blocked' ? 'error' : item.status === 'handed-back' ? 'needs-input' : 'neutral'
  const status = t(`chatTools.browserSteps.status.${item.status}`)
  const shown = all ? item.steps : item.steps.slice(-STEPS_SHOWN)
  return (
    <section className={cx('cd-subtask', 'cd-steps', `cd-subtask--${tone}`)} role="group" aria-label={`${t('chatTools.browserSteps.label')}: ${item.goal}, ${status}`}>
      <p className="cd-subtask__caption">{t('chatTools.browserSteps.label')}</p>
      <div className="cd-subtask__row">
        <span className={cx('cd-subtask__mark', `cd-subtask__mark--${tone}`)} aria-hidden="true">
          {item.status === 'running' ? <span className="cd-subtask__dot" /> : item.status === 'done' ? <Check size={11} strokeWidth={3} /> : item.status === 'handed-back' ? <MessageCircle size={10} strokeWidth={3} /> : item.status === 'stopped' ? <Square size={8} strokeWidth={3} /> : <AlertCircle size={11} strokeWidth={2.5} />}
        </span>
        <span className="cd-subtask__label">{item.goal}</span>
        <span className="cd-subtask__status">{t('chatTools.browserSteps.count', { status, count: item.steps.length })}</span>
      </div>
      {shown.length > 0 && (
        <ol className="cd-steps__list" start={item.steps.length - shown.length + 1}>
          {shown.map((step, i) => (
            <li key={item.steps.length - shown.length + i}>{step.text}</li>
          ))}
        </ol>
      )}
      {item.steps.length > STEPS_SHOWN && (
        <button type="button" className="cd-steps__more" aria-expanded={all} onClick={() => setAll(!all)}>
          <ChevronDown size={12} aria-hidden="true" className={cx(all && 'cd-steps__more--open')} />
          {all ? t('chatTools.browserSteps.fewer') : t('chatTools.browserSteps.all', { count: item.steps.length })}
        </button>
      )}
      {item.note && <p className="cd-steps__note">{item.note}</p>}
    </section>
  )
}

// ---- files written to watched folders ----

export function FileWrittenCard({ item }: LogCardProps<'file-written'>): ReactElement {
  const t = useT()
  const where = item.ref.kind === 'folder' ? item.ref.path : null
  return (
    <p className="cd-record">
      <FilePen size={13} aria-hidden="true" />
      <span>{t('chatTools.file.written', { name: item.name })}</span>
      {where && <span className="cd-record__muted">{where}</span>}
    </p>
  )
}

// ---- quiet records of tray requests ----

export function QuestionRecord({ item }: LogCardProps<'question'>): ReactElement {
  const t = useT()
  return (
    <p className={cx('cd-record', item.outcome === null && 'cd-record--pending')}>
      {item.outcome === null ? <StatusDot status="needs-input" label="" size={6} pulse={false} /> : <Lightbulb size={13} aria-hidden="true" />}
      <span>{t('chatTools.record.question', { count: item.questions.length })}</span>
      <span className="cd-record__muted">{outcomeText(item.outcome, t)}</span>
    </p>
  )
}

export function SiteAccessRecord({ item }: LogCardProps<'site-access'>): ReactElement {
  const t = useT()
  return (
    <p className={cx('cd-record', item.outcome === null && 'cd-record--pending')}>
      {item.outcome === null && <StatusDot status="needs-input" label="" size={6} pulse={false} />}
      <span>{t('chatTools.record.site', { origin: item.origin.replace(/^https?:\/\//, '') })}</span>
      <span className="cd-record__muted">{outcomeText(item.outcome, t)}</span>
    </p>
  )
}

export function TableWriteRecord({ item }: LogCardProps<'table-write'>): ReactElement {
  const t = useT()
  return (
    <p className={cx('cd-record', item.outcome === null && 'cd-record--pending')}>
      {item.outcome === null && <StatusDot status="needs-input" label="" size={6} pulse={false} />}
      <span>{t('chatTools.record.table', { table: item.table })}</span>
      <span className="cd-record__muted">{outcomeText(item.outcome, t)}</span>
    </p>
  )
}

export function AutoApprovalRecord({ item }: LogCardProps<'auto-approval'>): ReactElement {
  const t = useT()
  return (
    <p className={cx('cd-record', item.outcome === null && 'cd-record--pending')}>
      <span>{t('chatTools.record.auto', { description: item.description })}</span>
      <span className="cd-record__muted">{outcomeText(item.outcome, t)}</span>
    </p>
  )
}

/** Plans and sources live in the details panel; the log draws nothing for them. */
export function Nothing(): null {
  return null
}
