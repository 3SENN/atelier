/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The agent bridge in the page (moved out of page.ts): it walks the
// DOM for read_page, find and get_page_text, keeps stable [ref_N] references,
// resolves elements and points for clicks, and fills form fields. Main asks
// over PAGE.command and the reply goes back on PAGE.reply.
import { BRAND_NAME } from '@shared/branding'
import { STEP_UNNAMED_MAX, type StepPage, type StepPageItem } from '@shared/browserSteps'
import { ipcRenderer } from 'electron'
import {
  PAGE,
  type ElementDescription,
  type FormInputResult,
  type PageCommand,
  type PageReply,
  type PageRequest,
  type ReadPageFilter,
  type ResolvedElement,
  type ViewportInfo,
} from '@shared/ipc'

const OUTPUT_CAP = 50_000
const VISIT_CAP = 25_000
const NAME_CAP = 100
const TEXT_RUN_CAP = 200

// ---- element references ----
// A reference stays bound to its element for the life of the document, so
// numbers are never reassigned before the tab navigates (which reloads this
// preload and starts over).

let nextRef = 1
const refToElement = new Map<string, WeakRef<Element>>()
const elementToRef = new WeakMap<Element, string>()

function refFor(el: Element): string {
  let ref = elementToRef.get(el)
  if (!ref) {
    ref = `ref_${nextRef++}`
    elementToRef.set(el, ref)
    refToElement.set(ref, new WeakRef(el))
  }
  return ref
}

function lookup(ref: string): Element {
  const el = refToElement.get(ref)?.deref()
  if (!el || !el.isConnected) {
    throw new Error(`${ref} is stale or not found on the current page. Re-read the page to get fresh references.`)
  }
  return el
}

// ---- roles and names ----

const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'treeitem', 'clickable',
])
// Roles whose name already carries their text content; their subtree is not
// walked again.
const LEAF_ROLES = new Set([
  'link', 'button', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'img', 'clickable',
])
const NAME_FROM_CONTENT = new Set([
  'link', 'button', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'treeitem', 'cell', 'columnheader', 'rowheader', 'clickable', 'checkbox', 'radio', 'switch', 'listitem',
])
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title'])
const PASSWORD_AUTOCOMPLETE = /\b(current-password|new-password)\b/i
const PAYMENT_HINT = /^cc-|card.?num|ccnum|cvc|cvv|security.?code|expir/i

function tag(el: Element): string {
  return el.tagName.toLowerCase()
}

function clean(text: string | null | undefined, cap = NAME_CAP): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim()
  return collapsed.length > cap ? `${collapsed.slice(0, cap - 1)}…` : collapsed
}

function inputRole(el: Element): string | null {
  const type = (el.getAttribute('type') ?? 'text').toLowerCase()
  if (el.hasAttribute('list')) return 'combobox'
  switch (type) {
    case 'hidden': return null
    case 'checkbox': return 'checkbox'
    case 'radio': return 'radio'
    case 'range': return 'slider'
    case 'number': return 'spinbutton'
    case 'search': return 'searchbox'
    case 'button': case 'submit': case 'reset': case 'image': case 'file': return 'button'
    default: return 'textbox'
  }
}

