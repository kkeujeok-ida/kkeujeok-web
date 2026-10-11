import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { createNewNoteDefaults, type Background, type NewNoteDefaults, type Orientation } from '../../storage/newNoteDefaults'
import { openNoteStore, type NoteStore } from '../../storage/noteStore'
import { LibraryFab } from './LibraryFab'
import { NewNoteDialog } from './NewNoteDialog'
import { noteHref } from './NoteEditorStub'
import { useLibrary, type LibraryItem } from './useLibrary'

// One per page session, so what was created last wins over a failed save.
let shared: ReturnType<typeof createNewNoteDefaults> | undefined
const sharedDefaults = () => (shared ??= createNewNoteDefaults())
const defaultOpenStore = () => openNoteStore()

type Props = {
  openStore?: () => NoteStore
  defaults?: { read(): NewNoteDefaults; write(d: NewNoteDefaults): void }
  editedBy?: string
}

function formatDate(ms: number | null, locale: string): string {
  if (ms === null) return ''
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms))
  } catch {
    return ''
  }
}

export function Library({ openStore = defaultOpenStore, defaults = sharedDefaults(), editedBy }: Props) {
  const { t, locale } = useI18n()
  const lib = useLibrary(openStore, defaults, editedBy)
  const [sheet, setSheet] = useState<NewNoteDefaults | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const entering = useRef(false) // a note was created and the editor is opening
  const wasOpen = useRef(false)
  const section = useRef<HTMLElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Opening again while a sheet is open or the editor is opening does nothing.
  const openSheet = (from: HTMLElement | null) => {
    if (entering.current || sheet || lib.status !== 'ready') return
    opener.current = from
    setSheet(defaults.read())
  }

  // Closing the sheet hands focus back to the button that opened it.
  useEffect(() => {
    if (wasOpen.current && !sheet && !entering.current) {
      // The opener may be gone (its card replaced); the fab is always there.
      const target = opener.current?.isConnected ? opener.current : section.current?.querySelector<HTMLElement>('.fab-button')
      target?.focus()
    }
    wasOpen.current = sheet !== null
  }, [sheet])

  async function create(v: { title: string; background: Background; orientation: Orientation }) {
    if (entering.current) return true
    try {
      const noteId = await lib.create(v)
      if (!mounted.current) return true // the library went away; the note is saved
      entering.current = true
      setSheet(null)
      globalThis.location.hash = noteHref(noteId)
      return true
    } catch (e) {
      console.warn('Could not create the note', e)
      return false
    }
  }

  const { items, status } = lib
  return (
    <section ref={section} className="library" aria-label={t('library.label')} aria-busy={status === 'loading'}>
      <ul className="cover-grid">
        {status === 'loading' && (
          <li className="cover-status" role="status">
            {t('library.loading')}
          </li>
        )}
        {(status === 'error' || lib.failed) && (
          <li className="cover-status" role="alert">
            <span>{t('library.loadFailed')}</span>
            <button type="button" className="btn" onClick={() => void lib.reload()}>
              {t('library.retry')}
            </button>
          </li>
        )}
        {status === 'ready' && items.length === 0 && (
          <li>
            <button type="button" className="cover-card" onClick={(e) => openSheet(e.currentTarget)}>
              <span className="cover-thumb cover-thumb-new" aria-hidden="true">
                <svg className="icon" viewBox="0 0 16 16">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.75" fill="none" />
                </svg>
              </span>
              <span className="cover-title">{t('library.newNote')}</span>
            </button>
          </li>
        )}
        {items.map((item) => (
          <Card key={item.noteId} item={item} locale={locale} blocked={() => entering.current} />
        ))}
      </ul>
      {status === 'ready' && <LibraryFab onNewNote={openSheet} />}
      {sheet && (
        <NewNoteDialog
          defaults={sheet}
          onCreate={create}
          onClose={() => {
            if (!entering.current) setSheet(null)
          }}
        />
      )}
    </section>
  )
}

function Card({ item, locale, blocked }: { item: LibraryItem; locale: string; blocked: () => boolean }) {
  const { t } = useI18n()
  const titleId = useId()
  const dateId = useId()
  if (item.title === null) {
    return (
      <li>
        <div className="cover-card cover-card-disabled">
          <span className="cover-thumb" aria-hidden="true" />
          <span className="cover-title">{t('library.cannotOpen')}</span>
        </div>
      </li>
    )
  }
  const date = formatDate(item.editedMs, locale)
  return (
    <li>
      <a
        className="cover-card"
        href={noteHref(item.noteId)}
        aria-labelledby={titleId}
        aria-describedby={date ? dateId : undefined}
        title={item.title}
        onClick={(e) => blocked() && e.preventDefault()}
      >
        <span className="cover-thumb" aria-hidden="true" />
        <span id={titleId} className="cover-title">
          {item.title}
        </span>
        {date && (
          <span id={dateId} className="cover-date">
            {date}
          </span>
        )}
      </a>
    </li>
  )
}
