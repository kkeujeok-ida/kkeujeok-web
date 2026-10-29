import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { fmt, useI18n } from '../../i18n'
import { PEN_PALETTE, PEN_WIDTH, colorNameKey, snapWidth, type Pen, type PenTool } from '../../model/pen'
import { highlighterOutline, windAlike } from '../../render/highlighterOutline'
import { strokeOutline } from '../../render/strokeOutline'
import { ColorWheelPicker } from './ColorWheelPicker'
import { PopoverShell } from './PopoverShell'

const W = 240
const H = 72
const AMP = 8
const MARGIN = 32 // room for the round caps
const SCALE = 3 // the preview is drawn this much thicker than the page
const TOOLS: PenTool[] = ['pen', 'highlighter']

// A wave whose pressure rises and falls: flat when "use pressure" is off. The highlighter is the chisel rectangles in one path.
function previewPath(pen: Pen): string {
  const n = 40
  const pts = Array.from({ length: n + 1 }, (_, i) => [
    MARGIN + ((W - 2 * MARGIN) * i) / n,
    H / 2 + AMP * Math.sin((2 * Math.PI * i) / n),
    0.1 + 0.8 * Math.sin((Math.PI * i) / n),
    i * 10,
  ])
  if (pen.tool === 'highlighter') {
    // The nib reaches 0.36 of the width from the line in every direction.
    const w = Math.min(pen.width * SCALE, (H / 2 - 2 - AMP) / 0.36, (MARGIN - 2) / 0.36)
    return windAlike(highlighterOutline(w, pts))
      .map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('') + 'Z')
      .join('')
  }
  // A radius is at most 1.75x half the width: keep the stroke inside the box.
  const w = Math.min(pen.width * SCALE, (H / 2 - 2 - AMP) / 0.875, (MARGIN - 2) / 0.875)
  const poly = strokeOutline(w, pen.usePressure, pts)
  return poly.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('') + 'Z'
}

/**
 * The pen edit popover: tool switch and name, palette, recent colors, width, "use pressure" (pens), preview, delete.
 * Modal: the scrim takes the pointer, Tab cycles the stops inside, Esc and a press outside close it.
 * The owner puts focus back on the slot in onClose. Every change is passed on at once.
 */
