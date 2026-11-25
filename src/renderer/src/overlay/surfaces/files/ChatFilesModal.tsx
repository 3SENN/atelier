/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, FileText, Folder, FolderOpen, X } from 'lucide-react'
import type { ChatFileEntry, ChatFileFolder } from '@shared/chatContext'
import { CHAT_FILE_FOLDERS } from '@shared/chatContext'
import type { FilesSurfaceProps } from '@shared/overlay/files'
import { kindLabelKey } from '@shared/fileKinds'
import { compactCount, parentFolder } from '@shared/filesLogic'
import { t } from '@shared/i18n/core'
import { call, errorText, formatBytes } from '../../../api'
import { FilePreview } from '../../../files/preview/FilePreview'
import { useViewerDoc } from '../../../files/useViewerDoc'
import { Button, EmptyState, ErrorState, IconButton, SkeletonRows, cx, toast, useRovingFocus } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { windowViewport } from '../../host/windowSize'
import './files.css'

// The chat files modal (CH-28): everything a chat gathered, as folders
// (tabs it read, attachments, messages, tool results, context, generated
// files), with back navigation, sizes and character counts. A file previews
// with the shared renderers; one that can't gets Show in Finder when it is a
// real file. Esc or the close button dismisses it.

const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })

function isFolder(name: string): name is ChatFileFolder {
  return (CHAT_FILE_FOLDERS as readonly string[]).includes(name)
}

/** A folder's display name: the six fixed folders are named; deeper ones keep their own. */
function folderLabel(path: string): string {
  return isFolder(path) ? t(`files.chat.folder.${path}`) : (path.split('/').pop() ?? path)
}

function Preview({ chatId, entry }: { chatId: string; entry: ChatFileEntry }): ReactElement {
  const { doc, error, loading, reload } = useViewerDoc({ kind: 'chat-file', chatId, path: entry.path })
  const reveal = entry.revealable ? (
    <Button size="sm" variant="secondary" icon={<FolderOpen />} onClick={() => void call('chatFiles', 'reveal', chatId, entry.path).catch(fail)}>
      {t('files.action.reveal')}
    </Button>
  ) : null
  if (!doc) {
    if (loading) return <SkeletonRows rows={4} label={t('files.viewer.loading')} />
    return <ErrorState compact title={t('files.viewer.loadFailed')} message={error ?? undefined} onRetry={reload} retryLabel={t('files.action.retry')} action={reveal} />
  }
  const drawable = !['binary', 'unknown'].includes(doc.previewable)
  return (
    <div className="fc-preview">
      {drawable ? <FilePreview compact doc={doc} onRetry={reload} /> : <EmptyState compact icon={<FileText />} title={entry.name} description={t('files.chat.noPreview')} />}
      {reveal && <div className="fc-preview__actions">{reveal}</div>}
    </div>
  )
}