function hasLandmarkAncestor(el: Element): boolean {
  return el.parentElement?.closest('article, aside, main, nav, section') != null
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]
  if (explicit && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic') return explicit
  switch (tag(el)) {
    case 'a': case 'area': return el.hasAttribute('href') ? 'link' : null
    case 'button': case 'summary': return 'button'
    case 'select': {
      const select = el as HTMLSelectElement
      return select.multiple || select.size > 1 ? 'listbox' : 'combobox'
    }
    case 'option': return 'option'
    case 'textarea': return 'textbox'
    case 'input': return inputRole(el)
    case 'img': return el.getAttribute('alt') || el.hasAttribute('aria-label') ? 'img' : null
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading'
    case 'nav': return 'navigation'
    case 'main': return 'main'
    case 'header': return hasLandmarkAncestor(el) ? null : 'banner'
    case 'footer': return hasLandmarkAncestor(el) ? null : 'contentinfo'
    case 'aside': return 'complementary'
    case 'form': return 'form'
    case 'dialog': return 'dialog'
    case 'table': return 'table'
    case 'tr': return 'row'
    case 'th': return 'columnheader'
    case 'td': return 'cell'
    case 'ul': case 'ol': return 'list'
    case 'li': return 'listitem'
    case 'iframe': return 'iframe'
  }
  const html = el as HTMLElement
  if (html.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox'
  if (looksClickable(el)) return 'clickable'
  return null
}

// Many apps make <div>s clickable with script listeners, which an isolated
// world cannot see. A pointer cursor that starts at this element is the
// closest observable signal.
function looksClickable(el: Element): boolean {
  if (el.hasAttribute('onclick')) return true
  const tabindex = el.getAttribute('tabindex')
  if (tabindex !== null && Number(tabindex) >= 0) return true
  const view = el.ownerDocument.defaultView
  if (!view) return false
  if (view.getComputedStyle(el).cursor !== 'pointer') return false
  const parent = el.parentElement
  return !parent || view.getComputedStyle(parent).cursor !== 'pointer'
}

function labelText(el: Element): string {
  const labels = (el as HTMLInputElement).labels
  if (!labels || labels.length === 0) return ''
  return clean(Array.from(labels, (label) => label.textContent ?? '').join(' '))
}

function accessibleName(el: Element, role: string | null): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const doc = el.ownerDocument
    const text = clean(labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' '))
    if (text) return text
  }
  const aria = clean(el.getAttribute('aria-label'))
  if (aria) return aria
  const t = tag(el)
  if (t === 'input' || t === 'textarea' || t === 'select') {
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    if (type === 'submit' || type === 'button' || type === 'reset') {
      return clean((el as HTMLInputElement).value) || (type === 'submit' ? 'Submit' : '')
    }
    if (type === 'image') return clean(el.getAttribute('alt')) || 'Submit'
    return labelText(el) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('name'))
  }
  if (t === 'img') return clean(el.getAttribute('alt'))
  if (role && NAME_FROM_CONTENT.has(role)) {
    const text = clean((el as HTMLElement).innerText ?? el.textContent)
    if (text) return text
    const img = el.querySelector('img[alt], svg[aria-label], [aria-label]')
    if (img) return clean(img.getAttribute('alt') ?? img.getAttribute('aria-label'))
  }
  return clean(el.getAttribute('title'))
}

function isPasswordField(el: Element): boolean {
  return (tag(el) === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'password') ||
    PASSWORD_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')
}

function isPaymentField(el: Element): boolean {
  if (!['input', 'select'].includes(tag(el))) return false
  return [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id].some((v) => v != null && PAYMENT_HINT.test(v))
}

function describe(el: Element): ElementDescription {
  const role = roleOf(el) ?? tag(el)
  const form = el.closest('form')
  const submit = form?.querySelector('button[type="submit"], button:not([type]), input[type="submit"]') ?? null
  return {
    role,
    name: accessibleName(el, role),
    tag: tag(el),
    inputType: tag(el) === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : null,
    isPassword: isPasswordField(el),
    isPaymentField: isPaymentField(el),
    inForm: form != null,
    formSubmitName: submit ? accessibleName(submit, 'button') : null,
    formHasPaymentFields: form ? Array.from(form.querySelectorAll('input, select')).some(isPaymentField) : false,
  }
}

// ---- geometry ----

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Bounding box in the top document's viewport, crossing same-origin frames. */
function topViewportBox(el: Element): Box {
  const rect = el.getBoundingClientRect()
  let left = rect.left
  let top = rect.top
  let frame = el.ownerDocument.defaultView?.frameElement ?? null
  while (frame) {
    const frameRect = frame.getBoundingClientRect()
    left += frameRect.left + frame.clientLeft
    top += frameRect.top + frame.clientTop
    frame = frame.ownerDocument.defaultView?.frameElement ?? null
  }
  return { left, top, width: rect.width, height: rect.height }
}