export function PenPopover({ pen, anchor, recent, canDelete, onChange, onRecent, onDelete, onClose }: {
  pen: Pen
  anchor: HTMLElement | null
  /** Recent colors, newest first (at most 6). */
  recent: readonly string[]
  /** False with one slot left: [도구 삭제] is off. */
  canDelete: boolean
  /** `{tool}` switches the tool (the owner resets the slot to that tool's defaults); anything else patches the slot. */
  onChange: (patch: Partial<Pen>) => void
  /** A color was applied: record it as recent. */
  onRecent: (hex: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const toolBtns = useRef<(HTMLButtonElement | null)[]>([])
  const cells = useRef<(HTMLButtonElement | null)[]>([])
  const recents = useRef<(HTMLButtonElement | null)[]>([])
  const titleId = useId()
  const labelId = useId()
  const widthId = useId()
  const live = useRef({ onChange, onRecent })
  live.current = { onChange, onRecent }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => toolBtns.current[TOOLS.indexOf(pen.tool)]?.focus(), [])

  const { colors, columns } = PEN_PALETTE[pen.tool]
  const customIdx = colors.length
  const color = pen.color.toLowerCase()
  const checkedIdx = colors.includes(color) ? colors.indexOf(color) : customIdx
  // Keyboard focus moves without applying; null = follow the checked cell.
  const [palFocus, setPalFocus] = useState<number | null>(null)
  const [recFocus, setRecFocus] = useState(0)
  const palStop = palFocus !== null && palFocus <= customIdx ? palFocus : checkedIdx
  const recStop = Math.min(recFocus, recent.length - 1)

  // The wheel picker replaces the bubble's content; colors are recorded as recent when it closes (also when the popover does).
  const [picking, setPicking] = useState(false)
  const picked = useRef<string | null>(null)
  const finishPick = () => {
    if (picked.current) live.current.onRecent(picked.current)
    picked.current = null
  }
  useEffect(() => finishPick, []) // eslint-disable-line react-hooks/exhaustive-deps -- finishPick reads refs only

  const apply = (hex: string) => {
    onChange({ color: hex })
    onRecent(hex)
    setPalFocus(null)
  }
  const openPicker = () => setPicking(true)
  // Arrow keys move focus only (no wrap): Enter, Space or a click applies.
  const gridKeys = (e: KeyboardEvent, i: number, count: number, cols: number, refs: (HTMLElement | null)[], setStop: (n: number) => void, activate: () => void) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : e.key === 'ArrowDown' ? cols : 0
    if (step) {
      e.preventDefault()
      const to = i + step
      if (to >= 0 && to < count) {
        setStop(to)
        refs[to]?.focus()
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate()
    }
  }

  const setWidth = (v: number) => {
    const w = snapWidth(v, pen.tool)
    if (w !== pen.width) onChange({ width: w })
  }
  const range = PEN_WIDTH[pen.tool]

  const cellProps = (i: number, stop: number, hex: string | null, checked: boolean, refs: (HTMLButtonElement | null)[]) => {
    const name = t(hex ? colorNameKey(hex) : 'editor.colorCustom')
    return {
      ref: (el: HTMLButtonElement | null) => void (refs[i] = el),
      type: 'button' as const,
      role: 'radio' as const,
      'aria-checked': checked,
      'aria-label': name,
      title: name,
      tabIndex: i === stop ? 0 : -1,
    }
  }

  return (
    <PopoverShell anchor={anchor} onClose={onClose} labelledBy={titleId} className="pen-popover" relayout={`${pen.tool}${recent.length}${picking}`}>
        {picking ? (
          <ColorWheelPicker
            color={color}
            onChange={(hex) => {
              picked.current = hex
              onChange({ color: hex })
            }}
            onDone={() => {
              finishPick()
              setPicking(false)
              requestAnimationFrame(() => cells.current[customIdx]?.focus())
            }}
          />
        ) : (
          <>
        <div className="pen-tool-switch" role="radiogroup" aria-label={t('editor.toolKind')}>
          {TOOLS.map((k, i) => (
            <button
              key={k}
              ref={(el) => void (toolBtns.current[i] = el)}
              type="button"
              role="radio"
              aria-checked={pen.tool === k}
              aria-label={t(`editor.tool.${k}`)}
              title={t(`editor.tool.${k}`)}
              tabIndex={pen.tool === k ? 0 : -1}
              onClick={() => k !== pen.tool && onChange({ tool: k })}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault()
                  toolBtns.current[i + (e.key === 'ArrowLeft' ? -1 : 1)]?.focus()
                } else if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (k !== pen.tool) onChange({ tool: k })
                }
              }}
            >
              <svg viewBox="0 0 20 36" width="12" height="22" aria-hidden="true">
                <path d={k === 'highlighter' ? 'M3 0V22.3L6 36H14L17 22.3V0M3 22.3H17' : 'M3 0V22.3L10 36L17 22.3V0M3 22.3H17'} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            </button>
          ))}
        </div>
        <h2 id={titleId} className="pen-popover-title">
          {t(`editor.tool.${pen.tool}`)}
        </h2>
        <div className="pen-palette" role="radiogroup" aria-label={t('editor.palette')} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {colors.map((hex, i) => (
            <button
              key={hex}
              {...cellProps(i, palStop, hex, i === checkedIdx, cells.current)}
              className="pen-color-cell"
              style={{ background: hex }}
              onClick={() => apply(hex)}
              onKeyDown={(e) => gridKeys(e, i, customIdx + 1, columns, cells.current, setPalFocus, () => apply(hex))}
            />
          ))}
          <button
            {...cellProps(customIdx, palStop, null, checkedIdx === customIdx, cells.current)}
            className="pen-color-cell pen-custom-cell"
            onClick={openPicker}
            onKeyDown={(e) => gridKeys(e, customIdx, customIdx + 1, columns, cells.current, setPalFocus, openPicker)}
          />
        </div>
        <div className="pen-caption">{t('editor.recent')}</div>
        <div className="pen-recent" role="radiogroup" aria-label={t('editor.recent')}>
          {recent.map((hex, i) => (
            <button
              key={hex}
              {...cellProps(i, recStop, hex, hex === color, recents.current)}
              className="pen-color-cell"
              style={{ background: hex }}
              onClick={() => apply(hex)}
              onKeyDown={(e) => gridKeys(e, i, recent.length, recent.length, recents.current, setRecFocus, () => apply(hex))}
            />
          ))}
        </div>
        <div id={widthId} className="pen-caption">
          {fmt(t('editor.widthCaption'), { width: pen.width.toFixed(1) })}
        </div>
        {/* DOM (Tab) order: slider, down, up; CSS shows down, slider, up. */}
        <div className="pen-width-row">
          <input
            type="range"
            tabIndex={0}
            className="pen-width-slider"
            min={range.min}
            max={range.max}
            step={0.1}
            value={pen.width}
            aria-labelledby={widthId}
            onChange={(e) => setWidth(Number(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                setWidth(pen.width + (e.key === 'ArrowLeft' ? -0.1 : 0.1))
              }
            }}
          />
          <button
            type="button"
            tabIndex={0}
            aria-disabled={pen.width <= range.min}
            aria-label={t('editor.widthDown')}
            className="pen-step pen-step-down"
            onClick={() => setWidth(pen.width - 0.1)}
          >
            ‹
          </button>
          <button
            type="button"
            tabIndex={0}
            aria-disabled={pen.width >= range.max}
            aria-label={t('editor.widthUp')}
            className="pen-step"
            onClick={() => setWidth(pen.width + 0.1)}
          >
            ›
          </button>
        </div>
        {pen.tool === 'pen' && (
          <button
            type="button"
            role="switch"
            tabIndex={0}
            aria-checked={pen.usePressure}
            aria-labelledby={labelId}
            className="pen-popover-switch"
            onClick={() => onChange({ usePressure: !pen.usePressure })}
          >
            <span id={labelId}>{t('editor.usePressure')}</span>
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          </button>
        )}
        <svg className="pen-preview" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <path d={previewPath(pen)} fill={pen.color} fillOpacity={pen.tool === 'highlighter' ? 0.4 : undefined} />
        </svg>
        <button
          type="button"
          tabIndex={0}
          aria-disabled={!canDelete}
          className="pen-popover-delete"
          onClick={() => canDelete && onDelete()}
        >
          {t('editor.deleteSlot')}
        </button>
          </>
        )}
    </PopoverShell>
  )
}
