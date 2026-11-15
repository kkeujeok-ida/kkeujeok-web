// Story 33.7: the 1x/2x chooser of the canvas PNG export; the file goes out as a download.
import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import type { Note } from '../../model/note'
import type { WriterMessage } from './writer'

export function CanvasPngDialog({ note, onMessage, onClose }: { note: Note; onMessage: (k: WriterMessage) => void; onClose: () => void }) {
  const { t } = useI18n()
  const [scale, setScale] = useState(1)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [busy, onClose])
  const start = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { exportCanvasPng, CanvasExportTooLarge } = await import('../../export/canvasPng')
      try {
        await exportCanvasPng(note, scale)
      } catch (e) {
        onMessage(e instanceof CanvasExportTooLarge ? 'exportPngTooLarge' : 'exportPngFailed')
      }
    } catch {
      onMessage('exportPngFailed')
    }
    onClose()
  }
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('export.png.title')}>
        <h2 className="dialog-title">{t('export.png.title')}</h2>
        <fieldset className="settings-group">
          {[1, 2].map((s) => (
            <label key={s} className="option">
              <input type="radio" name="png-scale" autoFocus={s === 1} checked={scale === s} onChange={() => setScale(s)} />
              {t(s === 1 ? 'export.png.scale1' : 'export.png.scale2')}
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="btn btn-primary" aria-disabled={busy} onClick={() => void start()}>
            {t('export.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
