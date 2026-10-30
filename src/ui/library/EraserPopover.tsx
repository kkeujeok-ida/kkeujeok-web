import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import type { EraserMode, EraserSettings } from '../../storage/eraserSettings'
import { PopoverShell } from './PopoverShell'

const MODES: EraserMode[] = ['stroke', 'partial']

/**
 * The eraser options: stroke / partial (a radiogroup, changes apply at once) and "return to the pen after erasing".
 * Modal like the pen popover; the owner puts focus back on the eraser button in onClose.
 */
export function EraserPopover({ mode, returnToPen, anchor, tool, onChange, onClose }: {
  mode: EraserMode
  returnToPen: boolean
  anchor: HTMLElement | null
  tool: string
  onChange: (patch: Partial<EraserSettings>) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const labelId = useId()
  const btns = useRef<(HTMLButtonElement | null)[]>([])
  // First focus: the chosen way.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => btns.current[MODES.indexOf(mode)]?.focus(), [])
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      btns.current[i + (e.key === 'ArrowLeft' ? -1 : 1)]?.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (MODES[i] !== mode) onChange({ mode: MODES[i]! })
    }
  }
  return (
    <PopoverShell anchor={anchor} tool={tool} onClose={onClose} labelledBy={titleId} className="pen-popover eraser-popover">
      <h2 id={titleId} className="pen-popover-title">
        {t('editor.eraser')}
      </h2>
      <div className="pen-tool-switch" role="radiogroup" aria-label={t('editor.eraserModeGroup')}>
        {MODES.map((k, i) => (
          <button
            key={k}
            ref={(el) => void (btns.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={mode === k}
            tabIndex={mode === k ? 0 : -1}
            onClick={() => k !== mode && onChange({ mode: k })}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t(k === 'partial' ? 'editor.eraserPartial' : 'editor.eraserStroke')}
          </button>
        ))}
      </div>
      <button
        type="button"
        role="switch"
        tabIndex={0}
        aria-checked={returnToPen}
        aria-labelledby={labelId}
        className="pen-popover-switch"
        onClick={() => onChange({ returnToPen: !returnToPen })}
      >
        <span id={labelId}>{t('editor.eraserReturn')}</span>
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </button>
    </PopoverShell>
  )
}
