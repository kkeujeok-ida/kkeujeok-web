import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import { SHAPE_KINDS, type ShapeKind } from '../../model/shape'
import { PopoverShell } from './PopoverShell'

// spec/tool-icons.md: only M L H V Z; the circle is a 16-gon.
export const SHAPE_KIND_D: Record<ShapeKind, string> = {
  triangle: 'M12 3L21 20H3Z',
  rect: 'M4 4H20V20H4Z',
  circle: 'M20 12L19.4 15.1L17.7 17.7L15.1 19.4L12 20L8.9 19.4L6.3 17.7L4.6 15.1L4 12L4.6 8.9L6.3 6.3L8.9 4.6L12 4L15.1 4.6L17.7 6.3L19.4 8.9Z',
}
export const SHAPES_GLYPH_D =
  'M8 3L14.5 14H1.5ZM3 10H12V19H3ZM21.5 15L21.04 17.3L19.74 19.24L17.8 20.54L15.5 21L13.2 20.54L11.26 19.24L9.96 17.3L9.5 15L9.96 12.7L11.26 10.76L13.2 9.46L15.5 9L17.8 9.46L19.74 10.76L21.04 12.7Z'

/** One icon per kind (spec/shape.md "Shape tool bar"): line art in the tool color, like tool-icons.md. */
export function ShapeKindIcon({ kind }: { kind: ShapeKind }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round">
        <path d={SHAPE_KIND_D[kind]} />
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
