import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useI18n } from '../i18n'
import { HelpList } from './Help'
import { SHORTCUT_GROUPS } from './helpData'

/** Modal shortcut list. Esc closes it and focus goes back to where it was. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null
    close.current?.focus()
    return () => from?.focus()
  }, [])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') e.preventDefault() // the close button is the only stop
  }
  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      <div className="dialog shortcut-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <h2 id="sheet-title">{t('help.sheet')}</h2>
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title}>
            <h3>{t(g.title)}</h3>
            <HelpList rows={g.rows} />
          </div>
        ))}
        <div className="dialog-actions">
          <button ref={close} type="button" className="btn" onClick={onClose}>
            {t('help.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
