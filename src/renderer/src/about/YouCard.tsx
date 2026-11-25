/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Your card (ON-18): who you are at a glance, the same in setup's workspace
// step and in Settings › You. Your picture or initial, your name and what
// you do in one line, a hands-on meter, and what you want help with as icon
// badges. No sentences to read.
import type { ReactElement } from 'react'
import { AudioLines, ChartColumn, Code, GraduationCap, Handshake, Palette, Plane, PenLine, Repeat, Search, ShoppingBag, SquareKanban, Wallet, type LucideIcon } from 'lucide-react'
import type { Interest, TechLevel, UserProfile } from '@shared/userProfile'
import { useT } from '../i18n/useT'
import './about.css'

export const INTEREST_ICON: Record<Interest, LucideIcon> = {
  research: Search,
  shopping: ShoppingBag,
  writing: PenLine,
  meetings: AudioLines,
  routines: Repeat,
  travel: Plane,
  coding: Code,
  data: ChartColumn,
  design: Palette,
  projects: SquareKanban,
  sales: Handshake,
  finance: Wallet,
  learning: GraduationCap,
}

const LEVEL_BARS: Record<TechLevel, number> = { simple: 1, mixed: 2, technical: 3 }

export function YouCard({ profile, name, avatar }: { profile: UserProfile; name: string | null; avatar: string | null }): ReactElement {
  const t = useT()
  // Settings › You › Name is where your name is kept; a profile from before that still shows its own.
  const shown = name ?? profile.name ?? t('settings.you.you')
  return (
    <div className="you-card">
      <div className="you-card__head">
        <span className="you-card__avatar" aria-hidden="true">
          {avatar ? <img src={avatar} alt="" /> : shown.slice(0, 1).toUpperCase()}
        </span>
        <span className="you-card__who">
          <strong className="you-card__name">{shown}</strong>
          {profile.work && <span className="you-card__work">{profile.work}</span>}
        </span>
        {profile.techLevel && (
          <span className="you-card__level" title={t('settings.you.about.handsOn')}>
            <span className="you-card__bars" aria-hidden="true">
              {[1, 2, 3].map((n) => (
                <i key={n} data-on={n <= LEVEL_BARS[profile.techLevel!] || undefined} />
              ))}
            </span>
            {t(`settings.you.about.level.${profile.techLevel}`)}
          </span>
        )}
      </div>
      {profile.interests.length > 0 && (
        <ul className="you-card__badges" aria-label={t('settings.you.about.interests')}>
          {profile.interests.map((i) => {
            const Icon = INTEREST_ICON[i]
            return (
              <li key={i} className="you-card__badge" data-interest={i}>
                <Icon aria-hidden />
                {t(`settings.you.about.interest.${i}`)}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
