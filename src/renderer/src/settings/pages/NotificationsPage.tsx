/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Notifications (ST-34): the master switch, the categories,
// sounds (off by default), a test, the sites allowed or blocked from
// notifying (the site permissions store) and a hint when the system may be holding them back.
import type { ReactElement, ReactNode } from 'react'
import { Bell, BellOff, CalendarClock, Download, KeyRound, MessageSquareText, Package, Repeat, ShieldQuestion, X } from 'lucide-react'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABELS, type NotificationCategory } from '@shared/notifications'
import type { SiteSettingsEntry } from '@shared/sites'
import { call } from '../../api'
import { useT, type MessageKey } from '../../i18n/useT'
import { AsyncButton, Badge, Button, EmptyState, ErrorState, IconButton, SkeletonRows, Switch, useAsyncAction, useToast } from '../../ui'
import { useResource } from '../data'
import { Card, ListFrame, Notice, PageHeader, Section, SwitchRow } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import { SoundsCard } from '../notifications/SoundsCard' // NS-03
import { PermissionsLink } from '../permissions/PermissionsLink'

const CATEGORY_ICONS: Record<NotificationCategory, ReactNode> = {
  'needs-you': <ShieldQuestion />,
  'chat-updates': <MessageSquareText />,
  'routine-results': <Repeat />,
  meetings: <CalendarClock />,
  downloads: <Download />,
  passwords: <KeyRound />,
  packs: <Package />,
}

const CATEGORY_DESCRIPTIONS: Record<NotificationCategory, MessageKey> = {
  'needs-you': 'settings.notifications.category.needsYou.description',
  'chat-updates': 'settings.notifications.category.chatUpdates.description',
  'routine-results': 'settings.notifications.category.routineResults.description',
  meetings: 'settings.notifications.category.meetings.description',
  downloads: 'settings.notifications.category.downloads.description',
  passwords: 'settings.notifications.category.passwords.description',
  packs: 'settings.notifications.category.packs.description',
}

/** Sites with a notification decision, allowed first then by name. */
export function notificationSites(entries: readonly SiteSettingsEntry[]): Array<{ origin: string; decision: 'allow' | 'block' }> {
  const out: Array<{ origin: string; decision: 'allow' | 'block' }> = []
  for (const e of entries) {
    const decision = e.settings.permissions.notifications
    if (decision === 'allow' || decision === 'block') out.push({ origin: e.origin, decision })
  }
  return out.sort((a, b) => (a.decision === b.decision ? a.origin.localeCompare(b.origin) : a.decision === 'allow' ? -1 : 1))
}

function siteName(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

export function NotificationsPage({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const n = settings.notifications
  const system = useResource(() => call('notificationAccess', 'status'))
  const sites = useResource(async () => notificationSites(await call('sites', 'list')))
  const remove = useAsyncAction(async (origin: string) => {
    await call('sites', 'set', origin, { permissions: { ...(await call('sites', 'get', origin)).permissions, notifications: 'ask' } })
    sites.set((sites.data ?? []).filter((s) => s.origin !== origin))
    toast.show({ tone: 'success', message: t('settings.notifications.sites.removed', { site: siteName(origin) }) })
  }, { toastErrors: true })

  const setCategory = (category: NotificationCategory, on: boolean): Promise<void> => update({ notifications: { ...n, categories: { ...n.categories, [category]: on } } })

  return (
    <>
      <PageHeader title={t('settings.notifications.title')} description={t('settings.notifications.description')} />
      {system.data !== 'allowed' && system.data !== null && (
        <Notice
          tone={system.data === 'denied' ? 'warning' : 'info'}
          action={
            <Button size="sm" onClick={() => void call('notificationAccess', 'openSystemSettings')}>
              {t('settings.notifications.openSystem')}
            </Button>
          }
        >
          {t('settings.notifications.systemOff')}
        </Notice>
      )}
      <Section>
        <Card>
          <SwitchRow anchor="notifications" label={t('settings.notifications.enabled')} description={t('settings.notifications.enabled.description')} checked={n.enabled} onChange={(enabled) => void update({ notifications: { ...n, enabled } })} />
        </Card>
      </Section>
      {n.enabled && (
        <Section title={t('settings.notifications.categories')}>
          <Card>
            {NOTIFICATION_CATEGORIES.map((category) => (
              <div key={category} className="sp-switch-anchor sp-switch-anchor--icon" data-settings-anchor={`notify-${category}`}>
                <span className="sp-row__icon" aria-hidden>
                  {CATEGORY_ICONS[category]}
                </span>
                {/* The icon's row is the anchor already: the switch fills the rest of it. */}
                <Switch
                  label={t(NOTIFICATION_CATEGORY_LABELS[category])}
                  description={t(CATEGORY_DESCRIPTIONS[category])}
                  checked={n.categories[category]}
                  onChange={(on) => void setCategory(category, on)}
                />
              </div>
            ))}
          </Card>
        </Section>
      )}
      <Section>
        <Card>
          <SwitchRow anchor="notification-sounds" label={t('settings.notifications.sounds')} description={t('settings.notifications.sounds.description')} checked={n.sounds} disabled={!n.enabled} onChange={(sounds) => void update({ notifications: { ...n, sounds } })} />
          <div className="sp-row sp-row--end">
            <AsyncButton size="sm" icon={<Bell />} disabled={!n.enabled} success={t('settings.notifications.test.sent')} onClick={() => call('notificationAccess', 'test')}>
              {t('settings.notifications.test')}
            </AsyncButton>
          </div>
        </Card>
        {/* Sounds (NS-03) */}
        <SoundsCard settings={settings} update={update} />
      </Section>
      <Section title={t('settings.notifications.sites')} note={t('settings.notifications.sites.note')} actions={<PermissionsLink highlight="site-notifications" />}>
        <ListFrame label={t('settings.notifications.sites')}>
          {sites.data === null ? (
            sites.error ? (
              <ErrorState compact title={t('settings.loadFailed')} message={sites.error} onRetry={sites.reload} />
            ) : (
              <SkeletonRows rows={2} label={t('settings.kit.loading')} />
            )
          ) : sites.data.length === 0 ? (
            <EmptyState compact icon={<BellOff />} title={t('settings.notifications.sites.empty')} description={t('settings.notifications.sites.empty.description')} />
          ) : (
            sites.data.map((site) => (
              <div key={site.origin} className="sp-item">
                <div className="sp-item__main">
                  <span className="sp-item__title">{siteName(site.origin)}</span>
                </div>
                <Badge tone={site.decision === 'allow' ? 'success' : 'neutral'}>{site.decision === 'allow' ? t('settings.notifications.sites.allowed') : t('settings.notifications.sites.blocked')}</Badge>
                <div className="sp-item__actions">
                  <IconButton size="sm" label={t('settings.notifications.sites.remove', { site: siteName(site.origin) })} icon={<X />} disabled={remove.busy} onClick={() => void remove.run(site.origin)} />
                </div>
              </div>
            ))
          )}
        </ListFrame>
      </Section>
    </>
  )
}
