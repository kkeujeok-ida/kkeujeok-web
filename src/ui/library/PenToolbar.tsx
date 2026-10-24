import type { Ref } from 'react'
import type { Pen } from '../../model/pen'
import { fmt, useI18n, type Key } from '../../i18n'

export const COLOR_NAME: Record<Pen['colorName'], Key> = { black: 'editor.colorBlack' }

/**
 * The floating toolbar: grip (inert, hidden from the a11y tree) | pen slots |
 * divider | undo, redo. Slots are one radiogroup; activating the selected one
 * opens the pen popover (onEdit). The slot buttons carry data-slot for the owner.
 */
export function PenToolbar({ pens, selected, onSelect, onEdit, tool, onToolChange, onImage, canUndo, canRedo, onUndo, onRedo, readOnly = false, ref }: {
  pens: readonly Pen[]
  selected: number
  onSelect: (i: number) => void
  onEdit: (i: number) => void
  /** The lasso and the text tool are toggles: pressed = that tool, else the pen. The lasso works read-only too (selecting changes nothing); the text tool does not. */
  tool: 'pen' | 'lasso' | 'text'
  onToolChange: (t: 'pen' | 'lasso' | 'text') => void
  /** [이미지]: opens the file picker (Story 4.13). Without it (no image host) the button is off. */
  onImage?: () => void
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
          ['undo', canUndo, onUndo, 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z'],
          ['redo', canRedo, onRedo, 'M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z'],
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
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d={d} fill="currentColor" />
          </svg>
        </button>
      ))}
      <button
        type="button"
        aria-pressed={tool === 'lasso'}
        aria-label={t('editor.lasso')}
        title={t('editor.lassoTip')}
        className="toolbar-action"
        data-tool="lasso"
        onClick={() => onToolChange(tool === 'lasso' ? 'pen' : 'lasso')}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M17 5h-2V3h2v2zm-2 16h2v-2.59L19.59 21 21 19.59 18.41 17H21v-2h-6v6zm4-12h2V7h-2v2zm0 4h2v-2h-2v2zm-8 8h2v-2h-2v2zM7 5h2V3H7v2zM3 17h2v-2H3v2zm2 4v-2H3c0 1.1.9 2 2 2zM19 3v2h2c0-1.1-.9-2-2-2zm-8 2h2V3h-2v2zM3 9h2V7H3v2zm4 12h2v-2H7v2zm-4-8h2v-2H3v2zm0-8h2V3c-1.1 0-2 .9-2 2z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-pressed={tool === 'text'}
        aria-label={t('editor.text')}
        title={readOnly ? t('editor.readOnlyTip') : t('editor.textTip')}
        aria-disabled={readOnly || undefined}
        className="toolbar-action"
        data-tool="text"
        onClick={() => !readOnly && onToolChange(tool === 'text' ? 'pen' : 'text')}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2.5 4v3h5v12h3V7h5V4h-13zm19 5h-9v3h3v7h3v-7h3V9z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={t('editor.image')}
        title={readOnly ? t('editor.readOnlyTip') : t('editor.imageTip')}
        aria-disabled={readOnly || !onImage || undefined}
        className="toolbar-action"
        data-tool="image"
        onClick={() => !readOnly && onImage?.()}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4.86 8.86l-3 3.87L9 13.14 6 17h12l-3.86-5.14z" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}
