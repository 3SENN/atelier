/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The address and card editors (ST-43, ST-44). Main validates again and
// encrypts; a card's number never comes back to the chrome, so editing a
// saved card shows only its last four digits unless you replace it. There is
// no field for a security code anywhere.
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import {
  BRAND_KEY,
  EMPTY_ADDRESS,
  cardBrand,
  cardExpired,
  cardNumberValid,
  countryOptions,
  defaultCountry,
  expiryYears,
  groupCardNumber,
  type AddressInput,
  type AddressView,
  type CardView,
} from '@shared/passwords'
import { call, errorText } from '../api'
import { Field, TextInput } from '../settings/kit'
import { Button, Dialog, Select, Switch } from '../ui'
import { useT, type MessageKey } from '../i18n/useT'

const NAME_FIELDS: Array<{ key: keyof AddressInput; label: MessageKey; autoComplete: string }> = [
  { key: 'givenName', label: 'passwords.address.givenName', autoComplete: 'off' },
  { key: 'additionalName', label: 'passwords.address.additionalName', autoComplete: 'off' },
  { key: 'familyName', label: 'passwords.address.familyName', autoComplete: 'off' },
]

const STREET_FIELDS: Array<{ key: keyof AddressInput; label: MessageKey }> = [
  { key: 'line1', label: 'passwords.address.line1' },
  { key: 'line2', label: 'passwords.address.line2' },
  { key: 'line3', label: 'passwords.address.line3' },
]

const PLACE_FIELDS: Array<{ key: keyof AddressInput; label: MessageKey }> = [
  { key: 'city', label: 'passwords.address.city' },
  { key: 'region', label: 'passwords.address.region' },
  { key: 'postalCode', label: 'passwords.address.postalCode' },
]

