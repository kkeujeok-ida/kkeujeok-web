// The sheet of a note whose Drive file cannot be read (Story 3.18, UX-DR69). Modal: focus starts on the
// first action and stays inside, Esc closes it. The caller puts focus back on the card that opened it.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import { downloadBlob } from '../download'
import { useSyncUi } from './syncUi'

export const driveFileUrl = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`

export function CannotOpenSheet({
  fileId,
  hasUnsent,
  onExportCopy,
  onClose,
}: {
  fileId: string | null
  /** The note has changes Drive does not have: they stay on this device and can be saved as a file. */
  hasUnsent: boolean
  /** Saves the device copy as a `.kkj` file; rejects when it cannot. */
  onExportCopy?: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useI18n()
  const ui = useSyncUi()
  const box = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()
  const [error, setError] = useState<'log' | 'file' | null>(null)
  const working = useRef(false) // an export in flight: a second press is ignored
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    box.current?.querySelector<HTMLElement>('a, button')?.focus()
    return () => void (mounted.current = false)
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      const items = [...box.current!.querySelectorAll<HTMLElement>('a[href], button')]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length
      e.preventDefault()
      items[next]?.focus()
    }
  }

  async function run(kind: 'log' | 'file', job: () => Promise<void>) {
    if (working.current) return
    working.current = true
    setError(null)
    try {
      await job()
    } catch {
      if (mounted.current) setError(kind)
    } finally {
      working.current = false
    }
  }
  const exportLog = () =>
    run('log', async () => {
      const { name, text } = await ui!.exportLog()
      downloadBlob(name, text, 'application/x-ndjson')
    })

  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label={t('cannotOpen.label')} aria-describedby={bodyId}>
        <p id={titleId} className="dialog-title">
          {t('library.cannotOpen')}
        </p>
        <p id={bodyId}>
          {t('cannotOpen.body')}
          {hasUnsent && ` ${t('cannotOpen.unsent')}`}
        </p>
        <div role="alert" className="dialog-error">
          {error === 'log' ? t('settings.syncLogExportFailed') : error === 'file' ? t('cannotOpen.exportFailed') : ''}
        </div>
        <div className="dialog-actions">
          {fileId !== null && (
            <a className="btn" href={driveFileUrl(fileId)} target="_blank" rel="noopener noreferrer">
              {t('cannotOpen.openDrive')}
            </a>
          )}
          {ui && (
            <button type="button" className="btn" onClick={() => void exportLog()}>
              {t('settings.syncLogExport')}
            </button>
          )}
          {hasUnsent && onExportCopy && (
            <button type="button" className="btn" onClick={() => void run('file', onExportCopy)}>
              {t('cannotOpen.exportFile')}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t('dialog.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
