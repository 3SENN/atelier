/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Your details (Settings › You): your own name, email, phone and address. They are one address in the wallet, the one
// marked as yours (Passwords › Addresses shows the same entry, with a Yours badge): autofill offers it first, and your
// companion knows it for tasks you give it unless you turn that off. Nothing here keeps a copy of its own.

import { useState, type ReactElement } from 'react'
import { MapPin, Pencil, Plus } from 'lucide-react'
import type { SettingsView } from '@shared/ipc'
import { countryOptions, type AddressView } from '@shared/passwords'
import { atelier, call, errorText } from '../../api'
import { useEvent, useResource } from '../data'
import { useT } from '../../i18n/useT'
import '../../passwords/passwords.css'
import { AddressDialog } from '../../passwords/WalletDialogs'
import { Button, ErrorState, Select, SkeletonRows } from '../../ui'
import { Card, Section, SwitchRow } from '../kit'

export function YourDetailsSection({ settings, onSettings }: { settings: SettingsView; onSettings(view: SettingsView): void }): ReactElement {
  const t = useT()
  const addresses = useResource(() => call('wallet', 'addresses'))
  useEvent('wallet', () => void addresses.reload())
  const [editing, setEditing] = useState<AddressView | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = addresses.data ?? []
  const mine = list.find((a) => a.mine) ?? null
  const others = list.filter((a) => !a.mine)

  const pick = async (id: string): Promise<void> => {
    setError(null)
    try {
      await call('wallet', 'setMine', id || null)
      await addresses.reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const country = mine?.country ? (countryOptions().find((c) => c.value === mine.country)?.label ?? mine.country) : ''
  const place = mine ? [[mine.line1, mine.line2, mine.line3].filter(Boolean).join(', '), [mine.postalCode, mine.city].filter(Boolean).join(' '), mine.region, country].filter(Boolean).join(', ') : ''
  const name = mine ? [mine.givenName, mine.additionalName, mine.familyName].filter(Boolean).join(' ') || mine.organization : ''

  return (
    <Section title={t('settings.you.details')} note={t('settings.you.details.note')}>
      <Card>
        <div className="sp-row sp-row--stack" data-settings-anchor="you-details">
          {addresses.error ? (
            <ErrorState compact title={t('settings.you.details.error')} message={addresses.error} onRetry={() => void addresses.reload()} />
          ) : !addresses.data ? (
            <SkeletonRows rows={2} label={t('settings.you.details.loading')} />
          ) : mine ? (
            <div className="sp-item">
              <span className="sp-favicon" aria-hidden>
                <MapPin size={14} />
              </span>
              <button type="button" className="sp-item__main" onClick={() => setEditing(mine)}>
                <span className="sp-item__title">
                  <span className="sp-item__title-text">{name || mine.label}</span>
                </span>
                <span className="sp-item__sub sp-item__sub--wrap">{[mine.email, mine.tel, place].filter(Boolean).join(' · ') || t('settings.you.details.onlyName')}</span>
              </button>
              <div className="sp-item__actions">
                <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(mine)}>
                  {t('settings.you.details.edit')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="sp-row__text">
              <span className="sp-row__description">{t('settings.you.details.none')}</span>
              <div className="sp-row__control">
                <Button size="sm" icon={<Plus />} onClick={() => setEditing('new')}>
                  {t('settings.you.details.add')}
                </Button>
              </div>
            </div>
          )}
          {addresses.data && others.length > 0 && (
            <div className="sp-row__control">
              <Select
                aria-label={t('settings.you.details.pick')}
                value={mine?.id ?? ''}
                options={[{ value: '', label: mine ? t('settings.you.details.pickNone') : t('settings.you.details.pick') }, ...(mine ? [{ value: mine.id, label: mine.label }] : []), ...others.map((a) => ({ value: a.id, label: a.label }))]}
                onChange={(id) => void pick(id)}
              />
            </div>
          )}
          {error && (
            <p className="sp-field__error" role="alert">
              {error}
            </p>
          )}
        </div>
        <SwitchRow
          anchor="you-details-share"
          label={t('settings.you.details.share')}
          description={t('settings.you.details.share.description')}
          checked={settings.shareDetails}
          onChange={(shareDetails) => void atelier.settings.set({ shareDetails }).then(onSettings, (err: unknown) => setError(errorText(err)))}
        />
      </Card>
      <AddressDialog
        open={editing !== null}
        editing={editing === 'new' ? null : editing}
        mine
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          void addresses.reload()
        }}
      />
    </Section>
  )
}
