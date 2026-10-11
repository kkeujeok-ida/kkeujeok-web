import { useEffect, useId, useRef, useState } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'
import { penSlots } from '../../model/pen'
import { openNoteStore, type NoteStore } from '../../storage/noteStore'
import { savesSettled } from '../../storage/saveQueue'
import { PenToolbar } from './PenToolbar'
import { detectEditedBy } from './useLibrary'
import { Writer, type WriterMessage } from './writer'

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

const SNACKBAR_MS = 4000
const LEAVE_WAIT_MS = 5000
const MESSAGE_KEY: Record<WriterMessage, Key> = {
  saveFailed: 'editor.saveFailed',
  strokeNotAdded: 'editor.strokeNotAdded',
}

type Loaded = { title: string; writer: Writer }

/**
 * The writing screen: the page on a canvas, the pen toolbar and the top-left
 * editor-corner. A missing or unreadable note goes back to the library.
 */
export function NoteEditor({
  noteId,
  openStore = () => openNoteStore(),
}: {
  noteId: string
  openStore?: () => NoteStore
}) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [message, setMessage] = useState<{ key: WriterMessage; n: number } | null>(null)
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  selectedRef.current = selected

  const back = useRef<HTMLButtonElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const leaving = useRef(false)
  const mounted = useRef(true)
  const descId = useId()

  // Loads the note and owns its store until the editor is left.
  useEffect(() => {
    mounted.current = true
    let live = true
    let writer: Writer | null = null
    const store = openStore()
    // A save of this note that is still running must land before it is read.
    const loading = savesSettled(3000)
      .then(() => (live ? store.loadNote(noteId) : null))
      .then((r) => {
        if (!live) return
        const note = r?.result === 'ok' ? r.note : undefined
        const title: unknown = note?.meta?.title
        if (!note || typeof title !== 'string' || !Array.isArray(note.pages) || note.pages.length === 0) {
          goToLibrary()
          return
        }
        writer = new Writer(
          note,
          store,
          () => penSlots[selectedRef.current] ?? penSlots[0]!,
          (key) => live && setMessage((p) => ({ key, n: (p?.n ?? 0) + 1 })),
          detectEditedBy,
        )
        setLoaded({ title, writer })
      })
      .catch(() => live && goToLibrary())
    // Without a writer nobody else will close the connection.
    void loading.finally(() => {
      if (!writer) store.close()
    })
    return () => {
      live = false
      mounted.current = false
      // Leaving by the browser's back button ends here: finish and save in the
      // background; the library waits for it before it lists the notes.
      void writer?.finalize().catch(() => {})
    }
    // openStore is read once per note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  // The library that had focus is gone; put focus on the way back.
  const ready = loaded !== null
  useEffect(() => {
    if (ready) back.current?.focus()
  }, [ready])

  useEffect(() => {
    if (!loaded || !canvas.current) return
    return loaded.writer.attach(canvas.current)
  }, [loaded])

  // The snackbar goes away by itself.
  useEffect(() => {
    if (!message) return
    const id = setTimeout(() => setMessage(null), SNACKBAR_MS)
    return () => clearTimeout(id)
  }, [message])

  // F6 / Shift+F6 cycle corner -> toolbar -> canvas; 1 picks the first slot.
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const regions = [back.current?.parentElement, toolbar.current, canvas.current].filter((r): r is HTMLElement => !!r)
      const active = document.activeElement
      if (e.key === 'F6') {
        const at = regions.findIndex((r) => r.contains(active))
        const step = e.shiftKey ? -1 : 1
        const next = at < 0 ? (step > 0 ? 0 : regions.length - 1) : (at + step + regions.length) % regions.length
        e.preventDefault()
        const to = regions[next]
        if (to === toolbar.current) toolbar.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus()
        else if (to === canvas.current) canvas.current?.focus()
        else back.current?.focus()
      } else if (e.key === '1' && !e.shiftKey) {
        const target = e.target as Node | null
        const inside = [toolbar.current, canvas.current].some((r) => r && (r.contains(target) || r.contains(active)))
        if (inside) setSelected(0)
      }
    }
    // Capture, so a handler lower down cannot hide the key.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [ready])

  const onBack = () => {
    if (!loaded || leaving.current) return
    leaving.current = true
    // Finish the stroke and the saves first; leave even when the last try fails.
    // finalize never rejects in practice; if it hangs, leave after 5 s anyway.
    const done = loaded.writer.finalize().catch(() => {})
    const giveUp = new Promise<void>((r) => setTimeout(r, LEAVE_WAIT_MS))
    void Promise.race([done, giveUp]).then(() => mounted.current && backToLibrary())
  }

  const page = loaded?.writer.history.note.pages[0]
  const total = loaded?.writer.history.note.pages.length ?? 0
  const pageLabel = page
    ? fmt(t('editor.page'), {
        n: 1,
        total,
        orientation: t(page.width > page.height ? 'library.orientation.landscape' : 'library.orientation.portrait'),
      })
    : undefined

  return (
    <section className="editor" aria-label={loaded?.title} aria-busy={!loaded}>
      {!loaded && (
        <p role="status" className="cover-date">
          {t('library.loading')}
        </p>
      )}
      {loaded && (
        <>
          <div className="editor-top">
            <div className="editor-corner">
              <button ref={back} type="button" className="btn editor-back" aria-label={t('library.backToLibrary')} onClick={onBack}>
                <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.75" fill="none" />
                </svg>
              </button>
              <span className="editor-title">{loaded.title}</span>
            </div>
            <PenToolbar ref={toolbar} pens={penSlots} selected={selected} onSelect={setSelected} />
          </div>
          <div className="editor-page-area" role="group" aria-label={`${t('editor.canvas')}: ${pageLabel ?? ''}`}>
            <canvas
              ref={canvas}
              className="editor-canvas"
              role="img"
              tabIndex={0}
              aria-label={pageLabel}
              aria-describedby={descId}
            />
            <span id={descId} className="sr-only">
              {t('editor.handwriting')}
            </span>
          </div>
          <div role="status" className="snackbar">
            {message ? t(MESSAGE_KEY[message.key]) : ''}
          </div>
        </>
      )}
    </section>
  )
}