function inViewport(box: Box): boolean {
  return box.top + box.height > 0 && box.left + box.width > 0 && box.top < window.innerHeight && box.left < window.innerWidth
}

function isRendered(el: Element): boolean {
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function isDisplayContents(el: Element): boolean {
  return el.ownerDocument.defaultView?.getComputedStyle(el).display === 'contents'
}

function childrenOf(el: Element): Element[] {
  const children: Element[] = []
  if (el.shadowRoot) children.push(...Array.from(el.shadowRoot.children))
  if (tag(el) === 'iframe') {
    const doc = (el as HTMLIFrameElement).contentDocument
    if (doc?.body) children.push(doc.body)
    return children
  }
  if (tag(el) === 'slot') children.push(...(el as HTMLSlotElement).assignedElements())
  children.push(...Array.from(el.children))
  return children
}

// ---- read_page ----

interface WalkOptions {
  filter: ReadPageFilter | null
  depth: number
}

interface Candidate {
  el: Element
  role: string
  name: string
  onscreen: boolean
}

function lineFor(el: Element, role: string, name: string, depth: number): string {
  const parts = [`${'  '.repeat(depth)}${role}`]
  if (name) parts.push(JSON.stringify(name))
  parts.push(`[${refFor(el)}]`)
  const t = tag(el)
  if (role === 'heading') {
    const level = el.getAttribute('aria-level') ?? (/^h[1-6]$/.test(t) ? t[1] : null)
    if (level) parts.push(`level=${level}`)
  }
  if (role === 'link') {
    const href = el.getAttribute('href')
    if (href && !href.startsWith('javascript:')) parts.push(`href=${JSON.stringify(clean(href, 120))}`)
  }
  if (t === 'input' || t === 'textarea') {
    const input = el as HTMLInputElement
    const type = (input.getAttribute('type') ?? '').toLowerCase()
    if (type === 'checkbox' || type === 'radio') parts.push(input.checked ? 'checked' : 'unchecked')
    else if (isPasswordField(el)) parts.push(input.value ? 'value=<hidden>' : 'empty')
    else if (input.value) parts.push(`value=${JSON.stringify(clean(input.value, 200))}`)
    else if (!name && input.placeholder) parts.push(`placeholder=${JSON.stringify(clean(input.placeholder))}`)
  }
  if (t === 'select') {
    const select = el as HTMLSelectElement
    const selected = select.selectedOptions[0]
    if (selected) parts.push(`value=${JSON.stringify(clean(selected.textContent))}`)
  }
  const ariaChecked = el.getAttribute('aria-checked')
  if (ariaChecked && t !== 'input') parts.push(ariaChecked === 'true' ? 'checked' : 'unchecked')
  const expanded = el.getAttribute('aria-expanded')
  if (expanded) parts.push(`expanded=${expanded}`)
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled')
  if (role === 'iframe' && !(el as HTMLIFrameElement).contentDocument) parts.push('(cross-origin content not readable)')
  return parts.join(' ')
}

function readTree(root: Element, options: WalkOptions): string {
  const lines: string[] = []
  let chars = 0
  let visited = 0
  let truncated = false

  const push = (line: string): void => {
    if (truncated) return
    if (chars + line.length + 1 > OUTPUT_CAP) {
      truncated = true
      return
    }
    lines.push(line)
    chars += line.length + 1
  }

  const visit = (el: Element, depth: number): void => {
    if (truncated || ++visited > VISIT_CAP) {
      truncated = true
      return
    }
    if (SKIP_TAGS.has(tag(el))) return
    if (isDisplayContents(el)) {
      for (const child of childrenOf(el)) visit(child, depth)
      return
    }
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return

    const role = roleOf(el)
    const box = topViewportBox(el)
    const rendered = box.width > 0 && box.height > 0
    const onscreen = rendered && inViewport(box)
    const wanted = role != null && rendered &&
      (options.filter !== 'interactive' || INTERACTIVE_ROLES.has(role)) &&
      (options.filter === 'all' || onscreen)

    let childDepth = depth
    if (wanted) {
      push(lineFor(el, role, accessibleName(el, role), depth))
      if (LEAF_ROLES.has(role)) return
      childDepth = depth + 1
      if (childDepth >= options.depth) return
    }

    if (options.filter !== 'interactive' && (options.filter === 'all' || onscreen)) {
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue
        const text = clean(node.textContent, TEXT_RUN_CAP)
        if (text) push(`${'  '.repeat(childDepth)}text ${JSON.stringify(text)}`)
      }
    }
    for (const child of childrenOf(el)) visit(child, childDepth)
  }

  visit(root, 0)
  if (lines.length === 0) {
    return options.filter === 'interactive' ? 'No visible interactive elements found.' : 'No visible elements found.'
  }
  if (truncated) {
    lines.push(`[Output truncated at ${OUTPUT_CAP} characters. Narrow it with filter="interactive", a smaller depth, or a ref.]`)
  }
  return lines.join('\n')
}

