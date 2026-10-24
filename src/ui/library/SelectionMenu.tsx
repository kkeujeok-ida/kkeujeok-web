import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fmt, useI18n } from '../../i18n'
import { defaultPenSlots } from '../../model/pen'
import { ROTATE_GAP } from '../../render/selectionPainter'
import { COLOR_NAME } from './PenToolbar'
import type { SelectionBox } from './writer'

/** The menu opens above the selection box (below when there is no room). The left-handed setting (Epic 10) flips this one value. */
export const menuPrefersAbove = true
/** Room kept between the box and the menu: the rotate handle (and its radius) hangs above the box. */
const ABOVE_CLEARANCE = ROTATE_GAP + 12
const BELOW_CLEARANCE = 12

/**
 * The floating menu of a selection: [색] [두께] (strokes only) [복사] [잘라내기] [삭제] [비율 잠금] [크게] [작게] [90° 회전].
 * It follows the box, stays on screen and is hidden when the box is. It sits right after the canvas in the DOM, so Tab
 * from the canvas enters it; Esc closes an open popover, else returns to the canvas.
 */
export function SelectionMenu({ box, origin, ratioLock, onRatioLock, onScale, onRotate, onColor, onWidth, onCopy, onCut, onDelete, onLeave }: {
  box: SelectionBox
  /** Where the canvas starts inside the menu's positioned parent. */
  origin: { x: number; y: number }
  ratioLock: boolean
  onRatioLock: () => void
  onScale: (factor: number) => void
  onRotate: () => void
  onColor: (color: string) => void
  onWidth: (width: number) => void
  onCopy: () => void
  onCut: () => void
  onDelete: () => void
  /** Esc: focus goes back to the canvas. */
  onLeave: () => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 220, h: 68 })
  const [pop, setPop] = useState<'color' | 'width' | null>(null)
  const [width, setWidth] = useState(box.width ?? 2)
  const dirty = useRef(false)
  const strokes = box.strokes === true
  useEffect(() => {
    if (!dirty.current) setWidth(box.width ?? 2)
  }, [box.width])
  useEffect(() => {
    if (!strokes) setPop(null)
  }, [strokes])
  // One drag or key run of the slider is one op, sent when it ends.
  const closePop = () => {
    dirty.current = false
    setWidth(box.width ?? 2)
    setPop(null)
  }
  const commitWidth = () => {
    if (!dirty.current) return
    dirty.current = false
    onWidth(width)
  }
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
    if (pop) return closePop()
    onLeave()
  }
  const btn = (label: string, onClick: () => void, extra: Record<string, unknown> = {}) => (
    <button type="button" className="toolbar-action selection-menu-btn" title={label} onClick={onClick} {...extra}>
      {label}
    </button>
  )
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
      {strokes && btn(t('editor.strokeColor'), () => (pop === 'color' ? closePop() : setPop('color')), { 'aria-expanded': pop === 'color' })}
      {strokes && btn(t('editor.strokeWidth'), () => (pop === 'width' ? closePop() : setPop('width')), { 'aria-expanded': pop === 'width' })}
      {btn(t('editor.copy'), onCopy)}
      {btn(t('editor.cut'), onCut)}
      {btn(t('editor.delete'), onDelete)}
      {btn(t('editor.ratioLock'), onRatioLock, { 'aria-pressed': ratioLock })}
      {btn(t('editor.scaleUp'), () => onScale(1.25))}
      {btn(t('editor.scaleDown'), () => onScale(0.8))}
      {btn(t('editor.rotate90'), onRotate)}
      {pop === 'color' && (
        <div className="selection-pop" role="group" aria-label={t('editor.strokeColor')}>
          {defaultPenSlots.map((pen) => (
            <button
              key={pen.color}
              type="button"
              className="selection-swatch"
              aria-label={t(COLOR_NAME[pen.colorName])}
              title={t(COLOR_NAME[pen.colorName])}
              style={{ background: pen.color }}
              onClick={() => {
                onColor(pen.color)
                setPop(null)
              }}
            />
          ))}
        </div>
      )}
      {pop === 'width' && (
        <div className="selection-pop" role="group" aria-label={t('editor.strokeWidth')}>
          <input
            type="range"
            min={0.5}
            max={10}
            step={0.1}
            value={width}
            aria-label={t('editor.strokeWidth')}
            aria-valuetext={fmt(t('editor.strokeWidthValue'), { w: width.toFixed(1) })}
            onChange={(e) => {
              dirty.current = true
              setWidth(Number(e.target.value))
            }}
            onPointerUp={commitWidth}
            onPointerCancel={closePop}
            onKeyUp={commitWidth}
            onBlur={commitWidth}
          />
          <span aria-hidden="true">{width.toFixed(1)}</span>
        </div>
      )}
    </div>
  )
}
