import { useEffect, useId, useRef, useState } from 'react'
import { useI18n, type Key } from '../../i18n'
import { BACKGROUNDS } from '../../model/note'
import { MAX_TITLE_LENGTH } from '../../model/noteTitle'
import { ORIENTATIONS, type Background, type NewNoteDefaults, type Orientation } from '../../storage/newNoteDefaults'

const BACKGROUND_LABEL: Record<(typeof BACKGROUNDS)[number], Key> = {
  plain: 'library.background.plain',
  lined: 'library.background.lined',
  grid: 'library.background.grid',
  dot: 'library.background.dot',
}
const ORIENTATION_LABEL: Record<(typeof ORIENTATIONS)[number], Key> = {
  portrait: 'library.orientation.portrait',
  landscape: 'library.orientation.landscape',
}

type Props = {
  defaults: NewNoteDefaults
  /** Resolves false when the note could not be saved. */
  onCreate: (v: { title: string; background: Background; orientation: Orientation }) => Promise<boolean>
  onClose: () => void
}

// Modal sheet. Focus starts on the title and is trapped inside. While a save is
// running the buttons are aria-disabled (not disabled, so focus stays in the trap)
// and Esc, [cancel] and an outside press do nothing.
export function NewNoteDialog({ defaults, onCreate, onClose }: Props) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [background, setBackground] = useState<Background>(defaults.background)
  const [orientation, setOrientation] = useState<Orientation>(defaults.orientation)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const busyRef = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const ids = { head: useId(), title: useId(), bg: useId(), or: useId() }
  const composing = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => input.current?.focus(), [])
  const cap = (v: string) => {
    // Counted in code points, so an emoji is one character.
    const cps = [...v]
    return cps.length > MAX_TITLE_LENGTH ? cps.slice(0, MAX_TITLE_LENGTH).join('') : v
  }

  async function submit() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setFailed(false)
    let ok = false
    try {
      ok = await onCreate({ title, background, orientation })
    } catch {
      ok = false
    }
    busyRef.current = false
    setBusy(false)
    if (!ok) setFailed(true)
  }

  const close = () => {
    if (!busyRef.current) onClose()
  }

  // On the document, so Esc and Tab also work when focus has fallen out of the sheet.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return // IME owns the key
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!busyRef.current) onCloseRef.current()
      } else if (e.key === 'Tab') {
        // Wrap only at the ends; radios are one tab stop per group.
        const stops = [
          ...box.current!.querySelectorAll<HTMLElement>(
            'input:not([type="radio"]):not(:disabled), input[type="radio"]:checked:not(:disabled), button',
          ),
        ]
        const first = stops[0]
        const last = stops[stops.length - 1]
        const at = document.activeElement
        if (!box.current!.contains(at) || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
          e.preventDefault()
          ;(e.shiftKey ? last : first)?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div ref={box} className="dialog new-note" role="dialog" aria-modal="true" aria-labelledby={ids.head}>
        <h2 id={ids.head} className="dialog-title">
          {t('library.newNote')}
        </h2>
        <div className="field">
          <label htmlFor={ids.title}>{t('library.noteTitle')}</label>
          <input
            ref={input}
            id={ids.title}
            type="text"
            className="field-input"
            value={title}
            readOnly={busy}
            autoComplete="off"
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={(e) => {
              composing.current = false
              setTitle(cap(e.currentTarget.value))
            }}
            onChange={(e) => {
              setFailed(false)
              // Cutting mid-composition would break the IME; compositionend cuts.
              setTitle(composing.current ? e.target.value : cap(e.target.value))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </div>
        <fieldset className="settings-group">
          <legend>{t('library.pageBackground')}</legend>
          {BACKGROUNDS.map((b) => (
            <label key={b} className="option">
              <input
                type="radio"
                name={ids.bg}
                value={b}
                checked={background === b}
                disabled={busy}
                onChange={() => {
                  setFailed(false)
                  setBackground(b)
                }}
              />
              {t(BACKGROUND_LABEL[b])}
            </label>
          ))}
        </fieldset>
        <fieldset className="settings-group">
          <legend>{t('library.pageOrientation')}</legend>
          {ORIENTATIONS.map((o) => (
            <label key={o} className="option">
              <input
                type="radio"
                name={ids.or}
                value={o}
                checked={orientation === o}
                disabled={busy}
                onChange={() => {
                  setFailed(false)
                  setOrientation(o)
                }}
              />
              {t(ORIENTATION_LABEL[o])}
            </label>
          ))}
        </fieldset>
        <div aria-live="polite" className="dialog-error">
          {failed && t('library.saveFailed')}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" aria-disabled={busy} onClick={close}>
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={busy}
            aria-busy={busy}
            onClick={() => void submit()}
          >
            {t('library.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
