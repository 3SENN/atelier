/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The small model first, the mini for the rest, the rule last. atelier-nano (nano.ts) answers in milliseconds; a
// question it declines (an open question, text it can't read) or is unsure about by Atelier's own cutoffs
// (readers.ts) goes to atelier-mini (mini.ts) when it is installed; what the mini is unsure about stays unsure, so
// Atelier's rule decides. If the mini fails or the request is stopped, the small model's answers stand.
//
// Measured in the atelier-decisions project (analysis/cascade.py, v0.6): on Atelier's own held-out decisions it
// decides 77% (the small model alone 72%) and is right 94% of those; 28% of questions reach the mini. On kinds of
// questions the small model never saw (which it declines) it decides 50-78% and is right 87-98% of those.

import type { DecisionRequest } from './format'
import { fixedKind, optionLabels } from './format'
import type { Answer } from './nano'
import { probabilities, verdict } from './readers'

export type Route = 'nano' | 'mini'
type Usage = { input_tokens: number; output_tokens: number }
export interface Decided {
  answers: Record<string, Answer>
  usage: Usage
}

export interface CascadeParts {
  nano: { decide(request: DecisionRequest): Promise<Decided> }
  /** The mini, loaded on first use; null when it is not installed. */
  mini:
    | (() => Promise<{
        decide(request: DecisionRequest, cancelled?: () => boolean): Promise<Decided>
      }>)
    | null
}

/** Which questions the small model leaves open: a refusal, or an answer Atelier's reader would not take. */
export function unsettled(request: DecisionRequest, answers: Record<string, Answer>): string[] {
  return Object.entries(request.questions).flatMap(([key, q]) => {
    const a = answers[key]
    const labels = optionLabels(q)
    const p = a ? probabilities(a, labels) : null
    return p !== null && verdict(fixedKind(q) ?? 'open', labels, p) !== null ? [] : [key]
  })
}

export async function cascade(
  parts: CascadeParts,
  request: DecisionRequest,
  cancelled: () => boolean = () => false,
): Promise<Decided & { routes: Record<string, Route> }> {
  const first = await parts.nano.decide(request)
  const open = parts.mini ? unsettled(request, first.answers) : []
  const routes: Record<string, Route> = Object.fromEntries(Object.keys(request.questions).map((key) => [key, 'nano' as Route]))
  if (open.length === 0 || !parts.mini || cancelled()) return { ...first, routes }
  try {
    const mini = await parts.mini()
    const questions = Object.fromEntries(Object.entries(request.questions).filter(([key]) => open.includes(key)))
    const second = await mini.decide({ state: request.state, questions }, cancelled)
    for (const key of Object.keys(second.answers)) routes[key] = 'mini'
    return {
      answers: { ...first.answers, ...second.answers },
      usage: {
        input_tokens: first.usage.input_tokens + second.usage.input_tokens,
        output_tokens: 0,
      },
      routes,
    }
  } catch {
    // The mini failed to load or answer, or the request was stopped: the small model's answers stand (its unsure ones read as unsure, so the rule decides).
    return { ...first, routes }
  }
}
