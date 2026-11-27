/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// label_pictures (docs/decisions.md › Pictures): the companion hands judgment calls over many pictures on a page
// (sorting photos into albums, which attachments are receipts, which product pictures show the colour asked for, what
// an icon stands for) to atelier-vision, a model on this computer that looks at them. It is label_items for pictures:
// the same System One questions, read with the same cutoffs, and "unsure" where the model is not sure, for the
// companion to look at itself.
//
// A picture is what the page shows of an element the companion names by its reference (from read_page or find), or
// the page as it shows. Reading goes through the chat's own browser (AgentSession.chatBrowser): the pause, the site
// rules, and the masking of guarded fields are the agent's own. Nothing leaves this computer, so private chats have
// it too, like browser_steps. The model matches a picture against each answer's own text, so an option has to say
// what to look for.
//
// It also finds: with `find`, a description, every picture gets how likely the description fits it, and the pictures
// come back best first. That is search among a page's pictures, with no model call beyond the look itself.

import { z } from 'zod'
import { DECISION_LIMITS, DECISION_QUESTION_SCHEMA, type DecisionAnswer, type DecisionQuestion } from '@shared/decisions'
import { readAnswer, type ItemAnswer } from '../../decisions/tool'
import type { ChatBrowser } from '../session'
import type { PictureModel } from './browserSteps'
import { CLIENT_TOOL_RESULT_MAX, registerClientTool, type ClientTool, type ClientToolContext, type ClientToolResult } from './registry'

export const LABEL_PICTURES_TOOL = 'label_pictures'
export const LABEL_PICTURES_MAX = 40
export const LABEL_PICTURE_QUESTIONS_MAX = 5
const FIND_CHARS = 300
/** The description to find is one more yes/no question for the model; its key is one no question of the companion's can have. */
const FIND_KEY = '~find'

export interface LabelPicturesDeps {
  /** The chat's browser (AgentHost.browserFor), of which this tool takes pictures; null when the chat isn't loaded. */
  browser(chatId: string): Pick<ChatBrowser, 'picture'> | null
  /** atelier-vision (decisions/device.ts deviceSteps); null before start. */
  pictures(): PictureModel | null
}

const questionKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)

const input = z
  .object({
    pictures: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100).optional(),
            ref: z.string().trim().min(1).max(40).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(LABEL_PICTURES_MAX),
    questions: z
      .record(questionKey, DECISION_QUESTION_SCHEMA)
      .refine((q) => Object.keys(q).length <= LABEL_PICTURE_QUESTIONS_MAX, { message: `Ask at most ${LABEL_PICTURE_QUESTIONS_MAX} questions.` })
      .default({}),
    find: z.string().trim().min(2).max(FIND_CHARS).optional(),
    tab_id: z.string().min(1).nullish(),
  })
  .strict()
  .refine((v) => Boolean(v.find) || Object.keys(v.questions).length > 0, { message: 'Ask at least one question, or give a description to find.' })

type Input = z.infer<typeof input>

interface Row {
  id: string
  answers?: Record<string, ItemAnswer & { why?: string }>
  /** With `find`: how likely the description fits this picture. */
  match?: number
  error?: string
}

const DESCRIPTION = `Answers the same short judgment questions about many pictures on a page at once with atelier-vision, a model on this computer that looks at them: yes or no, one of a set of options, or a level on a scale. Use it to sort, label, filter or check pictures (which album each photo belongs in, which attachments are receipts, which product pictures show the item asked for, what each unlabeled icon is for): it takes a fraction of a second a picture, far faster than taking and reading a screenshot of each yourself.

Name each picture by the ref of its element, from read_page or find (an image, a thumbnail, a canvas, a button, any element); it is scrolled into view and looked at as the page shows it. Leave ref out to ask about the page as it shows now.

To find pictures instead of (or as well as) labelling them, give find a description ("the red sofa", "a boarding pass"): every picture gets match, how likely the description fits it, and best_first lists them from most to least like it.

It only compares a picture with the text of each answer, so write options that say what to look for ("A day at the beach or by the sea", "A receipt from a shop or a restaurant"), not "the first one"; for yes or no, add what a yes looks like in criteria.true. It reads no small text in a picture, recognises no people, and does no counting or arithmetic. Answers it is not sure of come back as "unsure": look at those yourself.`