// ---- the page for a browser step (atelier-step, docs/decisions.md › Browser tasks) ----

/** Controls and text lines one step reads at most; the step model's input is cut at its own length after that. */
const STEP_ITEMS_MAX = 160
const STEP_TEXT_MAX = 160
const STEP_CONTEXT_MAX = 160
const STEP_ROW = 'li, tr, article, [role="listitem"], [role="row"], [role="article"]'
/** A field with no form of its own belongs to the region it sits in: the header's search box is not the checkout's. */
const STEP_REGION = 'form, [role="form"], fieldset, dialog, [role="dialog"], header, nav, main, aside, footer, section'

function stepRole(el: Element, role: string): StepPageItem['role'] | null {
  switch (role) {
    case 'link': return 'link'
    case 'button': case 'clickable': case 'menuitem': case 'tab': case 'option': case 'treeitem': return 'button'
    case 'textbox': case 'searchbox': case 'spinbutton': return 'field'
    case 'combobox': return tag(el) === 'select' ? 'select' : 'field'
    case 'listbox': return tag(el) === 'select' ? 'select' : null
    case 'checkbox': case 'switch': case 'menuitemcheckbox': return 'checkbox'
    case 'radio': case 'menuitemradio': return 'radio'
    default: return null
  }
}

function stepGroup(el: Element, groups: Map<Element, string>): string {
  const region = el.closest(STEP_REGION)
  if (!region) return ''
  let key = groups.get(region)
  if (!key) {
    key = `${tag(region)}-${groups.size + 1}`
    groups.set(region, key)
  }
  return key
}

function stepContext(el: Element, label: string): string | undefined {
  const row = el.parentElement?.closest(STEP_ROW)
  const text = clean((row as HTMLElement | null)?.innerText ?? '', STEP_CONTEXT_MAX + 1)
  if (!text || text === label || text.length > STEP_CONTEXT_MAX) return undefined
  return text
}

function stepItem(el: Element, role: StepPageItem['role'], groups: Map<Element, string>): StepPageItem {
  const name = accessibleName(el, roleOf(el))
  const item: StepPageItem = { ref: refFor(el), role, label: name, group: stepGroup(el, groups) }
  const t = tag(el)
  if (role === 'field') {
    const guarded = isPasswordField(el) || isPaymentField(el) || /\bone-time-code\b/i.test(el.getAttribute('autocomplete') ?? '')
    if (guarded) item.guarded = true
    const value = (el as HTMLElement).isContentEditable && t !== 'input' && t !== 'textarea' ? clean((el as HTMLElement).innerText) : (el as HTMLInputElement).value ?? ''
    // A guarded field's content never leaves the page; only whether it is filled.
    item.value = guarded ? (value ? '(filled)' : '') : clean(value, 200)
    if (!item.label) item.label = clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name'))
  } else if (role === 'select') {
    const select = el as HTMLSelectElement
    const options = Array.from(select.options)
    const chosen = select.selectedOptions[0]
    // A first option like "Choose…" with no value is nothing chosen yet.
    item.value = chosen && chosen.value !== '' ? clean(chosen.textContent) : ''
    item.options = options.filter((o) => o.value !== '' || clean(o.textContent) === '').map((o) => clean(o.textContent)).filter(Boolean).slice(0, 40)
  } else if (role === 'checkbox' || role === 'radio') {
    item.checked = t === 'input' ? (el as HTMLInputElement).checked : el.getAttribute('aria-checked') === 'true'
  } else {
    const context = stepContext(el, name)
    if (context) item.context = context
  }
  return item
}

