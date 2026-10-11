import type { Ref } from 'react'
import type { Pen } from '../../model/pen'
import { fmt, useI18n, type Key } from '../../i18n'

const COLOR_NAME: Record<Pen['colorName'], Key> = { black: 'editor.colorBlack' }

/**
 * The floating toolbar: grip (inert, hidden from the a11y tree) | pen slots |
 * divider | undo, redo. Slots are one radiogroup; activating the selected one
 * opens the pen popover (onEdit). The slot buttons carry data-slot for the owner.
 */
export function PenToolbar({ pens, selected, onSelect, onEdit, canUndo, canRedo, onUndo, onRedo, readOnly = false, ref }: {
  pens: readonly Pen[]
  selected: number
  onSelect: (i: number) => void
  onEdit: (i: number) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** Another tab is editing: slots and history are shown but off. */
  readOnly?: boolean
  ref?: Ref<HTMLDivElement>
}) {
  const { t } = useI18n()
  return (
    <div ref={ref} role="toolbar" aria-label={t('editor.toolbar')} className="pen-toolbar">
      <span className="toolbar-grip" aria-hidden="true">
        <svg className="icon" viewBox="0 0 16 16">
          <circle cx="8" cy="3.5" r="1.25" fill="currentColor" />
          <circle cx="8" cy="8" r="1.25" fill="currentColor" />
          <circle cx="8" cy="12.5" r="1.25" fill="currentColor" />
        </svg>
      </span>
      <div role="radiogroup" className="pen-slots">
        {pens.map((pen, i) => {
          const label = fmt(t('editor.penSlot'), { color: t(COLOR_NAME[pen.colorName]), width: pen.width.toFixed(1), n: i + 1 })
          const on = i === selected
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={label}
              aria-disabled={readOnly || undefined}
              title={readOnly ? t('editor.readOnlyTip') : label}
              data-slot={i}
              className={on ? 'pen-slot pen-slot-selected' : 'pen-slot'}
              onClick={() => !readOnly && (on ? onEdit(i) : onSelect(i))}
            >
              <svg className="pen-nib" viewBox="0 0 20 36" aria-hidden="true">
                <path
                  d="M3 0V22.3L10 36L17 22.3V0M3 22.3H17"
                  fill="none"
                  stroke={pen.color}
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="pen-dot" aria-hidden="true" style={{ background: pen.color }} />
              {on && (
                <svg className="pen-caret" viewBox="0 0 8 4" aria-hidden="true">
                  <path d="M0 0H8L4 4Z" fill="currentColor" />
                </svg>
              )}
              {on && <span className="pen-underline" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <span className="toolbar-divider" aria-hidden="true" />
      {(
        [
          ['undo', canUndo, onUndo, 'M6 3L2 7l4 4M2 7h7a4 4 0 010 8H6'],
          ['redo', canRedo, onRedo, 'M10 3l4 4-4 4M14 7H7a4 4 0 000 8h3'],
        ] as const
      ).map(([name, enabled, run, d]) => (
        <button
          key={name}
          type="button"
          // aria-disabled, not disabled: focus stays on the button.
          aria-disabled={!enabled}
          aria-label={t(`editor.${name}`)}
          title={readOnly ? t('editor.readOnlyTip') : t(`editor.${name}Tip`)}
          className={enabled ? 'toolbar-action' : 'toolbar-action toolbar-action-disabled'}
          onClick={() => enabled && run()}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d={d} stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ))}
    </div>
  )
}
