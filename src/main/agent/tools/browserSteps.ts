/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// browser_steps (docs/decisions.md › Browser tasks): your companion writes a browser task down once (the goal, where to
// stop, the values to type) and atelier-step, a small model on this computer, takes it page by page. One pass per
// page gives the operation, the control and which named value goes into each field, in about a tenth of a second.
//
// It never writes text: what it types is one of the values it was given. Every click and every field goes through
// the chat's own browser steps (AgentSession.chatBrowser), so the pause, the site rules, the click guard and the
// approvals are the agent's own. Whatever it isn't sure of goes back to the companion, which carries on with its own
// browser tools: unsure, refused by the person, going in circles, a second add to the cart, done or blocked.
//
// A button with only an icon on it has no name in the page, so atelier-step could never choose it. With atelier-vision
// on this computer (docs/decisions.md › Pictures) such a control is named from its picture, in the page's language:
// which of all its jobs the icon stands for, and then whether it really is a button for that job, since among 63
// answers something always looks likeliest and many icons (a logo, an anchor) are none of them. One it isn't sure of
// on either count stays out of the step, as every unnamed control did before.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BROWSER_STEP_VALUES_MAX, BROWSER_STEPS_DEFAULT, BROWSER_STEPS_MAX, type BrowserStepsCard, type BrowserStepsStatus, type StepPageItem } from '@shared/browserSteps'
import { CONTROL_ASK, CONTROL_IS, CONTROL_JOBS, CONTROL_LANGS, type ControlLang } from '@shared/visionControls'
import type { LookAnswer } from '../../decisions/device'
import type { StepAnswer } from '../../decisions/device/step'
import type { StepElement, StepInput } from '../../decisions/device/stepFormat'
import type { Question as VisionQuestion } from '../../decisions/device/visionFormat'
import type { Picture } from '../../decisions/device/visionPreprocess'
import { pictureKey } from '../../decisions/pictures'
import type { ActionKind } from '@shared/agentTools'
import { namesActionKind } from '../guard'
import type { ChatBrowser } from '../session'
import { registerClientTool, type ClientTool, type ClientToolContext, type ClientToolResult } from './registry'

export const BROWSER_STEPS_TOOL = 'browser_steps'

/** An operation is taken at this probability (the runtime's cutoff, calibrated in step.json). */
const OP_SURE = 0.6
/** A control or a value is taken when it is this likely and clearly ahead of the next one. */
const clear = (p: number, second: number, cutoff = 0.5): boolean => p >= cutoff && p >= 1.5 * second
/** The same operation on the same control again within this many: going in circles. */
const CIRCLE = 4
/** A page that hasn't changed after an action is read again once after this, for pages that render late. */
const SETTLE_MS = 500
const ADD_TO_CART =
  /^(add to (cart|basket|bag)|in (de |het )?(winkelwagen|winkelmand|winkelmandje)|toevoegen aan (de )?winkel(wagen|mand)|(zum|in den) warenkorb( hinzufügen| legen)?|ajouter au panier|añadir a la (cesta|carrito)|añadir al carrito)$/i
const PRICE = /^\s*(?:€|\$|£|EUR)\s?\d|\d+(?:[.,]\d{2})?\s?(?:€|EUR)/
/**
 * Consequential clicks (paying, buying, sending, posting, deleting, account and security changes) are never atelier-
 * step's own decision: one the goal doesn't ask for is a wrong turn, so the companion decides instead of the person
 * being asked to approve it, whatever the approval mode. Paying always goes back. The guard's own words, and the
 * other languages it was trained on.
 */
