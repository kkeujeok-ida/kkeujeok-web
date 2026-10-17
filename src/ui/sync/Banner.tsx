// The one banner slot at the top of the library and of the writing screen (UX-DR40).
// No close button; it goes away when its state ends. It is the first element of its
// screen, so it is first in reading order and the first F6 region.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n, type Key } from '../../i18n'
import type { BannerKind } from './bannerPriority'
import { useBannerKind, useNoteConflicts, useSyncUi } from './syncUi'

export const DRIVE_STORAGE_URL = 'https://drive.google.com/settings/storage'

const TEXT: Partial<Record<BannerKind, Key>> = {
  conflictReadOnly: 'banner.conflict',
  otherTab: 'editor.otherTab',
  deleted: 'banner.deleted',
  newVersion: 'banner.newVersion',
  reauth: 'banner.reauth',
  quota: 'banner.quota',
  offline: 'banner.offline',
}

const ICON: Record<BannerKind, string> = {
  conflictReadOnly: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.5v.5',
  otherTab: 'M3 3h10v10h-10zM3 6h10',
  deleted: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  newVersion: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5v4M8 10.5v.5',
  reauth: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5v4M8 10.5v.5',
  quota: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5v4M8 10.5v.5',
  offline: 'M2 13h9.5a3 3 0 00.5-5.95A4.5 4.5 0 004 6.5 3.25 3.25 0 002 13zM2 2l12 12',
}

/** How long the banner stays emphasized after a blocked write (UX-DR65). */
export const EMPHASIS_MS = 800

export function Banner({
  otherTab = false,
  noteId,
  onClose,
  pulse = 0,
}: {
  otherTab?: boolean
  noteId?: string
  onClose?: () => void
  /** Grows by one for every blocked write on a conflict page: the banner is emphasized once for each. */
  pulse?: number
}) {
  const { t } = useI18n()
  const ui = useSyncUi()
  const kind = useBannerKind(otherTab, noteId)
  const [reviving, setReviving] = useState(false)
  const working = useRef(false) // [다시 살리기] in flight: a second press is ignored
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  const conflicts = useNoteConflicts(noteId)
  const [emphasis, setEmphasis] = useState(false)
  useEffect(() => {
    if (pulse === 0) return
    setEmphasis(true)
    const id = setTimeout(() => setEmphasis(false), EMPHASIS_MS)
    return () => clearTimeout(id)
  }, [pulse])
  // A page the other device deleted has its own words; mixed conflicts use the general ones.
  const onlyDeleted = !!conflicts && conflicts.length > 0 && conflicts.every((c) => c.kind === 'remoteDeleted')
  const key = kind === 'conflictReadOnly' && onlyDeleted ? 'banner.conflictDeleted' : kind ? TEXT[kind] : undefined
  if (!kind || !key) return null
  async function revive() {
    if (working.current || !ui || noteId === undefined) return
    working.current = true
    setReviving(true)
    try {
      await ui.revive(noteId)
    } catch {
      // the banner stays while the note is still deleted
    } finally {
      working.current = false
      if (mounted.current) setReviving(false)
    }
  }
  let action: ReactNode = null
  if (kind === 'deleted' && noteId !== undefined) {
    action = (
      <>
        <button type="button" className="btn" aria-disabled={reviving} aria-busy={reviving} onClick={() => void revive()}>
          {t('banner.deleted.revive')}
        </button>
        {onClose && (
          <button type="button" className="btn" onClick={onClose}>
            {t('banner.deleted.close')}
          </button>
        )}
      </>
    )
  } else if (kind === 'conflictReadOnly' && noteId !== undefined) {
    const resolve = ui?.resolve
    action = (
      <button type="button" className="btn" aria-disabled={!resolve} onClick={() => resolve?.(noteId)}>
        {t('banner.conflict.resolve')}
      </button>
    )
  } else if (kind === 'reauth' && ui?.auth.reauth) {
    action = (
      <button type="button" className="btn" aria-disabled={ui.reauthBusy} aria-busy={ui.reauthBusy} onClick={() => ui.reauth()}>
        {t('drive.reauthAction')}
      </button>
    )
  } else if (kind === 'quota') {
    action = (
      <a className="btn" href={DRIVE_STORAGE_URL} target="_blank" rel="noopener noreferrer">
        {t('sync.manageStorage')}
      </a>
    )
  }
  // A full Drive is announced at once (UX-DR85); the others politely.
  const live = kind === 'quota' ? { role: 'alert' } : { role: 'status', 'aria-live': 'polite' as const }
  return (
    <div
      className={emphasis ? 'editor-banner is-emphasis' : 'editor-banner'}
      data-banner={kind}
      {...(emphasis && { 'data-emphasis': 'true' })}
      tabIndex={-1}
      {...live}
    >
      <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d={ICON[kind]} stroke="currentColor" strokeWidth="1.5" fill="none" />
      </svg>
      <span className="editor-banner-text">{t(key)}</span>
      {action}
    </div>
  )
}
