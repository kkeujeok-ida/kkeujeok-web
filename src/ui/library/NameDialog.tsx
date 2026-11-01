import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { libraryFolderName } from '../../library/libraryRules'

/** A folder or note name: [저장] stays off while the name is empty; a too long name is refused with a message. */
export function NameDialog({ title, initial, label, tooLong, failed, onSave, onClose }: { title: string; initial: string; /** The field label (folder name by default). */ label?: string; /** The text for a name over 100 characters. */ tooLong?: string; /** The text when saving failed. */ failed?: string; onSave: (name: string) => Promise<string | undefined>; onClose: () => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.select(), [])
  const check = libraryFolderName({ name: value })
  const submit = async () => {
    if (busy) return
    if (!check.ok) return setError(check.reason === 'nameTooLong' ? (tooLong ?? t('folder.nameTooLong')) : null)
    setBusy(true)
    const code = await onSave(check.name)
    setBusy(false)
    if (code) setError(failed ?? t('folder.failed'))
    else onClose()
  }
  return (
    <div
      className="dialog-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <form className="dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => (e.preventDefault(), void submit())}>
        <h2 className="dialog-title">{title}</h2>
        <label className="field">
          <span>{label ?? t('folder.nameLabel')}</span>
          <input ref={input} className="field-input" value={value} autoComplete="off" onChange={(e) => (setValue(e.target.value), setError(null))} />
        </label>
        <div aria-live="polite" className="dialog-error">
          {error}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('library.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" aria-disabled={!check.ok || busy}>
            {t('folder.save')}
          </button>
        </div>
      </form>
    </div>
  )
}