export function ChatFilesModalSurface({ props, close, reportBounds, exiting }: SurfaceComponentProps<FilesSurfaceProps['chat-files-modal']>): ReactElement {
  const titleId = useId()
  const list = useRef<HTMLUListElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [folder, setFolder] = useState(props.folder ?? '')
  const [entries, setEntries] = useState<ChatFileEntry[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ChatFileEntry | null>(null)
  // Where focus goes back to after Back: the row that was opened.
  const returnTo = useRef<string | null>(null)
  const onListKey = useRovingFocus(list, { selector: '.fc-row__open', orientation: 'vertical' })

  useLayoutEffect(() => {
    reportBounds({ x: 0, y: 0, width: windowViewport().width, height: windowViewport().height })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setEntries(null)
    setError(null)
    try {
      const items = await call('chatFiles', 'list', props.chatId, folder)
      setEntries(items)
      if (folder === '') {
        // Folders show how many items they hold.
        const pairs = await Promise.all(items.filter((e) => e.kind === 'folder').map(async (e) => [e.path, (await call('chatFiles', 'list', props.chatId, e.path).catch(() => [])).length] as const))
        setCounts(Object.fromEntries(pairs))
      }
    } catch (err) {
      setError(errorText(err))
    }
  }, [props.chatId, folder])

  useEffect(() => {
    void load()
  }, [load])

  // Focus the first row (or the one we came back to) once a list is in.
  useEffect(() => {
    if (!entries || preview) return
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('.fc-row__open') ?? [])]
    const target = rows.find((r) => r.dataset.path === returnTo.current) ?? rows[0]
    ;(target ?? panel.current)?.focus()
    returnTo.current = null
  }, [entries, preview])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const back = (): void => {
    if (preview) {
      returnTo.current = preview.path
      setPreview(null)
      return
    }
    returnTo.current = folder
    setFolder(parentFolder(folder))
  }
  const openEntry = (entry: ChatFileEntry): void => {
    if (entry.kind === 'folder') {
      setFolder(entry.path)
      return
    }
    setPreview(entry)
  }

  const title = preview ? preview.name : folder ? folderLabel(folder) : t('files.chat.title')
  const canGoBack = preview !== null || folder !== ''

  let body: ReactElement
  if (preview) body = <Preview chatId={props.chatId} entry={preview} />
  else if (error) body = <ErrorState compact message={error} onRetry={load} retryLabel={t('files.action.retry')} />
  else if (!entries) body = <SkeletonRows rows={5} label={t('files.chat.loading')} />
  else if (entries.length === 0) {
    body = folder ? <EmptyState compact icon={<Folder />} title={t('files.chat.folderEmpty')} /> : <EmptyState icon={<FolderOpen />} title={t('files.chat.empty.title')} description={t('files.chat.empty.description')} />
  } else {
    body = (
      <ul ref={list} className="fc-list" onKeyDown={onListKey} aria-label={title}>
        {entries.map((entry) => {
          const isDir = entry.kind === 'folder'
          const count = counts[entry.path]
          const meta = isDir
            ? [count !== undefined ? t('files.chat.items', { count }) : null, entry.size > 0 ? formatBytes(entry.size) : null]
            : [formatBytes(entry.size), entry.chars !== null ? t('files.chat.chars', { count: compactCount(entry.chars) }) : null, t(kindLabelKey(entry.previewable))]
          return (
            <li key={entry.path} className="fc-row">
              <button type="button" className="fc-row__open" data-path={entry.path} onClick={() => openEntry(entry)}>
                <span className="fc-row__icon" aria-hidden>
                  {isDir ? <Folder /> : <FileText />}
                </span>
                <span className="fc-row__name">{isDir ? folderLabel(entry.path) : entry.name}</span>
                <span className="fc-row__meta">{meta.filter(Boolean).join(' · ')}</span>
                {isDir && <ChevronRight className="fc-row__chevron" aria-hidden />}
              </button>
              {!isDir && entry.revealable && <IconButton size="sm" label={`${t('files.action.reveal')}: ${entry.name}`} icon={<FolderOpen />} onClick={() => void call('chatFiles', 'reveal', props.chatId, entry.path).catch(fail)} />}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className={cx('ui-modal', 'ui-modal--center', 'fc-surface')} data-state={exiting ? 'closing' : 'open'}>
      <div className="ui-modal__scrim" aria-hidden="true" onClick={close} />
      <div ref={panel} tabIndex={-1} className="ui-modal__panel ui-dialog ui-dialog--lg fc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="ui-dialog__header fc-dialog__header">
          {canGoBack && <IconButton size="sm" label={t('files.chat.back')} tooltip={false} icon={<ChevronLeft />} onClick={back} />}
          <h2 id={titleId} className={cx('ui-dialog__title', 'fc-dialog__title')}>
            {title}
          </h2>
          <IconButton label={t('files.action.close')} tooltip={false} size="sm" icon={<X />} onClick={close} className="ui-dialog__close" />
        </header>
        <div className="ui-dialog__body fc-dialog__body">{body}</div>
      </div>
    </div>
  )
}