function stepPage(): StepPage {
  const items: StepPageItem[] = []
  const groups = new Map<Element, string>()
  let visited = 0
  let unnamed = 0
  let truncated = false
  const text = (node: Node, group: string): void => {
    const s = clean(node.textContent, STEP_TEXT_MAX + 1)
    if (s.length > 1 && s.length <= STEP_TEXT_MAX && /[\p{L}\p{N}]/u.test(s)) items.push({ ref: '', role: 'text', label: s, group })
  }
  const visit = (el: Element): void => {
    if (truncated) return
    if (items.length >= STEP_ITEMS_MAX || ++visited > VISIT_CAP) {
      truncated = true
      return
    }
    if (SKIP_TAGS.has(tag(el))) return
    if (isDisplayContents(el)) {
      for (const child of childrenOf(el)) visit(child)
      return
    }
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return
    const role = roleOf(el)
    const kind = role ? stepRole(el, role) : null
    if (kind && role && isRendered(el)) {
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
      if (!disabled) {
        const item = stepItem(el, kind, groups)
        if (item.label || kind === 'field' || kind === 'select') items.push(item)
        else if ((kind === 'button' || kind === 'link') && unnamed < STEP_UNNAMED_MAX) {
          // No name anywhere (a button with only an icon): its box goes along, so its picture can name it. Only one
          // that is whole in the viewport and the size of a control, not a banner that happens to be a link.
          const r = topViewportBox(el)
          const whole = r.left >= 0 && r.top >= 0 && r.left + r.width <= window.innerWidth && r.top + r.height <= window.innerHeight
          if (whole && r.width >= 12 && r.height >= 12 && r.width <= 160 && r.height <= 160) {
            unnamed++
            items.push({ ...item, box: { x: r.left, y: r.top, width: r.width, height: r.height } })
          }
        }
      }
      // A control's own text is its label, and a select's options are listed with it.
      if (LEAF_ROLES.has(role) || kind === 'select') return
    }
    for (const node of Array.from(el.childNodes)) if (node.nodeType === Node.TEXT_NODE) text(node, '')
    for (const child of childrenOf(el)) visit(child)
  }
  visit(document.body ?? document.documentElement)
  const lang = clean(document.documentElement.lang, 20)
  return { items, truncated, ...(lang ? { lang } : {}) }
}

// ---- find ----

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'on', 'in', 'at', 'with', 'and', 'or', 'that', 'this', 'element', 'page'])
const ROLE_SYNONYMS: Record<string, string[]> = {
  field: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  input: ['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio'],
  box: ['textbox', 'searchbox', 'combobox', 'checkbox'],
  textbox: ['textbox', 'searchbox'],
  search: ['searchbox'],
  dropdown: ['combobox', 'listbox'],
  select: ['combobox', 'listbox'],
  menu: ['menuitem', 'combobox'],
  checkbox: ['checkbox', 'switch'],
  toggle: ['switch', 'checkbox'],
  button: ['button', 'clickable'],
  link: ['link'],
  tab: ['tab'],
  image: ['img'],
  picture: ['img'],
  heading: ['heading'],
  title: ['heading'],
}

