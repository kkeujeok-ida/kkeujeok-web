// The one banner slot at the top of the library and of the writing screen (UX-DR40).
// No close button; it goes away when its state ends. It is the first element of its
// screen, so it is first in reading order and the first F6 region.
import type { ReactNode } from 'react'
import { useI18n, type Key } from '../../i18n'
import type { BannerKind } from './bannerPriority'
import { useBannerKind, useSyncUi } from './syncUi'

export const DRIVE_STORAGE_URL = 'https://drive.google.com/settings/storage'

const TEXT: Partial<Record<BannerKind, Key>> = {
  otherTab: 'editor.otherTab',
  reauth: 'banner.reauth',
  quota: 'banner.quota',
  offline: 'banner.offline',
}

const ICON: Record<BannerKind, string> = {
  conflictReadOnly: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.5v.5',
  otherTab: 'M3 3h10v10h-10zM3 6h10',
  reauth: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5v4M8 10.5v.5',
  quota: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5v4M8 10.5v.5',
  offline: 'M2 13h9.5a3 3 0 00.5-5.95A4.5 4.5 0 004 6.5 3.25 3.25 0 002 13zM2 2l12 12',
}

export function Banner({ otherTab = false }: { otherTab?: boolean }) {
  const { t } = useI18n()
  const ui = useSyncUi()
  const kind = useBannerKind(otherTab)
  const key = kind ? TEXT[kind] : undefined
  if (!kind || !key) return null
  let action: ReactNode = null
  if (kind === 'reauth' && ui?.auth.reauth) {
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
    <div className="editor-banner" data-banner={kind} tabIndex={-1} {...live}>
      <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d={ICON[kind]} stroke="currentColor" strokeWidth="1.5" fill="none" />
      </svg>
      <span className="editor-banner-text">{t(key)}</span>
      {action}
    </div>
  )
}
