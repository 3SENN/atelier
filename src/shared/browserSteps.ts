/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Browser tasks run by atelier-step (docs/decisions.md › Browser tasks): the page as the step model reads it, and the
// chat card that shows the steps while they run.

/** A control or a short line of text on the page, in page order, as the page bridge reads it for a step. */
export interface StepPageItem {
  /** The bridge's element reference (`ref_N`), the same one read_page and left_click use; '' for text lines. */
  ref: string
  role: 'link' | 'button' | 'field' | 'select' | 'checkbox' | 'radio' | 'text'
  label: string
  value?: string
  options?: string[]
  checked?: boolean
  /** The row it sits in (a product with its price, an order with its date), when that tells it apart. */
  context?: string
  /** Which form or page region it belongs to: fields are filled together only within one. '' for none. */
  group: string
  /** A password, card or one-time-code field: never typed into. */
  guarded?: boolean
  /**
   * Where a link or button that the page gives no name sits in the viewport, in CSS pixels: a button with only an
   * icon on it. Its picture is what names it (atelier-vision, docs/decisions.md › Pictures); one that stays unnamed
   * is left out, as before.
   */
  box?: { x: number; y: number; width: number; height: number }
  /** The name came from the control's picture, not from the page. */
  seen?: boolean
}

export interface StepPage {
  items: StepPageItem[]
  /** More controls than were read (a very long page): the step model sees the beginning. */
  truncated: boolean
  /** The language the page says it is in (`<html lang>`), for naming what it left unnamed. */
  lang?: string
}

/** Unnamed controls one page read brings along: each is a capture and a pass through the image model. */
export const STEP_UNNAMED_MAX = 12

/** One thing the steps did, as the card lists it. */
export interface BrowserStepLine {
  text: string
  /** Milliseconds atelier-step took to decide it. */
  ms: number
}

export type BrowserStepsStatus = 'running' | 'done' | 'blocked' | 'handed-back' | 'stopped' | 'failed'

/** The chat card of one browser_steps run, upserted by id as it goes. */
export interface BrowserStepsCard {
  type: 'browser-steps'
  id: string
  goal: string
  status: BrowserStepsStatus
  steps: BrowserStepLine[]
  /** Why it ended (handed back, blocked): a short sentence for the person. */
  note?: string
}

/** Steps one run may take before it hands the task back. */
export const BROWSER_STEPS_MAX = 30
export const BROWSER_STEPS_DEFAULT = 15
/** Named values one run takes (atelier-step reads 16). */
export const BROWSER_STEP_VALUES_MAX = 16
