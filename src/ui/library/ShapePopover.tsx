import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import { SHAPE_KINDS, type ShapeKind } from '../../model/shape'
import { PopoverShell } from './PopoverShell'

/** One icon per kind (spec/shape.md "Shape tool bar"): line art in the tool color, like tool-icons.md. */
export function ShapeKindIcon({ kind }: { kind: ShapeKind }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round">
        {kind === 'triangle' && <path d="M12 4L3 19h18z" />}
        {kind === 'rect' && <rect x="4" y="6" width="16" height="12" />}
        {kind === 'circle' && <circle cx="12" cy="12" r="8" />}
      </g>
    </svg>
  )
}

/**
 * The shape kinds: three icon buttons in one row (a radiogroup, a choice applies at once) in the pen's speech bubble.
 * Arrows move the focus, Enter/Space choose, Esc closes (the shell). The owner puts focus back on the tool button in onClose.
 */
export function ShapePopover({ kind, anchor, tool, onChange, onClose }: {
  kind: ShapeKind
  anchor: HTMLElement | null
  tool: string
  onChange: (k: ShapeKind) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const btns = useRef<(HTMLButtonElement | null)[]>([])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => btns.current[SHAPE_KINDS.indexOf(kind)]?.focus(), [])
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      btns.current[i + (e.key === 'ArrowLeft' ? -1 : 1)]?.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onChange(SHAPE_KINDS[i]!)
    }
  }
  return (
    <PopoverShell anchor={anchor} tool={tool} onClose={onClose} labelledBy={titleId} className="pen-popover shape-popover">
      <h2 id={titleId} className="sr-only">
        {t('editor.shape')}
      </h2>
      <div className="pen-tool-switch" role="radiogroup" aria-labelledby={titleId}>
        {SHAPE_KINDS.map((k, i) => (
          <button
            key={k}
            ref={(el) => void (btns.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={kind === k}
            aria-label={t(`editor.shape.${k}`)}
            title={t(`editor.shape.${k}`)}
            data-shape-kind={k}
            tabIndex={kind === k ? 0 : -1}
            onClick={() => onChange(k)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <ShapeKindIcon kind={k} />
          </button>
        ))}
      </div>
    </PopoverShell>
  )
}