export function createLabelPicturesTool(deps: LabelPicturesDeps): ClientTool<Input> {
  async function run(args: Input, ctx: ClientToolContext): Promise<ClientToolResult> {
    const browser = deps.browser(ctx.chatId)
    const model = deps.pictures()
    if (!browser) return { content: 'This chat has no browser to look at.', isError: true }
    if (!model?.visionAvailable()) {
      return { content: 'atelier-vision is not installed on this computer (Settings › Quick decisions › On this computer › Pictures). Look at these pictures yourself.' }
    }
    const rows: Row[] = args.pictures.map((p, i) => ({ id: p.id ?? p.ref ?? String(i + 1) }))
    const questions = args.questions as Record<string, DecisionQuestion>
    // The description is matched as what a yes looks like: the model's calibrated "does this text fit the picture".
    const asked = args.find ? { ...questions, [FIND_KEY]: { type: 'noul' as const, instructions: args.find, criteria: { true: args.find } } } : questions
    let unreadable: string | null = null
    let tabId: string | null = args.tab_id ?? null
    // One after another: each picture is scrolled into view and captured before it is looked at.
    for (const [index, p] of args.pictures.entries()) {
      if (ctx.signal.aborted) break
      const row = rows[index]
      if (!row) continue
      try {
        const shot = await browser.picture(tabId, p.ref ?? null, ctx.signal)
        tabId = shot.tabId
        const out = await model.look({ picture: shot.picture }, asked, ctx.signal)
        const found = out.answers[FIND_KEY]
        if (found?.type === 'noul') row.match = Math.round(found.noul * 100) / 100
        else if (found?.type === 'refusal') unreadable = found.reason
        row.answers = Object.fromEntries(
          Object.entries(questions).map(([key, q]) => {
            const answer = out.answers[key]
            // A question it can't take (a text it can't read, an option without one) says why.
            if (!answer || answer.type === 'refusal') return [key, { answer: 'unsure', p: 0, ...(answer ? { why: answer.reason } : {}) }]
            return [key, readAnswer(q, answer as DecisionAnswer)]
          }),
        )
      } catch (err) {
        if (ctx.signal.aborted) break
        row.error = (err instanceof Error ? err.message : String(err)).slice(0, 200)
      }
    }
    ctx.signal.throwIfAborted()
    for (const row of rows) if (!row.answers && !row.error) row.error = 'not looked at'
    const failed = rows.filter((r) => r.error).length
    if (failed === rows.length) return { content: `None of the pictures could be looked at (${rows[0]?.error ?? 'it failed'}). Look at them yourself.`, isError: true }
    const unsure = rows.filter((r) => r.answers && Object.values(r.answers).some((a) => a.answer === 'unsure')).length
    const bestFirst = args.find && !unreadable ? rows.filter((r) => r.match !== undefined).sort((a, b) => (b.match ?? 0) - (a.match ?? 0)).map((r) => r.id) : undefined
    const note = [
      args.find && unreadable ? `The description to find couldn’t be read (${unreadable}): write it in a Latin-script language, in under 60 words.` : '',
      bestFirst ? 'match is how likely the description fits a picture; best_first lists the pictures from most to least like it. Look at the best ones yourself before you rely on one.' : '',
      unsure ? `${unsure} picture(s) have an “unsure” answer: the model was not sure enough, so look at those yourself (“leaning” is its best guess, “why” what kept it from answering).` : '',
      failed ? `${failed} picture(s) were not looked at (see “error”): look at those yourself.` : '',
      'p is the probability of “yes” for a yes-or-no question, and of the answer given otherwise.',
    ]
      .filter(Boolean)
      .join(' ')
    const head = { model: 'atelier-vision', ...(bestFirst ? { best_first: bestFirst } : {}) }
    let out = JSON.stringify({ ...head, pictures: rows, note })
    if (out.length > CLIENT_TOOL_RESULT_MAX) {
      const brief = rows.map((r) => ({ id: r.id, ...(r.match !== undefined ? { match: r.match } : {}), ...(r.answers ? { answers: Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, a.answer])) } : { error: r.error }) }))
      out = JSON.stringify({ ...head, pictures: brief, note })
    }
    return { content: out }
  }

  return {
    name: LABEL_PICTURES_TOOL,
    group: 'chat',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        pictures: {
          type: 'array',
          minItems: 1,
          maxItems: LABEL_PICTURES_MAX,
          description: 'The pictures to judge.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Your name for the picture (default: its ref, else its position, from 1).' },
              ref: { type: 'string', description: 'The element to look at, as read_page and find name it (ref_N). Leave out for the page as it shows.' },
            },
            additionalProperties: false,
          },
        },
        questions: {
          type: 'object',
          description: `Up to ${LABEL_PICTURE_QUESTIONS_MAX} questions asked about every picture, keyed by a short name (a letter, then letters, digits or _). At least one, unless find is given.`,
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'noul: yes or no. choice: exactly one of the options. score: a level on an ordered scale.' },
              instructions: { type: 'string', maxLength: DECISION_LIMITS.instructionChars, description: 'The question, about one picture.' },
              criteria: {
                description:
                  `choice: an object of 2 to ${DECISION_LIMITS.choices} options, {"option_key": "what the picture shows when this is the answer"} (with null, the key itself is what it looks for). ` +
                  `score: an array of 2 to ${DECISION_LIMITS.levels} descriptions of what each level looks like, lowest first. noul: {"true": "what a yes looks like", "false": "…"}, both optional.`,
              },
            },
            required: ['type', 'instructions'],
          },
        },
        find: { type: 'string', maxLength: FIND_CHARS, description: 'A description to find among the pictures ("the red sofa", "a receipt from a supermarket"): each gets match, and best_first ranks them.' },
        tab_id: { type: 'string', description: 'The tab the pictures are in (default: the one you are working in).' },
      },
      required: ['pictures'],
      additionalProperties: false,
    },
    parse: input,
    // On while this computer has atelier-vision and the chat can use the browser. It runs on this computer, so private
    // chats have it too; not in routines, like browser_steps.
    enabled: (setup) => setup.browser && !setup.routine && (deps.pictures()?.visionAvailable() ?? false),
    run,
  }
}

export function registerLabelPictures(deps: LabelPicturesDeps): void {
  registerClientTool(createLabelPicturesTool(deps))
}
