import { useEffect, useId, useRef, useState } from 'react'
import { fmt, useI18n } from '../../i18n'
import { CANVAS_MAX_SIDE, CANVAS_MIN_SIDE, CANVAS_PRESETS, canvasSize } from '../../model/canvasRules'
import { MAX_TITLE_LENGTH } from '../../model/noteTitle'
import { PEN_PALETTE } from '../../model/pen'

type Props = {
  /** Resolves false when the canvas could not be saved. */
  onCreate: (v: { title: string; width: number; height: number; background: unknown }) => Promise<boolean>
  onClose: () => void
}

const WHITE = '#ffffff'
const COLORS = [WHITE, ...PEN_PALETTE.pen.colors]
// An empty or non-numeric field is `invalid`; "12.5" parses and fails by the rule (`notInteger`).
const num = (v: string) => (v.trim() === '' ? NaN : Number(v))

// Story 33.3: modal sheet like NewNoteDialog (focus starts on the title and is trapped; Esc and [cancel] do nothing while saving).
export function NewCanvasDialog({ onCreate, onClose }: Props) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [w, setW] = useState('1080')
  const [h, setH] = useState('1080')
  const [bg, setBg] = useState<string>('transparent') // 'transparent' or a #rrggbb
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const busyRef = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const ids = { head: useId(), title: useId(), w: useId(), h: useId(), bg: useId(), size: useId() }
  useEffect(() => input.current?.focus(), [])
  const cap = (v: string) => ([...v].length > MAX_TITLE_LENGTH ? [...v].slice(0, MAX_TITLE_LENGTH).join('') : v)

  const valid = canvasSize(num(w), num(h)).ok
  // Each side is judged on its own (the other one is a known-good value) so both fields show their error.
  const sideError = (v: string) => {
    const r = canvasSize(num(v), CANVAS_MIN_SIDE)
    if (r.ok) return ''
    return r.reason === 'tooSmall' ? fmt(t('canvas.sizeTooSmall'), { n: CANVAS_MIN_SIDE }) : r.reason === 'tooLarge' ? fmt(t('canvas.sizeTooLarge'), { n: CANVAS_MAX_SIDE }) : t('canvas.sizeInvalid')
  }

  async function submit() {
    if (busyRef.current || !valid) return
    busyRef.current = true
    setBusy(true)
    setFailed(false)
    let ok = false
    try {
      ok = await onCreate({ title, width: num(w), height: num(h), background: bg === 'transparent' ? 'transparent' : { type: 'color', value: bg } })
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!busyRef.current) onCloseRef.current()
      } else if (e.key === 'Tab') {
        const stops = [...box.current!.querySelectorAll<HTMLElement>('input:not([type="radio"]):not(:disabled), input[type="radio"]:checked:not(:disabled), button')]
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

  const side = (id: string, label: string, v: string, set: (s: string) => void) => {
    const err = sideError(v)
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          className="field-input"
          value={v}
          readOnly={busy}
          autoComplete="off"
          aria-invalid={err ? true : undefined}
          aria-describedby={`${id}-err`}
          onChange={(e) => (setFailed(false), set(e.target.value))}
        />
        <span id={`${id}-err`} className="dialog-error" aria-live="polite">
          {err}
        </span>
      </div>
    )
  }

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div ref={box} className="dialog new-note" role="dialog" aria-modal="true" aria-labelledby={ids.head}>
        <h2 id={ids.head} className="dialog-title">
          {t('library.newCanvas')}
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
            onChange={(e) => (setFailed(false), setTitle(composing.current ? e.target.value : cap(e.target.value)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </div>
        <fieldset className="settings-group">
          <legend>{t('canvas.size')}</legend>
          {CANVAS_PRESETS.map(([pw, ph]) => (
            <label key={`${pw}x${ph}`} className="option">
              <input type="radio" name={ids.size} checked={num(w) === pw && num(h) === ph} disabled={busy} onChange={() => (setW(String(pw)), setH(String(ph)))} />
              {pw}×{ph}
            </label>
          ))}
          <div className="canvas-sizes">
            {side(ids.w, t('canvas.width'), w, setW)}
            {side(ids.h, t('canvas.height'), h, setH)}
            <button type="button" className="btn" disabled={busy} onClick={() => (setW(h), setH(w))}>
              {t('canvas.swap')}
            </button>
          </div>
        </fieldset>
        <fieldset className="settings-group">
          <legend>{t('canvas.background')}</legend>
          {['transparent', ...COLORS].map((c) => (
            <label key={c} className="option">
              <input type="radio" name={ids.bg} checked={bg === c} disabled={busy} onChange={() => setBg(c)} />
              {c === 'transparent' ? (
                t('canvas.transparent')
              ) : (
                <>
                  <span className="canvas-swatch" style={{ background: c }} aria-hidden="true" />
                  <span className={c === WHITE ? undefined : 'sr-only'}>{c === WHITE ? t('canvas.white') : fmt(t('canvas.color'), { color: c })}</span>
                </>
              )}
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
          <button type="button" className="btn btn-primary" aria-disabled={busy || !valid} aria-busy={busy} onClick={() => void submit()}>
            {t('library.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
