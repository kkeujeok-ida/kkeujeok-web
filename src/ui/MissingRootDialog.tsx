import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { useI18n } from '../i18n'

type Props = { onCreate: () => void; onLater: () => void; onSignOut: () => void }

// The Kkeujeok folder is gone from Drive (Story 3.10). Buttons in the order
// [새로 만들기][나중에][로그아웃]; focus starts on the first and is trapped; Esc = later.
export function MissingRootDialog({ onCreate, onLater, onSignOut }: Props) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  const ids = { title: useId(), body: useId() }
  useEffect(() => first.current?.focus(), [])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onLater()
    } else if (e.key === 'Tab') {
      const items = [...box.current!.querySelectorAll<HTMLElement>('button')]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length
      e.preventDefault()
      items[next]?.focus()
    }
  }
  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={ids.title} aria-describedby={ids.body}>
        <h2 id={ids.title} className="dialog-title">
          {t('rootMissing.title')}
        </h2>
        <p id={ids.body}>{t('rootMissing.body')}</p>
        <div className="dialog-actions">
          <button ref={first} type="button" className="btn" onClick={onCreate}>
            {t('rootMissing.create')}
          </button>
          <button type="button" className="btn" onClick={onLater}>
            {t('rootMissing.later')}
          </button>
          <button type="button" className="btn" onClick={onSignOut}>
            {t('rootMissing.signOut')}
          </button>
        </div>
      </div>
    </div>
  )
}
