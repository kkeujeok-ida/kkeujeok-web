// Note covers (Story 7.4, spec library "Covers"): the list comes from the design token index, the pictures are its SVG files.
import { useEffect, useId, useRef, useState } from 'react'
import { useI18n, type Locale } from '../../i18n'
import { libraryCoverEntries, libraryCoverResolve } from '../../library/libraryRules'
import index from '../../../design_tokens/covers/index.json'

const urls = import.meta.glob<string>('../../../design_tokens/covers/*.svg', { query: '?url', import: 'default', eager: true })
const urlOf = (file: string) => urls[`../../../design_tokens/covers/${file}`]

/** The valid index entries that have a picture, in display order. */
export const COVERS = libraryCoverEntries(index).filter((c) => urlOf(c.file))

/** The picture of a stored `coverId`; null (the first page thumbnail) for none or an id this app does not know. */
export function coverUrl(coverId: unknown): string | null {
  const r = libraryCoverResolve({ coverId, index })
  return r.kind === 'cover' ? (urlOf(r.file) ?? null) : null
}

/** The card picture, drawn in the `.cover-thumb` frame. */
export function CoverArt({ url }: { url: string }) {
  return (
    <span className="cover-thumb" aria-hidden="true">
      <img className="cover-art" src={url} alt="" draggable={false} />
    </span>
  )
}

/** [표지 없음] and the index covers as native radios: arrows choose, Enter confirms (`onEnter`). `value` null = none. */
export function CoverRadios({ name, value, disabled, onChange, onEnter }: { name: string; value: string | null; disabled?: boolean; onChange: (id: string | null) => void; onEnter?: () => void }) {
  const { t, locale } = useI18n()
  const items: { id: string | null; label: string; url: string | null }[] = [
    { id: null, label: t('library.coverNone'), url: null },
    ...COVERS.map((c) => ({ id: c.id, label: c.name[locale as Locale], url: urlOf(c.file)! })),
  ]
  return (
    <fieldset className="settings-group bg-group">
      <legend>{t('library.cover')}</legend>
      {items.map((c) => (
        <label key={c.id ?? ''} className="option option-tile">
          <input
            type="radio"
            name={name}
            value={c.id ?? ''}
            checked={value === c.id}
            disabled={disabled}
            onChange={() => onChange(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onEnter && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                onEnter()
              }
            }}
          />
          {c.url ? <img className="cover-option-art" src={c.url} alt="" draggable={false} /> : <span className="cover-option-art cover-option-none" aria-hidden="true" />}
          {c.label}
        </label>
      ))}
    </fieldset>
  )
}

/** [표지 변경]: pick with the arrows, Enter or [저장] confirms. A stored id not in the index starts as none. `onSave` resolves false on failure. */
export function CoverDialog({ current, onSave, onClose }: { current: string | null; onSave: (id: string | null) => Promise<boolean>; onClose: () => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState<string | null>(COVERS.some((c) => c.id === current) ? current : null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const name = useId()
  useEffect(() => box.current?.querySelector<HTMLElement>('input:checked')?.focus(), [])
  const save = async () => {
    if (busy) return
    setBusy(true)
    const ok = await onSave(value)
    setBusy(false)
    if (ok) onClose()
    else setFailed(true)
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
      <div ref={box} className="dialog cover-dialog" role="dialog" aria-modal="true" aria-label={t('library.noteCover')}>
        <h2 className="dialog-title">{t('library.noteCover')}</h2>
        <CoverRadios name={name} value={value} disabled={busy} onChange={(id) => (setFailed(false), setValue(id))} onEnter={() => void save()} />
        <div aria-live="polite" className="dialog-error">
          {failed && t('library.noteCoverFailed')}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('library.cancel')}
          </button>
          <button type="button" className="btn btn-primary" aria-disabled={busy} onClick={() => void save()}>
            {t('folder.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
