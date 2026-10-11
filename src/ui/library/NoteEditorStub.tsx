import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { openNoteStore, type NoteStore } from '../../storage/noteStore'

/** The noteId of a `#/notes/{noteId}` hash, else null. */
export function parseNoteRoute(hash: string): string | null {
  const m = /^#\/notes\/([^/]+)$/.exec(hash)
  if (!m) return null
  try {
    return decodeURIComponent(m[1]!)
  } catch {
    return null
  }
}

export const noteHref = (noteId: string) => `#/notes/${encodeURIComponent(noteId)}`
export const goToLibrary = () => globalThis.location.replace('#/')

// The hash we came from. When it was the library, "back" pops that entry instead
// of stacking a second library entry on the history.
let prevHash: string | null = null
globalThis.addEventListener?.('hashchange', (e) => {
  try {
    prevHash = new URL((e as HashChangeEvent).oldURL).hash
  } catch {
    prevHash = null
  }
})
function backToLibrary() {
  if (prevHash !== null && parseNoteRoute(prevHash) === null) globalThis.history.back()
  else goToLibrary()
}

// Entry point of the writing screen: only the editor-corner (back + title).
// Story 2.10 replaces it. A missing or unreadable note goes back to the library.
export function NoteEditorStub({
  noteId,
  openStore = () => openNoteStore(),
}: {
  noteId: string
  openStore?: () => NoteStore
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState<string | null>(null)
  const back = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    const store = openStore()
    store
      .loadNote(noteId)
      .then((r) => {
        if (!live) return
        const name: unknown = r?.result === 'ok' ? r.note?.meta?.title : undefined
        if (typeof name === 'string') setTitle(name)
        else goToLibrary()
      })
      .catch(() => live && goToLibrary())
      .finally(() => store.close())
    return () => {
      live = false
    }
    // openStore is read once per note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  // The library that had focus is gone; put focus on the way back.
  useEffect(() => {
    if (title !== null) back.current?.focus()
  }, [title])

  return (
    <section className="editor" aria-label={title ?? undefined} aria-busy={title === null}>
      {title === null && (
        <p role="status" className="cover-date">
          {t('library.loading')}
        </p>
      )}
      {title !== null && (
        <div className="editor-corner">
          <button ref={back} type="button" className="btn editor-back" aria-label={t('library.backToLibrary')} onClick={backToLibrary}>
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.75" fill="none" />
            </svg>
          </button>
          <span className="editor-title">{title}</span>
        </div>
      )}
    </section>
  )
}
