// The PDF import dialog (Story 9.3): file name, progress, [취소], and a refusal to acknowledge. Modal; Esc cancels (or
// closes the refusal); progress and result go to one polite live region.
import { useEffect, useId, useRef } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'

export type PdfImportState = { name: string; done: number; total: number; error?: Key }

export function PdfImportDialog({ state, onCancel, onClose }: { state: PdfImportState; onCancel: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const head = useId()
  const button = useRef<HTMLButtonElement>(null)
  const failed = state.error !== undefined
  const act = failed ? onClose : onCancel
  const actRef = useRef(act)
  actRef.current = act
  useEffect(() => button.current?.focus(), [failed])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        actRef.current()
      } else if (e.key === 'Tab') {
        e.preventDefault() // one button: focus stays on it
        button.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const text = state.error ? t(state.error) : state.total > 0 ? fmt(t('pdf.import.progress'), { done: state.done, total: state.total }) : t('pdf.import.starting')
  return (
    <div className="dialog-scrim">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={head}>
        <h2 id={head} className="dialog-title">
          {state.name}
        </h2>
        <p className="export-progress" role="status" aria-live="polite">
          {text}
        </p>
        <div className="dialog-actions">
          <button ref={button} type="button" className="btn" onClick={act}>
            {t(failed ? 'pdf.import.ok' : 'dialog.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