/** `mine`: a new address starts as your own details (Settings › You); an edited one keeps what it is unless you change it. */
export function AddressDialog({ open, editing, mine = false, onClose, onSaved }: { open: boolean; editing: AddressView | null; mine?: boolean; onClose(): void; onSaved(view: AddressView): void }): ReactElement {
  const t = useT()
  const ids = useId()
  const [form, setForm] = useState<AddressInput>(EMPTY_ADDRESS)
  const [isMine, setMine] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const countries = useMemo(() => [{ value: '', label: t('passwords.address.noCountry') }, ...countryOptions()], [])

  useEffect(() => {
    if (!open) return
    if (editing) {
      const { id: _id, label: _label, updatedAt: _updatedAt, mine: wasMine, ...fields } = editing
      setForm(fields)
      setMine(wasMine)
    } else {
      setForm({ ...EMPTY_ADDRESS, country: defaultCountry() })
      setMine(mine)
    }
    setBusy(false)
    setError(null)
  }, [open, editing?.id])

  const set = (key: keyof AddressInput, value: string): void => setForm((f) => ({ ...f, [key]: value }))

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // `mine` goes along only when it says something: yours, or an edit that unmarks your own address.
      const mark = isMine ? { mine: true } : editing?.mine ? { mine: false } : {}
      onSaved(await call('wallet', 'saveAddress', { ...form, ...mark, ...(editing ? { id: editing.id } : {}) }))
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const input = (key: keyof AddressInput, label: MessageKey, extra: { type?: string; autoFocus?: boolean } = {}): ReactElement => (
    <Field key={key} label={t(label)} htmlFor={`${ids}-${key}`}>
      <TextInput id={`${ids}-${key}`} type={extra.type ?? 'text'} value={form[key]} autoComplete="off" data-autofocus={extra.autoFocus || undefined} onChange={(e) => set(key, e.target.value)} />
    </Field>
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      title={editing ? t('passwords.address.titleEdit') : t('passwords.address.titleAdd')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('passwords.edit.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('passwords.edit.save')}
          </Button>
        </>
      }
    >
      <form className="pw-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="pw-form__grid">{NAME_FIELDS.map((f, i) => input(f.key, f.label, { autoFocus: i === 0 }))}</div>
        {input('organization', 'passwords.address.organization')}
        {STREET_FIELDS.map((f) => input(f.key, f.label))}
        <div className="pw-form__grid">{PLACE_FIELDS.map((f) => input(f.key, f.label))}</div>
        <Field label={t('passwords.address.country')} htmlFor={`${ids}-country`}>
          <Select id={`${ids}-country`} fullWidth value={form.country} options={countries} onChange={(v) => set('country', v)} />
        </Field>
        <div className="pw-form__grid">
          {input('email', 'passwords.address.email', { type: 'email' })}
          {input('tel', 'passwords.address.tel', { type: 'tel' })}
        </div>
        <Switch label={t('passwords.address.mine')} description={t('passwords.address.mine.description')} checked={isMine} onChange={setMine} />
        {error && (
          <p className="pw-form__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

export function CardDialog({ open, editing, onClose, onSaved }: { open: boolean; editing: CardView | null; onClose(): void; onSaved(view: CardView): void }): ReactElement {
  const t = useT()
  const ids = useId()
  const now = new Date()
  const [number, setNumber] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [holder, setHolder] = useState('')
  const [expMonth, setExpMonth] = useState(now.getMonth() + 1)
  const [expYear, setExpYear] = useState(now.getFullYear())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNumber('')
    setReplacing(!editing)
    setHolder(editing?.holder ?? '')
    setExpMonth(editing?.expMonth ?? now.getMonth() + 1)
    setExpYear(editing?.expYear ?? now.getFullYear())
    setBusy(false)
    setError(null)
  }, [open, editing?.id])

  const typedBrand = number ? cardBrand(number) : (editing?.brand ?? 'unknown')
  const numberProblem = replacing && number.replace(/\D/g, '').length >= 12 && !cardNumberValid(number) ? t('passwords.card.invalidNumber') : null

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (busy) return
    if (replacing && !cardNumberValid(number)) return setError(t('passwords.card.invalidNumber'))
    if (cardExpired(expMonth, expYear)) return setError(t('passwords.card.expired'))
    setBusy(true)
    setError(null)
    try {
      onSaved(
        await call('wallet', 'saveCard', {
          ...(editing ? { id: editing.id } : {}),
          ...(replacing ? { number: number.replace(/\D/g, '') } : {}),
          holder,
          expMonth,
          expYear,
        }),
      )
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={editing ? t('passwords.card.titleEdit') : t('passwords.card.titleAdd')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('passwords.edit.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('passwords.edit.save')}
          </Button>
        </>
      }
    >
      <form className="pw-form" onSubmit={(e) => void submit(e)} noValidate>
        {replacing ? (
          <Field label={t('passwords.card.number')} htmlFor={`${ids}-number`} error={numberProblem} hint={number ? t(BRAND_KEY[typedBrand]) : undefined}>
            <TextInput
              id={`${ids}-number`}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={groupCardNumber(number)}
              invalid={Boolean(numberProblem)}
              data-autofocus
              onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 19))}
            />
          </Field>
        ) : (
          editing && (
            <Field label={t('passwords.card.numberSaved')}>
              <div className="pw-secret-field">
                <span className="pw-row__secret">
                  {t(BRAND_KEY[editing.brand])} · {t('passwords.card.numberSavedValue', { last4: editing.last4 })}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                  {t('passwords.card.replaceNumber')}
                </Button>
              </div>
            </Field>
          )
        )}
        <Field label={t('passwords.card.holder')} htmlFor={`${ids}-holder`}>
          <TextInput id={`${ids}-holder`} value={holder} autoComplete="off" data-autofocus={!replacing || undefined} onChange={(e) => setHolder(e.target.value)} />
        </Field>
        <div className="pw-form__grid" role="group" aria-label={t('passwords.card.expiry')}>
          <Field label={t('passwords.card.month')} htmlFor={`${ids}-month`}>
            <Select id={`${ids}-month`} fullWidth value={String(expMonth)} options={MONTHS.map((m) => ({ value: String(m), label: String(m).padStart(2, '0') }))} onChange={(v) => setExpMonth(Number(v))} />
          </Field>
          <Field label={t('passwords.card.year')} htmlFor={`${ids}-year`}>
            <Select id={`${ids}-year`} fullWidth value={String(expYear)} options={expiryYears(now, editing?.expYear).map((y) => ({ value: String(y), label: String(y) }))} onChange={(v) => setExpYear(Number(v))} />
          </Field>
        </div>
        <p className="pw-form__note">{t('passwords.card.noCvc')}</p>
        {error && (
          <p className="pw-form__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
