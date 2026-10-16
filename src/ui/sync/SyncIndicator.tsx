// The sync indicator of the writing screen (icon-only button + status popover) and the
// badge of a library card (Story 3.16, UX-DR37..39, UX-DR60). The label always comes
// from `sync.stateMachine` display; this file only draws it.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'
import type { DisplayLabel } from '../../sync/syncRules'
import { downloadBlob } from '../download'
import { DRIVE_STORAGE_URL } from './Banner'
import { useAnnouncement, useDisplayLabel } from './useDisplayLabel'
import { useNoteSync, useSyncUi, type NoteSyncDisplay } from './syncUi'

export const LABEL_KEY: Record<DisplayLabel, Key> = {
  saved: 'sync.label.saved',
  pending: 'sync.label.pending',
  offline: 'sync.label.pending', // the web never shows it
  saving: 'sync.label.saving',
  receiving: 'sync.receivingLatest',
  twoVersions: 'sync.label.twoVersions',
  notSaved: 'sync.label.notSaved',
}
/** The card badge says "받는 중" where the indicator says "최신 내용 받는 중". */
export const BADGE_KEY: Record<DisplayLabel, Key> = { ...LABEL_KEY, receiving: 'sync.receiving' }
const DETAIL_KEY: Record<DisplayLabel, Key> = {
  saved: 'sync.detail.saved',
  pending: 'sync.detail.pending',
  offline: 'sync.detail.pending',
  saving: 'sync.detail.saving',
  receiving: 'sync.detail.receiving',
  twoVersions: 'sync.detail.twoVersions',
  notSaved: 'sync.detail.notSaved',
}

const PATH: Record<DisplayLabel, string> = {
  saved: 'M3 8.5l3 3 7-7',
  pending: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5V8l2.5 1.5',
  offline: 'M2 13h9.5a3 3 0 00.5-5.95A4.5 4.5 0 004 6.5 3.25 3.25 0 002 13zM2 2l12 12',
  saving: 'M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3',
  receiving: 'M8 3v9M4 8l4 4 4-4',
  twoVersions: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.5v.5',
  notSaved: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5v4M8 10.5v.5',
}

export function SyncIcon({ label }: { label: DisplayLabel }) {
  return (
    <svg className={label === 'saving' ? 'icon sync-spin' : 'icon'} viewBox="0 0 16 16" aria-hidden="true">
      <path d={PATH[label]} stroke="currentColor" strokeWidth="1.75" fill="none" />
    </svg>
  )
}

/** The status of a card for its accessible description; empty for `saved`. */
export function useCardStatus(noteId: string): { label: DisplayLabel | null } {
  const s = useNoteSync(noteId)
  return { label: s && s.label !== 'saved' ? s.label : null }
}

export function SyncBadge({ label }: { label: DisplayLabel }) {
  const { t } = useI18n()
  return (
    <span className={`cover-badge sync-badge sync-badge-${label}`} data-sync={label}>
      <SyncIcon label={label} />
      <span>{t(BADGE_KEY[label])}</span>
    </span>
  )
}

/** Icon-only button in the corner cluster; renders nothing until the note's state is known. */
export function SyncIndicator({ noteId }: { noteId: string }) {
  const sync = useNoteSync(noteId)
  return sync ? <Indicator noteId={noteId} sync={sync} /> : null
}

function Indicator({ noteId, sync }: { noteId: string; sync: NonNullable<NoteSyncDisplay> }) {
  const { t } = useI18n()
  const ui = useSyncUi()!
  const label = useDisplayLabel(sync.label)
  const text = (l: DisplayLabel) => t(LABEL_KEY[l])
  const said = useAnnouncement(label, text)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const working = useRef(false) // an action in flight: a second press is ignored
  const popId = useId()
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  // Esc and a press outside close it; focus goes to the first action when it opens.
  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLElement>('button, a')?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    const onPress = (e: PointerEvent) => {
      const n = e.target as Node
      if (box.current?.contains(n) || button.current?.contains(n)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress, true)
    }
  }, [open])

  const onBoxKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const items = [...box.current!.querySelectorAll<HTMLElement>('button, a')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.shiftKey ? i <= 0 : i === items.length - 1) {
      e.preventDefault() // the popover is small: Tab wraps inside it, Esc leaves
      items[e.shiftKey ? items.length - 1 : 0]?.focus()
    }
  }

  async function syncNow() {
    if (working.current) return
    working.current = true
    setBusy(true)
    try {
      await ui.uploads?.syncNow?.(noteId)
    } finally {
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function exportLog() {
    if (working.current) return
    working.current = true
    setExportFailed(false)
    try {
      const { name, text: body } = await ui.exportLog()
      downloadBlob(name, body, 'application/x-ndjson')
    } catch {
      if (mounted.current) setExportFailed(true)
    } finally {
      working.current = false
    }
  }

  const name = fmt(t('sync.indicator.name'), { label: text(label) })
  const detailKey: Key =
    label === 'notSaved' ? (sync.reason === 'quota' ? 'sync.detail.quota' : sync.reason === 'reauth' ? 'sync.detail.reauth' : 'sync.detail.notSaved') : DETAIL_KEY[label]
  return (
    <div className="sync-indicator">
      <button
        ref={button}
        type="button"
        className={`btn editor-back sync-indicator-button sync-${label}`}
        aria-label={name}
        title={text(label)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <SyncIcon label={label} />
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {said.polite}
      </span>
      <span role="alert" className="sr-only">
        {said.assertive}
      </span>
      {open && (
        <div ref={box} id={popId} role="group" aria-label={text(label)} className="sync-popover" onKeyDown={onBoxKey}>
          <p>{t(detailKey)}</p>
          <div className="sync-popover-actions">
            <button type="button" className="btn" aria-disabled={busy} aria-busy={busy} onClick={() => void syncNow()}>
              {t('sync.syncNow')}
            </button>
            {label === 'notSaved' && (
              <>
                <button type="button" className="btn" aria-disabled={busy} onClick={() => void syncNow()}>
                  {t('sync.retry')}
                </button>
                <button type="button" className="btn" onClick={() => void exportLog()}>
                  {t('settings.syncLogExport')}
                </button>
              </>
            )}
            {label === 'notSaved' && sync.reason === 'quota' && (
              <a className="btn" href={DRIVE_STORAGE_URL} target="_blank" rel="noopener noreferrer">
                {t('sync.manageStorage')}
              </a>
            )}
          </div>
          {exportFailed && <p role="alert">{t('settings.syncLogExportFailed')}</p>}
        </div>
      )}
    </div>
  )
}
