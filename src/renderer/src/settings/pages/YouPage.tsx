/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › You: your local name, an optional picture, and the key status.
// Nothing here leaves this computer; there is no account.
import { BRAND_NAME } from '@shared/branding'
import { useRef, useState, type ReactElement } from 'react'
import { ImageUp } from 'lucide-react'
import type { SettingsView } from '@shared/ipc'
import { atelier, errorText } from '../../api'
import { Button, SaveStatus, useAutosave } from '../../ui'
import { ApiKeyCard } from '../ApiKeyCard'
import { AboutYouSection } from '../sections/AboutYou'
import { YourDetailsSection } from '../sections/YourDetails'
import { Avatar, Card, PageHeader, Row, Section, TextInput } from '../kit'
import { AVATAR_PIXELS, avatarFileError, isAvatarDataUrl, squareCrop } from '../logic/avatar'
import { useT } from '../../i18n/useT'

const NAME_MAX = 40

/** Decodes a picture, crops the centre square and re-encodes it small enough to save. */
async function pictureToAvatar(file: Blob): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`${BRAND_NAME} couldn’t read that picture. Try another file.`)
  }
  const { sx, sy, size } = squareCrop(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_PIXELS
  canvas.height = AVATAR_PIXELS
  const context = canvas.getContext('2d')
  if (!context || size === 0) throw new Error(`${BRAND_NAME} couldn’t read that picture. Try another file.`)
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, sx, sy, size, size, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS)
  bitmap.close()
  for (const quality of [0.9, 0.8, 0.65, 0.5]) {
    const url = canvas.toDataURL('image/webp', quality)
    if (isAvatarDataUrl(url)) return url
  }
  throw new Error('That picture is too detailed to save. Try a simpler one.')
}

export function YouPage({ settings, onSettings, onOpenPage }: { settings: SettingsView; onSettings(view: SettingsView): void; onOpenPage(id: 'model'): void }): ReactElement {
  const t = useT()
  const [name, setName] = useState(settings.userName)
  const autosave = useAutosave(name.trim(), async (value) => onSettings(await atelier.settings.set({ userName: value })))
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [pictureBusy, setPictureBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const choose = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const problem = avatarFileError(file)
    setPictureError(problem)
    if (problem) return
    setPictureBusy(true)
    try {
      onSettings(await atelier.settings.set({ userAvatar: await pictureToAvatar(file) }))
    } catch (err) {
      setPictureError(errorText(err))
    } finally {
      setPictureBusy(false)
    }
  }
  const removePicture = async (): Promise<void> => {
    setPictureError(null)
    try {
      onSettings(await atelier.settings.set({ userAvatar: null }))
    } catch (err) {
      setPictureError(errorText(err))
    }
  }

  return (
    <>
      <PageHeader title={t('settings.you.you')} description={t('settings.you.howAtelierRefersTo')} />
      <Section title={t('settings.you.profile')}>
        <Card>
          <Row title={t('settings.you.name')} description={t('settings.you.yourCompanionsCallYou')} htmlFor="you-name">
            <TextInput
              id="you-name"
              className="sp-input--inline"
              value={name}
              maxLength={NAME_MAX}
              placeholder={t('settings.you.yourName')}
              autoComplete="given-name"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void autosave.flush()}
            />
            <SaveStatus state={autosave.state} onRetry={autosave.retry} />
          </Row>
          <div
            className="sp-row"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) e.preventDefault()
            }}
            onDrop={(e) => {
              e.preventDefault()
              void choose(e.dataTransfer.files[0])
            }}
          >
            <Avatar src={settings.userAvatar} name={name || settings.userName} size={52} />
            <div className="sp-row__text">
              <span className="sp-row__title">{t('settings.you.picture')}</span>
              {pictureError ? (
                <span className="sp-field__error" role="alert">
                  {pictureError}
                </span>
              ) : (
                <span className="sp-row__description">{t('settings.you.optionalASquareCrop')}</span>
              )}
            </div>
            <div className="sp-row__control">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
                hidden
                onChange={(e) => {
                  void choose(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              <Button size="sm" icon={<ImageUp />} loading={pictureBusy} onClick={() => fileInput.current?.click()}>
                {settings.userAvatar ? t('settings.you.change') : t('settings.you.choose')}
              </Button>
              {settings.userAvatar && (
                <Button size="sm" variant="ghost" disabled={pictureBusy} onClick={() => void removePicture()}>
                  {t('settings.you.remove')}
                </Button>
              )}
            </div>
          </div>
        </Card>
      </Section>
      <YourDetailsSection settings={settings} onSettings={onSettings} />
      <AboutYouSection userName={settings.userName} avatar={settings.userAvatar} />
      <Section title={t('settings.you.anthropicKey')} note={t('settings.you.chatsUseYourOwn')}>
        <ApiKeyCard settings={settings} onSettings={onSettings} variant="summary" onManage={() => onOpenPage('model')} />
      </Section>
      <Section title={t('settings.you.spendGauge')} note={t('settings.you.theRingAroundYour')}>
        <Card>
          <BudgetRow settings={settings} onSettings={onSettings} />
        </Card>
      </Section>
    </>
  )
}

/** DS-18: an optional monthly budget for the footer gauge; empty means a full ring. */
function BudgetRow({ settings, onSettings }: { settings: SettingsView; onSettings(view: SettingsView): void }): ReactElement {
  const t = useT()
  const [text, setText] = useState(settings.monthlyBudgetUsd === null ? '' : String(settings.monthlyBudgetUsd))
  const [error, setError] = useState<string | null>(null)
  const commit = (): void => {
    const trimmed = text.trim().replace(/^\$/, '')
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && (!Number.isFinite(value) || value < 1 || value > 100_000)) {
      setError(t('settings.you.enterAnAmountFrom'))
      return
    }
    setError(null)
    if (value === settings.monthlyBudgetUsd) return
    atelier.settings.set({ monthlyBudgetUsd: value }).then(onSettings, (err: unknown) => setError(errorText(err)))
  }
  return (
    <Row title={t('settings.you.monthlyBudget')} description={error ?? t('settings.you.inUsDollarsLeave')} htmlFor="you-budget">
      <TextInput
        id="you-budget"
        className="sp-input--short"
        inputMode="decimal"
        placeholder={t('settings.you.none')}
        value={text}
        invalid={error !== null}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </Row>
  )
}