function collectCandidates(root: Element): Candidate[] {
  const out: Candidate[] = []
  let visited = 0
  const visit = (el: Element): void => {
    if (++visited > VISIT_CAP || SKIP_TAGS.has(tag(el))) return
    if (!isDisplayContents(el) && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return
    const role = roleOf(el)
    if (role && (INTERACTIVE_ROLES.has(role) || role === 'heading' || role === 'img' || role === 'dialog') && isRendered(el)) {
      out.push({ el, role, name: accessibleName(el, role), onscreen: inViewport(topViewportBox(el)) })
      if (LEAF_ROLES.has(role)) return
    }
    for (const child of childrenOf(el)) visit(child)
  }
  visit(root)
  return out
}

function find(query: string): string {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOPWORDS.has(t))
  if (tokens.length === 0) return 'The query has no searchable words.'
  const scored = collectCandidates(document.documentElement).map((candidate, order) => {
    const name = candidate.name.toLowerCase()
    const attrs = ['placeholder', 'name', 'id', 'type', 'title', 'aria-describedby', 'class']
      .map((a) => candidate.el.getAttribute(a) ?? '').join(' ').toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (new RegExp(`\\b${escapeRegExp(token)}\\b`, 'u').test(name)) score += 4
      else if (name.includes(token)) score += 3
      if (candidate.role === token || ROLE_SYNONYMS[token]?.includes(candidate.role)) score += 2
      if (attrs.includes(token)) score += 1
    }
    return { candidate, score, order }
  })
  const matches = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.candidate.onscreen) - Number(a.candidate.onscreen) || a.order - b.order)
    .slice(0, 20)
  if (matches.length === 0) return `No elements matching ${JSON.stringify(query)} were found. Try read_page.`
  return matches.map(({ candidate }) => lineFor(candidate.el, candidate.role, candidate.name, 0)).join('\n')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---- get_page_text ----

function mainContentRoot(): HTMLElement {
  const main = document.querySelector<HTMLElement>('main, [role="main"]')
  if (main && clean(main.innerText).length > 200) return main
  let best: HTMLElement | null = null
  for (const article of Array.from(document.querySelectorAll<HTMLElement>('article'))) {
    if (!best || article.innerText.length > best.innerText.length) best = article
  }
  if (best && clean(best.innerText).length > 200) return best
  return document.body
}

