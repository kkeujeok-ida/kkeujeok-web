// The PDF export dialog (Story 8.3): range, progress, cancel, failure. It only asks and shows; `buildPdf` makes the file
// from the local copy of the note (no Drive call), so a read-only tab or an expired sign-in still exports.
// Modal: focus is trapped, Esc closes (or cancels the running export), progress is a polite live region.
import { useEffect, useId, useRef, useState } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'
import { exportRange, type RangeError } from '../../export/exportRules'
import type { PdfJob } from '../../export/pdfExport'
import { sharedAssetStore } from '../../sync/imageWiring'
import { downloadBlob } from '../download'

type Mode = 'all' | 'current' | 'custom'
type Phase = { kind: 'choose' } | { kind: 'making'; done: number; total: number } | { kind: 'failed'; missing: boolean; pdf?: boolean }

const MODES: { mode: Mode; label: Key }[] = [
  { mode: 'all', label: 'export.all' },
  { mode: 'current', label: 'export.current' },
  { mode: 'custom', label: 'export.custom' },
]
const ERROR_KEY: Record<RangeError, Key> = {
  emptyRange: 'export.err.emptyRange',
  invalidFormat: 'export.err.invalidFormat',
  reversedRange: 'export.err.reversedRange',
  outOfRange: 'export.err.outOfRange',
}

type Props = {
  /** 'print' (Story 8.4) builds the same PDF but opens the browser's print dialog instead of downloading. */
  mode?: 'export' | 'print'
  note: PdfJob['note']
  /** 1-based number of the page on screen. */
  current: number
  /** The image host: a missing asset (a PDF original) is asked for before the export gives up. */
  images?: { retry(asset: string): void } | null
  onClose: () => void
}

const FETCH_WAIT_MS = 15_000

export function ExportDialog({ mode: purpose = 'export', note, current, images, onClose }: Props) {
  const printing = purpose === 'print'
  const { t } = useI18n()
  const [mode, setMode] = useState<Mode>('all')
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  const abort = useRef<AbortController | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const ids = { head: useId(), scope: useId(), err: useId() }
  const pageCount = note.pages.length

  const range = { mode, text, current }
  const checked = exportRange({ ...range, pageCount })
  const rangeError = 'error' in checked ? checked.error : null
  // An empty field is not shown as an error, but [내보내기] stays off.
  const shownError = mode === 'custom' && rangeError && text !== '' ? fmt(t(ERROR_KEY[rangeError]), { total: pageCount }) : ''
  const canStart = !rangeError

  const start = async () => {
    if (!canStart || phase.kind === 'making') return
    const ac = new AbortController()
    abort.current = ac
    let cancelled: (new () => Error) | undefined
    setPhase({ kind: 'making', done: 0, total: 'pages' in checked ? checked.pages.length : 0 })
    try {
      // pdf-lib and fontkit load only when an export starts
      const [{ buildPdf, ExportCancelled: Cancelled }, { loadFonts, webpToPng }, { renderPageRaster }] = await Promise.all([import('../../export/pdfExport'), import('../../export/browserAssets'), import('../../export/pageRaster')])
      cancelled = Cancelled
      const store = sharedAssetStore()
      // Asset first: a byte file this device lacks is fetched (the asset sync) and waited for, unless offline.
      const assets = {
        get: async (h: string) => {
          let rec = await store.get(h)
          if (rec || !images) return rec
          images.retry(h)
          for (let t = 0; !rec && t < FETCH_WAIT_MS && navigator.onLine !== false && !ac.signal.aborted; t += 500) {
            await new Promise((res) => setTimeout(res, 500))
            rec = await store.get(h)
          }
          return rec
        },
      }
      const r = await buildPdf({
        note, range, assets, fonts: loadFonts, webpToPng, rasterPage: (p, w, h, a) => renderPageRaster(p as never, w, h, a), signal: ac.signal,
        onProgress: (done, total) => setPhase({ kind: 'making', done, total }),
      })
      if (!r.ok) return setPhase({ kind: 'failed', missing: r.error === 'assetMissing', pdf: !!r.pdfAssets?.length })
      if (printing) await (await import('../../export/printPdf')).printBlob(r.blob)
      else downloadBlob(r.fileName, r.blob, 'application/pdf')
      onClose()
    } catch (e) {
      if (cancelled && e instanceof cancelled) onClose()
      else setPhase({ kind: 'failed', missing: false })
    }
  }

  const close = () => {
    if (phase.kind === 'making') abort.current?.abort()
    else onClose()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => () => abort.current?.abort(), []) // the dialog is gone: stop the work
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus()
  }, [])

  // On the document, so Esc and Tab also work when focus has fallen out of the sheet.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
      } else if (e.key === 'Tab') {
        const stops = [...box.current!.querySelectorAll<HTMLElement>('input:not([type="radio"]):not(:disabled), input[type="radio"]:checked:not(:disabled), button')]
        const first = stops[0], last = stops[stops.length - 1], at = document.activeElement
        if (!box.current!.contains(at) || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
          e.preventDefault()
          ;(e.shiftKey ? last : first)?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const progress = phase.kind === 'making' ? fmt(t('export.progress'), { done: phase.done, total: phase.total }) : ''

  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && phase.kind !== 'making' && onClose()}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby={ids.head}>
        <h2 id={ids.head} className="dialog-title">
          {t(printing ? 'print.title' : 'export.title')}
        </h2>
        {phase.kind === 'choose' && (
          <>
            <fieldset className="settings-group">
              <legend>{t('export.scope')}</legend>
              {MODES.map(({ mode: m, label }) => (
                <label key={m} className="option">
                  <input
                    type="radio"
                    name={ids.scope}
                    checked={mode === m}
                    onChange={() => {
                      setMode(m)
                      if (m === 'custom') setTimeout(() => input.current?.focus())
                    }}
                  />
                  {t(label)}
                </label>
              ))}
            </fieldset>
            {mode === 'custom' && (
              <div className="field">
                <label htmlFor={`${ids.scope}-text`}>{fmt(t('export.customLabel'), { total: pageCount })}</label>
                <input
                  ref={input}
                  id={`${ids.scope}-text`}
                  className="field-input"
                  inputMode="numeric"
                  autoComplete="off"
                  value={text}
                  placeholder="3-7"
                  aria-invalid={shownError !== ''}
                  aria-describedby={ids.err}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                      e.preventDefault()
                      void start()
                    }
                  }}
                />
              </div>
            )}
            <p id={ids.err} className="dialog-error" aria-live="polite">
              {shownError}
            </p>
          </>
        )}
        {/* the live region is always mounted, so the first update is announced */}
        <p className="export-progress" aria-live="polite" role="status">
          {progress}
        </p>
        {phase.kind === 'failed' && (
          <p className="dialog-error" role="alert">
            {t(printing ? 'print.failed' : 'export.failed')} {phase.missing && t(phase.pdf ? 'export.pdfMissing' : 'export.assetMissing')}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            {t('dialog.cancel')}
          </button>
          {phase.kind === 'failed' && (
            <button type="button" className="btn btn-primary" onClick={() => void start()}>
              {t('export.retry')}
            </button>
          )}
          {phase.kind === 'choose' && (
            <button type="button" className="btn btn-primary" aria-disabled={!canStart} onClick={() => void start()}>
              {t(printing ? 'print.start' : 'export.start')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