const CONSEQUENTIAL: readonly ActionKind[] = ['payment', 'purchase', 'message', 'post', 'delete', 'account', 'security']
const ELSEWHERE: Partial<Record<ActionKind, RegExp>> = {
  delete: /\b(verwijder(en)?|wissen|weghalen|l[öo]schen|entfernen|supprimer|retirer|eliminar|quitar|borrar)\b/i,
  account: /\b(sign-?ups?|registration|registreren|aanmelden|inschrijven|anmelden|registrieren|s'inscrire|inscription|registrarse)\b/i,
  purchase: /\b(afrekenen|bestellen|kopen|kaufen|zur kasse|commander|acheter|comprar|pedido)\b/i,
  payment: /\b(betalen|bezahlen|payer|pagar)\b/i,
  message: /\b(verstuur|versturen|verzenden|senden|envoyer|enviar)\b/i,
}
function names(text: string, kind: ActionKind): boolean {
  return namesActionKind(text.replace(/[-_]/g, ' '), kind) || Boolean(ELSEWHERE[kind]?.test(text))
}
export function offPath(label: string, goal: string): ActionKind | null {
  for (const kind of CONSEQUENTIAL) {
    if (!names(label, kind)) continue
    if (kind === 'payment' || !names(goal, kind)) return kind
  }
  return null
}

export interface StepModel {
  stepAvailable(): boolean
  step(input: StepInput, signal: AbortSignal): Promise<StepAnswer>
}

/** atelier-vision, as this tool uses it: what a control's picture shows. */
export interface PictureModel {
  visionAvailable(): boolean
  look(input: { picture?: Picture; vector?: Float32Array }, questions: Record<string, VisionQuestion>, signal: AbortSignal): Promise<LookAnswer>
}

/**
 * A control is named from its picture when the model gives one job this much of its weight among all of them, and
 * then says yes this surely to "is it a button for that job?". Measured with exactly these two questions and cutoffs
 * (the atelier-decisions project, vision-v0.1, analysis/results/vision-buttons-v0.1.txt) on icons drawn by sets it
 * never saw: 64% get their right name and 0.9% a wrong one, and of the buttons that are none of the jobs 9.9% are
 * named anyway (19.6% with the readers' usual 0.75 and 0.7, which is why these are stricter). What it is less sure of
 * stays unnamed.
 */
export const PICTURE_SURE = 0.9
export const PICTURE_YES = 0.9

/** The language to name a control in: the page's own when the model was trained in it, else English. */
export function controlLang(pageLang: string | undefined): ControlLang {
  const short = (pageLang ?? '').toLowerCase().split(/[-_]/)[0] ?? ''
  return (CONTROL_LANGS as readonly string[]).includes(short) ? (short as ControlLang) : 'en'
}

/** "What does this button do?", with every job as an option, named in one language. */
export function controlQuestion(lang: ControlLang): VisionQuestion {
  return { type: 'choice', instructions: 'What does this button do?', criteria: Object.fromEntries(CONTROL_JOBS.map((job) => [job.key, job.names[lang]])) }
}

/** "Is this a button for <the job>?", with what a yes looks like, in two of the wordings the model was trained on. */
export function controlCheck(lang: ControlLang, name: string): VisionQuestion {
  return { type: 'noul', instructions: CONTROL_ASK[lang].replace('{name}', name), criteria: { true: CONTROL_IS[lang].replace('{name}', name) } }
}

/**
 * The page's items with every unnamed control either named from its picture or left out. `seen` keeps what a
 * picture was named before (by its pixels: a site's header icons are on every page), null for "not sure".
 */
export async function nameUnnamed(
  items: StepPageItem[],
  pictures: Record<string, Picture> | undefined,
  lang: ControlLang,
  model: PictureModel | null,
  seen: Map<string, string | null>,
  signal: AbortSignal,
): Promise<StepPageItem[]> {
  const out: StepPageItem[] = []
  const question = controlQuestion(lang)
  for (const item of items) {
    if (item.label || item.role === 'text' || item.role === 'field' || item.role === 'select') {
      out.push(item)
      continue
    }
    const picture = pictures?.[item.ref]
    if (!picture || !model?.visionAvailable()) continue
    const key = `${lang}:${pictureKey(picture)}`
    let name = seen.get(key)
    if (name === undefined) {
      name = null
      try {
        const first = await model.look({ picture }, { does: question }, signal)
        const answer = first.answers.does
        const job = answer?.type === 'choice' && (answer.probabilities[answer.choice] ?? 0) >= PICTURE_SURE ? CONTROL_JOBS.find((j) => j.key === answer.choice) : undefined
        if (job) {
          // The picture's vector is kept from the first question: the second costs no pass through the image tower.
          const check = (await model.look({ vector: first.vector }, { is: controlCheck(lang, job.names[lang]) }, signal)).answers.is
          if (check?.type === 'noul' && check.noul >= PICTURE_YES) name = job.names[lang]
        }
      } catch (err) {
        if (signal.aborted) throw err
        // The model failed on this one: the control stays unnamed, and the step goes on without it.
      }
      seen.set(key, name)
    }
    if (name) out.push({ ...item, label: name, seen: true })
  }
  return out
}

export interface BrowserStepsDeps {
  /** The chat's browser (AgentHost.browserFor), of which this tool reads pages and takes steps; null when the chat isn't loaded. */
  browser(chatId: string): Pick<ChatBrowser, 'step' | 'page'> | null
  /** The on-device models (decisions/device.ts deviceSteps); null before start. */
  steps(): StepModel | null
  /** atelier-vision, when it is installed, to name controls the page gave no name (the same on-device models). */
  pictures?(): PictureModel | null
  /** Waits between reads of a page that rendered late (tests pass a no-op). */
  sleep?(ms: number): Promise<void>
}

const input = z.object({
  goal: z.string().trim().min(3).max(300),
  values: z
    .array(z.object({ name: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(200) }).strict())
    .max(BROWSER_STEP_VALUES_MAX)
    .default([]),
  tab_id: z.string().min(1).nullish(),
  max_steps: z.number().int().min(1).max(BROWSER_STEPS_MAX).nullish(),
})
type Input = z.infer<typeof input>

const DESCRIPTION = `Runs a task in a browser tab page by page with atelier-step, a small model on this computer: it clicks, fills fields with the values you give and stops when the goal looks reached or it can't go on. A page takes about a tenth of a second, far faster than doing each step yourself.

Use it for routine stretches of a task on a site: adding a product to the cart and opening the cart, filling in a form, following a search to a result, getting through a sign-up. Give it one stretch at a time, each ending on one page, with where to stop in the goal ("add the Trailrunner 2 in size 43 to the cart and open the cart", "fill in the delivery details and continue to the payment page, stop there", "fill in the form, stop before sending"); a whole task in one goal makes it stop early. Give every value it may have to type as a named value (the person's name, email, address, phone, a size, the search words): it never makes up text, so a field nobody gave a value for is left for you.

It hands the task back to you, with what it did, when it isn't sure, when the person declines a click, when it would go in circles, when it reaches for a click the goal didn't ask for (buying, sending, deleting, an account change), before any payment, or when the goal looks reached. Then look at the page yourself (read_page) and carry on with your own browser tools, or call browser_steps again for the next routine stretch. It can be wrong about "done": check before you tell the person. Every click goes through the same checks and approvals as yours.`

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

/** Context goes with a control only where training had it: a label that repeats ("View order" per order), or a price. */
function stepElements(items: StepPageItem[]): StepElement[] {
  const counts = new Map<string, number>()
  for (const i of items) if (i.role !== 'text') counts.set(i.label, (counts.get(i.label) ?? 0) + 1)
  const labels = [...new Set(items.filter((i) => i.role !== 'text' && i.label.length > 1).map((i) => i.label))].sort((a, b) => b.length - a.length)
  return items.map((i): StepElement => {
    if (i.role === 'text') return { role: 'text', label: i.label }
    if (i.role === 'field') return { role: 'field', label: i.label, value: i.value ?? '' }
    if (i.role === 'select') return { role: 'select', label: i.label, value: i.value ?? '', options: i.options ?? [] }
    if (i.role === 'checkbox' || i.role === 'radio') return { role: i.role, label: i.label, checked: Boolean(i.checked) }
    let context = i.context
    if (context) {
      let rest = context
      for (const l of labels) rest = rest.split(l).join(' ')
      const keep = rest.replace(/[\s·|,()-]+/g, '').length >= 3 && ((counts.get(i.label) ?? 0) > 1 || PRICE.test(context))
      if (!keep) context = undefined
    }
    return { role: i.role, label: i.label, ...(context ? { context } : {}) }
  })
}

/**
 * The best index among the allowed ones (renormalised), when it is clearly ahead; else null. When the model put most
 * of its weight on controls it may not use (a password field, a filled one), it is not sure of any allowed one either.
 */
function pick(ps: Array<number | null>, ok: (i: number) => boolean): number | null {
  const ranked = ps.map((p, i) => [i, p] as const).filter((x): x is readonly [number, number] => x[1] !== null && ok(x[0]))
  const all = ps.reduce<number>((t, p) => t + (p ?? 0), 0)
  const total = ranked.reduce((t, x) => t + x[1], 0)
  if (total <= 0 || (all > 0 && total < 0.5 * all)) return null
  const sorted = ranked.map(([i, p]) => [i, p / total] as const).sort((x, y) => y[1] - x[1])
  const [first, second] = sorted
  return first && clear(first[1], second?.[1] ?? 0) ? first[0] : null
}

/** Which named value goes into a field (index into values), null for none of them, undefined when not sure. */
function valueOf(probs: number[] | null): number | null | undefined {
  if (!probs) return undefined
  const ranked = probs.map((p, j) => [j, p] as const).sort((x, y) => y[1] - x[1])
  const [first, second] = ranked
  if (!first || !clear(first[1], second?.[1] ?? 0)) return undefined
  return first[0] === 0 ? null : first[0] - 1
}

/** The option a value names: the same text, else one that holds the value as whole words (or the other way round); never a few letters inside a word ("M" is not "Small"). */
export function optionFor(options: readonly string[], value: string): string | null {
  const plain = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
  const v = plain(value)
  if (!v) return null
  const words = (hay: string, needle: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(hay)
  return options.find((o) => plain(o) === v) ?? options.find((o) => words(plain(o), v)) ?? options.find((o) => plain(o).length > 1 && words(v, plain(o))) ?? null
}

const q = (s: string): string => `“${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`
/** The person said no: declined an approval, or stopped its countdown. */
const declined = (err: unknown): boolean => err instanceof Error && /declined the action|you stopped this action/i.test(err.message)

interface Ending {
  status: BrowserStepsStatus
  /** For the companion: what happened and what to do now. */
  reason: string
  /** For the person, on the card. */
  note: string
}

export function createBrowserStepsTool(deps: BrowserStepsDeps): ClientTool<Input> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  async function run(task: Input, ctx: ClientToolContext): Promise<ClientToolResult> {
    const browser = deps.browser(ctx.chatId)
    const model = deps.steps()
    if (!browser) return { content: 'This chat has no browser to drive.', isError: true }
    if (!model?.stepAvailable()) {
      return { content: 'atelier-step is not installed on this computer (Settings › Quick decisions › On this computer › Browser tasks). Do the steps with your own browser tools.' }
    }
    const values = task.values
    const card: BrowserStepsCard = { type: 'browser-steps', id: randomUUID(), goal: task.goal, status: 'running', steps: [] }
    const emit = (): void => ctx.emit({ ...card, steps: [...card.steps] })
    emit()
    const before: string[] = []
    const signatures: string[] = []
    const refused = new Set<string>()
    const vision = deps.pictures?.() ?? null
    const looks = { pictures: vision?.visionAvailable() ?? false }
    const named = new Map<string, string | null>()
    let added = false
    let lastKey = ''
    let same = 0
    let where = ''
    let tabId: string | null = task.tab_id ?? null
    const max = task.max_steps ?? BROWSER_STEPS_DEFAULT

    const end = (e: Ending): ClientToolResult => {
      card.status = e.status
      card.note = e.note
      emit()
      const lines = card.steps.map((s, i) => `${i + 1}. ${s.text}`)
      const did = lines.length ? `atelier-step took ${lines.length} step${lines.length === 1 ? '' : 's'}${where ? ` (now on ${where})` : ''}:\n${lines.join('\n')}` : `atelier-step took no steps${where ? ` (on ${where})` : ''}.`
      return { content: `${did}\n\n${e.reason}` }
    }
    const handBack = (why: string, note: string): ClientToolResult =>
      end({ status: 'handed-back', reason: `Handed back to you: ${why}. Look at the page (read_page) and carry on with your own browser tools, or call browser_steps again for the next routine stretch.`, note })
    const circling = (signature: string): boolean => {
      const again = signatures.slice(-CIRCLE).includes(signature)
      signatures.push(signature)
      return again
    }

    try {
      for (let n = 1; n <= max; n++) {
        if (ctx.signal.aborted) return end({ status: 'stopped', reason: 'Stopped.', note: '' })
        let read = await browser.page(tabId, ctx.signal, looks)
        tabId = read.tabId
        if (!read.page) return handBack('this tab has no page atelier-step can read (a blank tab or a PDF)', 'There was no page to work on.')
        let key = `${read.url}\n${JSON.stringify(read.page.items.map((i) => [i.ref, i.label, i.value, i.checked]))}`
        if (key === lastKey && n > 1) {
          // Pages that render after the load event: one more look before calling it unchanged.
          await sleep(SETTLE_MS)
          read = await browser.page(tabId, ctx.signal, looks)
          if (!read.page) return handBack('the tab has no readable page any more', 'The page went away.')
          key = `${read.url}\n${JSON.stringify(read.page.items.map((i) => [i.ref, i.label, i.value, i.checked]))}`
        }
        same = key === lastKey ? same + 1 : 0
        lastKey = key
        where = `${read.title || pathOf(read.url)} (${read.url})`
        if (same >= 2) return handBack('the page stopped changing after its steps', 'The page stopped changing.')
        // Controls the page gave no name are named from their pictures, or left out.
        const items = await nameUnnamed(read.page.items, read.pictures, controlLang(read.page.lang), vision, named, ctx.signal)
        const elements = stepElements(items)
        const answer = await model.step({ goal: task.goal, values, before: [...before], page: `${read.title} (${pathOf(read.url)})`, elements }, ctx.signal)
        const ms = Math.round(answer.ms)
        const [op, pOp] = Object.entries(answer.op).sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
        if (pOp < OP_SURE) return handBack(`atelier-step isn't sure what to do next on this page (${op} ${pOp.toFixed(2)})`, 'Not sure what to do next here.')
        if (op === 'done') {
          return end({
            status: 'done',
            reason: 'The goal looks reached on this page. Check it yourself (read_page or find) before you tell the person: atelier-step can be wrong about this.',
            note: '',
          })
        }
        if (op === 'blocked') {
          return end({
            status: 'blocked',
            reason: 'atelier-step can’t go further from this page: a sign-in, a value nobody gave, an error, or a choice for the person. Look at the page and decide, or ask the person.',
            note: 'It can’t go further from this page.',
          })
        }
        if (op === 'click') {
          const i = pick(answer.click, (k) => items[k]?.role !== 'text' && items[k]?.role !== 'field' && items[k]?.role !== 'select')
          const target = i === null ? undefined : items[i]
          if (!target) return handBack('atelier-step isn’t sure which control to click next', 'Not sure what to click next.')
          if (refused.has(target.label)) return handBack(`the person said no to ${q(target.label)} before`, `You said no to ${q(target.label)}.`)
          const off = offPath(target.label, task.goal)
          if (off) return handBack(`atelier-step reached for ${q(target.label)} (a ${off} click${off === 'payment' ? ', which it never makes' : ' the goal doesn’t ask for'}); decide the next step yourself`, `It reached for ${q(target.label)}; your companion decides instead.`)
          const adds = ADD_TO_CART.test(target.label.trim())
          if (adds && added) return handBack(`it would add a second item to the cart (${q(target.label)})`, 'It would add a second item to the cart.')
          if (circling(`click|${target.label}|${target.context ?? ''}|${pathOf(read.url)}`)) return handBack(`it was going in circles (clicking ${q(target.label)} again)`, 'It was going in circles.')
          try {
            await browser.step('left_click', { target: { type: 'ref', ref: target.ref }, tab_id: tabId }, ctx.signal)
          } catch (err) {
            if (declined(err)) {
              refused.add(target.label)
              return handBack(`the person declined clicking ${q(target.label)}; don't try it another way, ask them how to go on`, `You said no to ${q(target.label)}.`)
            }
            throw err
          }
          if (adds) added = true
          before.push(`clicked ${target.label}`)
          card.steps.push({ text: target.seen ? `Clicked the ${q(target.label)} icon` : `Clicked ${q(target.label)}`, ms })
          emit()
          continue
        }
        // Typing: into an empty field (as in training, a filled one is never the target), then every other empty field
        // of the same form that atelier-step is sure of. A field in another part of the page (the header's search box)
        // is never filled along with a form.
        const empty = (k: number): boolean => {
          const it = items[k]
          return Boolean(it && (it.role === 'field' || it.role === 'select') && !it.guarded && !(it.value ?? '').trim())
        }
        const t = pick(answer.type, empty)
        const target = t === null ? undefined : items[t]
        if (t === null || !target) return handBack('atelier-step isn’t sure which field to fill next', 'Not sure which field comes next.')
        const first = valueOf(answer.values[t] ?? null)
        if (first === undefined) return handBack(`atelier-step isn’t sure which value goes into ${q(target.label)}`, `Not sure what goes into ${q(target.label)}.`)
        if (first === null) return handBack(`none of the values it was given fits ${q(target.label)}`, `No value for ${q(target.label)}.`)
        const fills: Array<{ k: number; value: string }> = [{ k: t, value: values[first]?.value ?? '' }]
        items.forEach((it, k) => {
          if (k === t || !empty(k) || it.group !== target.group) return
          const v = valueOf(answer.values[k] ?? null)
          if (typeof v === 'number' && values[v]) fills.push({ k, value: values[v].value })
        })
        fills.sort((a, b) => a.k - b.k)
        if (circling(`type|${fills.map((f) => `${items[f.k]?.label}=${f.value}`).join('|')}|${pathOf(read.url)}`)) return handBack('it was going in circles (filling the same fields again)', 'It was going in circles.')
        for (const f of fills) {
          const it = items[f.k]
          if (!it) continue
          let value = f.value
          if (it.role === 'select') {
            const option = optionFor(it.options ?? [], value)
            if (!option) {
              if (f.k === t) return handBack(`${q(value)} matches none of the options of ${q(it.label)}`, `No option of ${q(it.label)} matches.`)
              continue
            }
            value = option
          }
          await browser.step('form_input', { target: { type: 'ref', ref: it.ref }, value, tab_id: tabId }, ctx.signal)
          before.push(`typed into ${it.label}`)
          card.steps.push({ text: `Filled in ${q(it.label)}: ${q(value)}`, ms: f.k === t ? ms : 0 })
        }
        emit()
      }
      return handBack(`it used its ${max} steps`, `It used its ${max} steps.`)
    } catch (err) {
      if (ctx.signal.aborted) return end({ status: 'stopped', reason: 'Stopped.', note: '' })
      const message = err instanceof Error ? err.message : String(err)
      return end({ status: 'failed', reason: `A step failed: ${message.slice(0, 300)}. Look at the page and carry on with your own browser tools.`, note: 'A step didn’t work.' })
    }
  }

  return {
    name: BROWSER_STEPS_TOOL,
    group: 'chat',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What to do on this site, with where to stop. One or two sentences, in the words a person would use.' },
        values: {
          type: 'array',
          description: 'Every value it may type, named the way a form would ask for it ("email", "postcode", "shoe size", "search").',
          items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          maxItems: BROWSER_STEP_VALUES_MAX,
        },
        tab_id: { type: 'string', description: 'The tab to work in (default: the one you are working in).' },
        max_steps: { type: 'integer', minimum: 1, maximum: BROWSER_STEPS_MAX, description: `Steps before it hands back (default ${BROWSER_STEPS_DEFAULT}).` },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    parse: input,
    // On while this computer has atelier-step and the chat can use the browser; not in routines, which wait on no one.
    enabled: (setup) => setup.browser && !setup.routine && (deps.steps()?.stepAvailable() ?? false),
    run,
  }
}

export function registerBrowserSteps(deps: BrowserStepsDeps): void {
  registerClientTool(createBrowserStepsTool(deps))
}
