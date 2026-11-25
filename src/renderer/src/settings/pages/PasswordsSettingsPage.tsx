/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Passwords and autofill (ST-41 to ST-44, ON-04): on macOS Apple
// Passwords first (iCloud Keychain through Apple's extension), the password
// manager card with its count and imports, the three password autofill
// switches and the never-save list, then addresses and payment cards with
// their own switches, lists and editors. Rows carry ids so the settings index
// can highlight them (ST-05).
import { useState, type ReactElement } from 'react'
import { ArrowUpRight, CreditCard, MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { BRAND_KEY, cardExpired, formatExpiry, siteOfOrigin, type AddressView, type CardView } from '@shared/passwords'
import { call, errorText } from '../../api'
import { useEvent, useResource } from '../data'
import { Card, ListFrame, PageHeader, Row, Section, SwitchRow } from '../kit'
import { Badge, Button, EmptyState, ErrorState, IconButton, SkeletonRows, Switch, isMac, useConfirm, useToast } from '../../ui'
import { useT } from '../../i18n/useT'
import type { SettingsPageProps } from '../pageTypes'
import { ImportDialog, type ImportSource } from '../../passwords/ImportDialog'
import { AddressDialog, CardDialog } from '../../passwords/WalletDialogs'
import { ApplePasswordsSection, PasswordExtensionNote, useApplePasswords } from '../../passwords/ApplePasswords'
import '../../passwords/passwords.css'

export function PasswordsSettingsPage({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const autofill = settings.autofill
  const status = useResource(() => call('passwords', 'status'))
  const never = useResource(() => call('passwords', 'neverSaveList'))
  const addresses = useResource(() => call('wallet', 'addresses'))
  const cards = useResource(() => call('wallet', 'cards'))
  const apple = useApplePasswords()
  const [importing, setImporting] = useState<ImportSource | null>(null)
  const [address, setAddress] = useState<AddressView | 'new' | null>(null)
  const [card, setCard] = useState<CardView | 'new' | null>(null)

  useEvent('passwords', (e) => {
    if (status.data) status.set({ ...status.data, count: e.count, locked: e.locked })
    void never.reload()
  })
  // The wallet event carries no payload: reload both lists.
  useEvent('wallet', () => {
    void addresses.reload()
    void cards.reload()
  })

  /** Turning off a "confirm it's you" switch asks for Touch ID first, so someone at an unlocked Mac can't quietly drop it. */
  const setAuth = async (key: 'addressAuth' | 'cardAuth', on: boolean): Promise<void> => {
    if (!on) {
      try {
        if (!(await call('passwords', 'unlock'))) return
      } catch (err) {
        toast.show({ tone: 'error', message: errorText(err) })
        return
      }
    }
    await update({ autofill: { [key]: on } })
  }

  const allowAgain = async (origin: string): Promise<void> => {
    try {
      await call('passwords', 'allowAgain', origin)
      never.set((never.data ?? []).filter((o) => o !== origin))
      toast.show({ tone: 'success', message: t('passwords.settings.allowedAgain', { site: siteOfOrigin(origin) }) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const removeAddress = async (a: AddressView): Promise<void> => {
    if (!(await confirm({ title: t('passwords.address.delete.title'), message: t('passwords.address.delete.body', { label: a.label }), destructive: true }))) return
    try {
      await call('wallet', 'removeAddress', a.id)
      toast.show({ tone: 'success', message: t('passwords.address.deleted') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const removeCard = async (c: CardView): Promise<void> => {
    const brand = t(BRAND_KEY[c.brand])
    if (!(await confirm({ title: t('passwords.card.remove.title'), message: t('passwords.card.remove.body', { cardBrand: brand, last4: c.last4 }), confirmLabel: t('passwords.card.remove.confirm'), destructive: true }))) return
    try {
      await call('wallet', 'removeCard', c.id)
      toast.show({ tone: 'success', message: t('passwords.card.removed') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const count = status.data?.count ?? null
  const setYield = (yieldToPasswordExtension: boolean): void => void update({ autofill: { yieldToPasswordExtension } })
  return (
    <>
      <PageHeader title={t('passwords.settings.title')} description={t('passwords.settings.description')} />

      <ApplePasswordsSection apple={apple} yieldOn={autofill.yieldToPasswordExtension} onYield={setYield} />

      <Section title={t('passwords.settings.manager')}>
        <Card className="pw-card">
          <Row
            anchor="passwords-manager"
            title={t('passwords.settings.saved')}
            description={status.data && !status.data.available ? t('passwords.unavailable') : count === null ? '…' : t('passwords.count', { count })}
          >
            <Button variant="primary" iconEnd={<ArrowUpRight />} onClick={() => void call('pages', 'open', 'atelier://passwords')}>
              {t('passwords.settings.manage')}
            </Button>
          </Row>
          <Row anchor="passwords-import" title={t('passwords.settings.importCsv')} description={t('passwords.settings.importCsvBody')}>
            <Button onClick={() => setImporting('csv')}>{t('passwords.settings.importButton')}</Button>
          </Row>
          {isMac && (
            <Row anchor="passwords-import-system" title={t('passwords.settings.importSystem')} description={t('passwords.settings.importSystemBody')}>
              <Button onClick={() => setImporting('system')}>{t('passwords.settings.importButton')}</Button>
            </Row>
          )}
        </Card>
      </Section>

      <Section title={t('passwords.settings.autofill')}>
        <Card className="pw-card">
          <SwitchRow anchor="passwords-offer-logins" label={t('passwords.settings.offerLogins')} description={t('passwords.settings.offerLoginsBody')} checked={autofill.offerLogins} onChange={(offerLogins) => void update({ autofill: { offerLogins } })} />
          <SwitchRow anchor="passwords-offer-save" label={t('passwords.settings.offerSave')} description={t('passwords.settings.offerSaveBody')} checked={autofill.offerSave} onChange={(offerSave) => void update({ autofill: { offerSave } })} />
          <SwitchRow anchor="passwords-offer-generated" label={t('passwords.settings.offerGenerated')} description={t('passwords.settings.offerGeneratedBody')} checked={autofill.offerGenerated} onChange={(offerGenerated) => void update({ autofill: { offerGenerated } })} />
          <PasswordExtensionNote apple={apple} yieldOn={autofill.yieldToPasswordExtension} onYield={setYield} />
        </Card>
      </Section>

      <Section title={t('passwords.settings.never')}>
        <div data-settings-anchor="passwords-never">
          <ListFrame label={t('passwords.settings.never')}>
            {never.data === null ? (
              never.error ? <ErrorState compact message={never.error} onRetry={never.reload} /> : <SkeletonRows rows={2} label={t('passwords.settings.loadingWallet')} />
            ) : never.data.length === 0 ? (
              <EmptyState compact title={t('passwords.settings.neverEmpty')} />
            ) : (
              never.data.map((origin) => (
                <div key={origin} className="pw-never">
                  <span className="pw-never__site" title={origin}>
                    {siteOfOrigin(origin)}
                  </span>
                  <Button size="sm" onClick={() => void allowAgain(origin)}>
                    {t('passwords.settings.allowAgain')}
                  </Button>
                </div>
              ))
            )}
          </ListFrame>
        </div>
      </Section>

      <Section
        title={t('passwords.settings.addresses')}
        actions={
          <Button size="sm" icon={<Plus />} disabled={!autofill.addresses} onClick={() => setAddress('new')}>
            {t('passwords.settings.addAddress')}
          </Button>
        }
      >
        <Card className="pw-card">
          <SwitchRow anchor="passwords-addresses" label={t('passwords.settings.addressesSwitch')} description={t('passwords.settings.addressesSwitchBody')} checked={autofill.addresses} onChange={(on) => void update({ autofill: { addresses: on } })} />
          <Switch
            label={isMac ? t('passwords.settings.addressAuthTouchId') : t('passwords.settings.addressAuth')}
            checked={autofill.addressAuth}
            disabled={!autofill.addresses}
            onChange={(on) => void setAuth('addressAuth', on)}
          />
        </Card>
        <WalletList
          data={addresses.data}
          error={addresses.error}
          onRetry={addresses.reload}
          empty={<EmptyState compact icon={<MapPin />} title={t('passwords.empty.addresses')} description={t('passwords.empty.addressesBody')} action={<Button size="sm" icon={<Plus />} onClick={() => setAddress('new')}>{t('passwords.settings.addAddress')}</Button>} />}
        >
          {(addresses.data ?? []).map((a) => (
            <div key={a.id} className="sp-item">
              <span className="sp-favicon" aria-hidden>
                <MapPin size={14} />
              </span>
              <button type="button" className="sp-item__main" onClick={() => setAddress(a)}>
                <span className="sp-item__title">
                  <span className="sp-item__title-text">{a.label}</span>
                  {a.mine && <Badge tone="info">{t('passwords.address.yours')}</Badge>}
                </span>
                <span className="sp-item__sub">{[a.city, a.email, a.tel].filter(Boolean).join(' · ')}</span>
              </button>
              <div className="sp-item__actions">
                <IconButton size="sm" label={t('passwords.address.edit')} icon={<Pencil />} onClick={() => setAddress(a)} />
                <IconButton size="sm" label={t('passwords.address.remove')} icon={<Trash2 />} tone="danger" onClick={() => void removeAddress(a)} />
              </div>
            </div>
          ))}
        </WalletList>
      </Section>

      <Section
        title={t('passwords.settings.cards')}
        actions={
          <Button size="sm" icon={<Plus />} disabled={!autofill.cards} onClick={() => setCard('new')}>
            {t('passwords.settings.addCard')}
          </Button>
        }
        note={t('passwords.settings.agentNote')}
      >
        <Card className="pw-card">
          <SwitchRow anchor="passwords-cards" label={t('passwords.settings.cardsSwitch')} description={t('passwords.settings.cardsSwitchBody')} checked={autofill.cards} onChange={(on) => void update({ autofill: { cards: on } })} />
          <Switch label={isMac ? t('passwords.settings.cardAuthTouchId') : t('passwords.settings.cardAuth')} checked={autofill.cardAuth} disabled={!autofill.cards} onChange={(on) => void setAuth('cardAuth', on)} />
        </Card>
        <WalletList
          data={cards.data}
          error={cards.error}
          onRetry={cards.reload}
          empty={<EmptyState compact icon={<CreditCard />} title={t('passwords.empty.cards')} description={t('passwords.empty.cardsBody')} action={<Button size="sm" icon={<Plus />} onClick={() => setCard('new')}>{t('passwords.settings.addCard')}</Button>} />}
        >
          {(cards.data ?? []).map((c) => {
            const brand = t(BRAND_KEY[c.brand])
            const expired = cardExpired(c.expMonth, c.expYear)
            return (
              <div key={c.id} className="sp-item">
                <span className="pw-brand" aria-hidden>
                  {c.brand === 'unknown' ? <CreditCard size={14} /> : brand.slice(0, 4)}
                </span>
                <button type="button" className="sp-item__main" onClick={() => setCard(c)}>
                  <span className="sp-item__title">
                    <span className="sp-item__title-text">{t('passwords.card.row', { cardBrand: brand, last4: c.last4 })}</span>
                    {expired && <Badge tone="warning">{t('passwords.card.expiredBadge')}</Badge>}
                  </span>
                  <span className="sp-item__sub">{[c.holder, t('passwords.card.expires', { date: formatExpiry(c.expMonth, c.expYear) })].filter(Boolean).join(' · ')}</span>
                </button>
                <div className="sp-item__actions">
                  <IconButton size="sm" label={t('passwords.card.edit')} icon={<Pencil />} onClick={() => setCard(c)} />
                  <IconButton size="sm" label={t('passwords.card.removeLabel')} icon={<Trash2 />} tone="danger" onClick={() => void removeCard(c)} />
                </div>
              </div>
            )
          })}
        </WalletList>
      </Section>

      <ImportDialog
        open={importing !== null}
        source={importing ?? 'csv'}
        onClose={() => setImporting(null)}
        onImported={(r) => toast.show({ tone: 'success', message: t('passwords.import.imported', { count: r.added + r.updated }) })}
      />
      <AddressDialog
        open={address !== null}
        editing={address === 'new' ? null : address}
        onClose={() => setAddress(null)}
        onSaved={() => {
          setAddress(null)
          toast.show({ tone: 'success', message: t('passwords.address.saved') })
        }}
      />
      <CardDialog
        open={card !== null}
        editing={card === 'new' ? null : card}
        onClose={() => setCard(null)}
        onSaved={() => {
          setCard(null)
          toast.show({ tone: 'success', message: t('passwords.card.saved') })
        }}
      />
    </>
  )
}

/** A wallet list under its switches: skeleton, error with retry, empty state with Add, or rows. */
function WalletList<T>({ data, error, onRetry, empty, children }: { data: T[] | null; error: string | null; onRetry(): Promise<void>; empty: ReactElement; children: ReactElement[] }): ReactElement {
  const t = useT()
  return (
    <div className="sp-list pw-wallet-list">
      {data === null ? (
        error ? <ErrorState compact title={t('passwords.settings.walletError')} message={error} onRetry={onRetry} /> : <SkeletonRows rows={2} label={t('passwords.settings.loadingWallet')} />
      ) : data.length === 0 ? (
        empty
      ) : (
        children
      )}
    </div>
  )
}
