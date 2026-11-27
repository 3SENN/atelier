/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › General (ST-22's rows for window behaviour, the network
// section, the background and haptics rows).
import type { ReactElement } from 'react'
import { useT } from '../../i18n/useT'
import { Select } from '../../ui'
import { BackgroundSettings } from '../../system/BackgroundSettings'
import { HapticsRow } from '../../native/HapticsRow'
import { NetworkSection } from '../sections/network/NetworkSection'
import { Card, PageHeader, Row, Section, SwitchRow } from '../kit'
import type { SettingsPageProps } from '../pageTypes'

// null is never; minutes otherwise.
const SLEEP_CHOICES = ['never', '15', '30', '60', '120', '240', '480'] as const
type SleepChoice = (typeof SLEEP_CHOICES)[number]

function sleepChoice(minutes: number | null): SleepChoice {
  if (minutes === null) return 'never'
  const found = SLEEP_CHOICES.find((c) => c === String(minutes))
  return found ?? '120'
}

export function GeneralPage({ settings, update, tabId }: SettingsPageProps): ReactElement {
  const t = useT()
  const sleepLabel = (c: SleepChoice): string => {
    if (c === 'never') return t('settings.general.tabSleep.never')
    const minutes = Number(c)
    return minutes >= 60 ? t('settings.general.tabSleep.hours', { count: minutes / 60 }) : t('settings.general.tabSleep.minutes', { count: minutes })
  }
  return (
    <>
      <PageHeader title={t('settings.general.title')} description={t('settings.general.description')} />
      <Section title={t('settings.general.closing')}>
        <Card>
          <SwitchRow
            anchor="warn-before-quit"
            label={t('settings.general.warnBeforeQuit')}
            description={t('settings.general.warnBeforeQuit.description')}
            checked={settings.warnBeforeQuit}
            onChange={(warnBeforeQuit) => void update({ warnBeforeQuit })}
          />
          <SwitchRow
            anchor="confirm-close-tabs"
            label={t('settings.general.confirmCloseTabs')}
            description={t('settings.general.confirmCloseTabs.description')}
            checked={settings.confirmCloseTabs}
            onChange={(confirmCloseTabs) => void update({ confirmCloseTabs })}
          />
        </Card>
      </Section>
      <Section title={t('settings.general.working')}>
        <Card>
          <SwitchRow
            anchor="keep-awake"
            label={t('settings.general.keepAwake')}
            description={t('settings.general.keepAwake.description')}
            checked={settings.keepAwake}
            onChange={(keepAwake) => void update({ keepAwake })}
          />
        </Card>
      </Section>
      <Section title={t('settings.general.tabs')}>
        <Card>
          <Row anchor="tab-sleep" title={t('settings.general.tabSleep')} description={t('settings.general.tabSleep.description')} htmlFor="settings-tab-sleep">
            <Select
              id="settings-tab-sleep"
              size="sm"
              value={sleepChoice(settings.tabSleepMinutes)}
              options={SLEEP_CHOICES.map((c) => ({ value: c, label: sleepLabel(c) }))}
              onChange={(c) => void update({ tabSleepMinutes: c === 'never' ? null : Number(c) })}
            />
          </Row>
          <SwitchRow
            anchor="memory-saver"
            label={t('settings.general.memorySaver')}
            description={t('settings.general.memorySaver.description')}
            checked={settings.memorySaver}
            onChange={(memorySaver) => void update({ memorySaver })}
          />
          <SwitchRow
            anchor="energy-saver"
            label={t('settings.general.energySaver')}
            description={t('settings.general.energySaver.description')}
            checked={settings.energySaver}
            onChange={(energySaver) => void update({ energySaver })}
          />
        </Card>
      </Section>
      <NetworkSection settings={settings} update={update} tabId={tabId} />
      {/* The startup and background rows, then the haptics row (macOS only). */}
      <BackgroundSettings settings={settings} update={update} />
      <HapticsRow settings={settings} update={update} />
    </>
  )
}
