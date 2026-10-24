import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import { ROTATE_GAP } from '../../render/selectionPainter'
import type { SelectionBox } from './writer'

/** The menu opens above the selection box (below when there is no room). The left-handed setting (Epic 10) flips this one value. */
export const menuPrefersAbove = true
/** Room kept between the box and the menu: the rotate handle (and its radius) hangs above the box. */
const ABOVE_CLEARANCE = ROTATE_GAP + 12
const BELOW_CLEARANCE = 12

/**
 * The floating menu of a selection: [비율 잠금] [크게] [작게] [90° 회전]. It follows the box, stays on screen and is
 * hidden when the box is. It sits right after the canvas in the DOM, so Tab from the canvas enters it; Esc returns to the canvas.
 */
export function SelectionMenu({ box, origin, ratioLock, onRatioLock, onScale, onRotate, onLeave }: {
  box: SelectionBox
  /** Where the canvas starts inside the menu's positioned parent. */
  origin: { x: number; y: number }
  ratioLock: boolean
  onRatioLock: () => void
  onScale: (factor: number) => void
  onRotate: () => void
  /** Esc: focus goes back to the canvas. */
  onLeave: () => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 220, h: 68 })
  useLayoutEffect(() => {
    const el = ref.current
    if (el && el.offsetWidth > 0 && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight })
  })
  if (box.right < 0 || box.bottom < 0 || box.left > box.w || box.top > box.h) return null
  const above = box.top - ABOVE_CLEARANCE - size.h
  const below = box.bottom + BELOW_CLEARANCE
  const fitsAbove = above >= 0
  const fitsBelow = below + size.h <= box.h
  const top = menuPrefersAbove ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max))
  const left = clamp((box.left + box.right) / 2 - size.w / 2, box.w - size.w)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    onLeave()
  }
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('editor.selectionMenu')}
      className="selection-menu"
      data-selection-menu=""
      style={{ left: origin.x + left, top: origin.y + clamp(top, box.h - size.h) }}
      onKeyDown={onKeyDown}
    >
      <button type="button" className="toolbar-action selection-menu-btn" aria-pressed={ratioLock} title={t('editor.ratioLock')} onClick={onRatioLock}>
        {t('editor.ratioLock')}
      </button>
      <button type="button" className="toolbar-action selection-menu-btn" title={t('editor.scaleUp')} onClick={() => onScale(1.25)}>
        {t('editor.scaleUp')}
      </button>
      <button type="button" className="toolbar-action selection-menu-btn" title={t('editor.scaleDown')} onClick={() => onScale(0.8)}>
        {t('editor.scaleDown')}
      </button>
      <button type="button" className="toolbar-action selection-menu-btn" title={t('editor.rotate90')} onClick={onRotate}>
        {t('editor.rotate90')}
      </button>
    </div>
  )
}
