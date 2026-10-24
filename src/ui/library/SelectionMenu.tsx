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

// The Material icons the Android menu uses (24 x 24).
const ICON = {
  color: 'M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  width: 'M3 17h18v-2H3v2zm0 3h18v-1H3v1zm0-7h18v-3H3v3zm0-9v4h18V4H3z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  cut: 'M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  unlock: 'M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z',
  zoomIn: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm2.5-4h-2v2H9v-2H7V9h2V7h1v2h2v1z',
  zoomOut: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z',
  rotate: 'M15.55 5.55L11 1v3.07a8 8 0 0 0 0 15.86v-2.02a6 6 0 0 1 0-11.82V10l4.55-4.45zM19.93 11a7.9 7.9 0 0 0-1.62-3.89l-1.42 1.42a5.9 5.9 0 0 1 1.02 2.47h2.02zM13 17.9v2.02a7.92 7.92 0 0 0 3.9-1.61l-1.44-1.44c-.75.5-1.6.86-2.46 1.03zm3.89-2.42l1.42 1.41A7.9 7.9 0 0 0 19.93 13h-2.02a5.9 5.9 0 0 1-1.02 2.48z',
}

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
  const [size, setSize] = useState({ w: 340, h: 40 })
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
  const btn = (label: string, icon: string, onClick: () => void, extra: Record<string, unknown> = {}) => (
    <button type="button" className="toolbar-action selection-menu-btn" title={label} aria-label={label} onClick={onClick} {...extra}>
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={icon} fill="currentColor" />
      </svg>
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
      {strokes && btn(t('editor.strokeColor'), ICON.color, () => (pop === 'color' ? closePop() : setPop('color')), { 'aria-expanded': pop === 'color' })}
      {strokes && btn(t('editor.strokeWidth'), ICON.width, () => (pop === 'width' ? closePop() : setPop('width')), { 'aria-expanded': pop === 'width' })}
      {btn(t('editor.copy'), ICON.copy, onCopy)}
      {btn(t('editor.cut'), ICON.cut, onCut)}
      {btn(t('editor.delete'), ICON.delete, onDelete)}
      {btn(t('editor.ratioLock'), ratioLock ? ICON.lock : ICON.unlock, onRatioLock, { 'aria-pressed': ratioLock })}
      {btn(t('editor.scaleUp'), ICON.zoomIn, () => onScale(1.25))}
      {btn(t('editor.scaleDown'), ICON.zoomOut, () => onScale(0.8))}
      {btn(t('editor.rotate90'), ICON.rotate, onRotate)}
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