function pageText(): string {
  const root = mainContentRoot()
  const text = (root.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const header = `Title: ${document.title}\nURL: ${location.href}\n\n`
  if (!text) return `${header}(The page has no visible text.)`
  const capped = text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n[Text truncated at ${OUTPUT_CAP} characters.]` : text
  return header + capped
}

// ---- actions ----

function resolveRef(ref: string, scrollIntoView: boolean): ResolvedElement {
  const el = lookup(ref)
  if (scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const box = topViewportBox(el)
  if (box.width === 0 && box.height === 0) throw new Error(`${ref} is not visible on the page.`)
  return { ...describe(el), x: box.left + box.width / 2, y: box.top + box.height / 2, box: { x: box.left, y: box.top, width: box.width, height: box.height } }
}

function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y)
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

function describePoint(x: number, y: number): ElementDescription | null {
  let el = deepElementFromPoint(x, y)
  for (let hops = 0; el && hops < 6; hops++, el = el.parentElement) {
    const role = roleOf(el)
    if (role && INTERACTIVE_ROLES.has(role)) return describe(el)
  }
  const hit = deepElementFromPoint(x, y)
  return hit ? describe(hit) : null
}

function focusedElement(): Element | null {
  let el: Element | null = document.activeElement
  while (el) {
    const inner = el.shadowRoot?.activeElement ?? (tag(el) === 'iframe' ? (el as HTMLIFrameElement).contentDocument?.activeElement : null)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  // The prototype setter writes the DOM value directly. Frameworks such as
  // React compare it against their own tracked value and fire onChange.
  const proto = Object.getPrototypeOf(el) as object
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function formInput(ref: string, value: string | number | boolean): FormInputResult {
  const el = lookup(ref)
  const description = describe(el)
  if (description.isPassword) throw new Error(`${BRAND_NAME} does not let the agent enter passwords. Ask the user to type it.`)
  if (description.isPaymentField) throw new Error(`${BRAND_NAME} does not let the agent enter payment card details. Ask the user to fill them in.`)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  const t = tag(el)

  if (t === 'select') {
    const select = el as HTMLSelectElement
    const wanted = String(value).toLowerCase()
    const option = Array.from(select.options).find((o) => o.value.toLowerCase() === wanted) ??
      Array.from(select.options).find((o) => clean(o.textContent).toLowerCase() === wanted)
    if (!option) throw new Error(`No option ${JSON.stringify(String(value))} in ${ref}. Options: ${Array.from(select.options, (o) => JSON.stringify(clean(o.textContent))).join(', ')}`)
    setNativeValue(select, option.value)
    return { needsInsertText: false, description }
  }

  if (t === 'input') {
    const input = el as HTMLInputElement
    const type = (input.getAttribute('type') ?? 'text').toLowerCase()
    if (type === 'file') throw new Error(`File inputs need file_upload, which ${BRAND_NAME} does not enable.`)
    if (type === 'checkbox' || type === 'radio') {
      if (typeof value !== 'boolean') throw new Error(`${ref} is a ${type}; pass true or false.`)
      if (input.checked !== value) input.click()
      return { needsInsertText: false, description }
    }
    input.focus()
    setNativeValue(input, String(value))
    return { needsInsertText: false, description }
  }

  if (t === 'textarea') {
    const area = el as HTMLTextAreaElement
    area.focus()
    setNativeValue(area, String(value))
    return { needsInsertText: false, description }
  }

  if ((el as HTMLElement).isContentEditable) {
    const html = el as HTMLElement
    html.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(html)
    selection?.removeAllRanges()
    selection?.addRange(range)
    return { needsInsertText: true, description }
  }

  const role = roleOf(el)
  if (role === 'checkbox' || role === 'switch' || role === 'radio') {
    if (typeof value !== 'boolean') throw new Error(`${ref} is a ${role}; pass true or false.`)
    if ((el.getAttribute('aria-checked') === 'true') !== value) (el as HTMLElement).click()
    return { needsInsertText: false, description }
  }
  throw new Error(`${ref} (${description.role}) is not a form field. Use left_click and type instead.`)
}

function viewport(): ViewportInfo {
  return { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY }
}

function run(command: PageCommand): unknown {
  switch (command.op) {
    case 'readPage': {
      const root = command.ref ? lookup(command.ref) : document.documentElement
      return readTree(root, { filter: command.filter, depth: Math.max(1, command.depth) })
    }
    case 'find': return find(command.query)
    case 'getText': return pageText()
    case 'resolveRef': return resolveRef(command.ref, command.scrollIntoView)
    case 'describePoint': return describePoint(command.x, command.y)
    case 'describeFocus': {
      const el = focusedElement()
      return el && el !== document.body ? describe(el) : null
    }
    case 'formInput': return formInput(command.ref, command.value)
    case 'stepPage': return stepPage()
    case 'viewport': return viewport()
    case 'frame': return nextFrames(2)
  }
}

/** Resolves once the page has rendered new frames, proving it is painting. */
function nextFrames(count: number): Promise<true> {
  return new Promise((resolve) => {
    const step = (remaining: number): void => {
      if (remaining === 0) resolve(true)
      else requestAnimationFrame(() => step(remaining - 1))
    }
    step(count)
  })
}

export function installBridge(): void {
  ipcRenderer.on(PAGE.command, (_event, request: PageRequest) => {
    const reply = (message: PageReply): void => ipcRenderer.send(PAGE.reply, message)
    new Promise<unknown>((resolve) => resolve(run(request.command))).then(
      (result) => reply({ requestId: request.requestId, ok: true, result }),
      (err: unknown) => reply({ requestId: request.requestId, ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
  })
}
