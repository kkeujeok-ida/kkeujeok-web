import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'

// The round "+" at the bottom right. It expands a menu holding only [new note].
// Focus: first item when opened, back on "+" when closed by Esc, x or outside press.
export function LibraryFab({ onNewNote }: { onNewNote: (opener: HTMLElement | null) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const collapse = () => {
    setOpen(false)
    button.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const onMenuKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1
    items[next]?.focus()
  }

  return (
    <>
      {open && <div className="fab-veil" onClick={collapse} />}
      <div className="fab">
        {open && (
          <div ref={menu} className="fab-menu" role="menu" onKeyDown={onMenuKeyDown}>
            <button
              type="button"
              role="menuitem"
              className="fab-item"
              onClick={() => {
                setOpen(false)
                onNewNote(button.current)
              }}
            >
              <span>{t('library.newNote')}</span>
              <span className="fab-item-icon" aria-hidden="true">
                <svg className="icon" viewBox="0 0 16 16">
                  <path d="M3 2h7l3 3v9H3z M5 8h6 M5 11h6" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              </span>
            </button>
          </div>
        )}
        <button
          ref={button}
          type="button"
          className="fab-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t(open ? 'library.closeMenu' : 'library.addNote')}
          onClick={() => (open ? collapse() : setOpen(true))}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" fill="none" />
          </svg>
        </button>
      </div>
    </>
  )
}
