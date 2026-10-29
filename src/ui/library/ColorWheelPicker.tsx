import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { fmt, useI18n } from '../../i18n'
import { HEX6, hexToHsv, hsvToHex, type Hsv } from '../../model/colorModel'

const RING_WIDTH = 28 // matches --ring-width in app.css
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** True when (dx, dy) from the center lies on the ring band (not in the hole, not outside). */
export const onRingBand = (dx: number, dy: number, size: number, width: number) => {
  const d = Math.hypot(dx, dy)
  return d >= size / 2 - width && d <= size / 2
}

/** `#` is optional when typing six hex digits. */
export const withHash = (raw: string) => (/^[0-9a-f]{6}$/i.test(raw) ? `#${raw}` : raw)

/**
 * A hue ring with a saturation/brightness square inside, and a HEX field. Nothing is reported until the person
 * touches it, so a palette color is never changed by an HSV round trip. `onChange` gets `#rrggbb` in lower case.
 */
export function ColorWheelPicker({ color, onChange, onDone, onCancel }: { color: string; onChange: (hex: string) => void; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color) ?? { h: 0, s: 0, v: 0 })
  const [hex, setHex] = useState(color.toLowerCase())
  const [applied, setApplied] = useState(color.toLowerCase()) // the last valid color; the field returns to it on blur
  const ring = useRef<HTMLDivElement>(null)
  const square = useRef<HTMLDivElement>(null)
  const hueThumb = useRef<HTMLDivElement>(null)
  const ringDrag = useRef(false)
  useEffect(() => hueThumb.current?.focus(), []) // Esc and the Tab trap need focus inside

  const set = (next: Hsv) => {
    const h = hsvToHex(next)
    setHsv(next)
    setHex(h)
    setApplied(h)
    onChange(h)
  }
  const capture = (e: PointerEvent) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* no capture (jsdom) */
    }
  }
  const onRing = (e: PointerEvent<HTMLDivElement>) => {
    const r = ring.current!.getBoundingClientRect()
    if (e.type === 'pointerdown') {
      ringDrag.current = onRingBand(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), r.width, RING_WIDTH)
      if (!ringDrag.current) return
      capture(e)
    } else if (!(e.buttons & 1) || !ringDrag.current) return
    const deg = (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI + 90
    set({ ...hsv, h: (deg + 360) % 360 })
  }
  const onSquare = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointerdown') capture(e)
    else if (!(e.buttons & 1)) return
    const r = square.current!.getBoundingClientRect()
    set({ ...hsv, s: clamp((e.clientX - r.left) / (r.width || 1), 0, 1), v: 1 - clamp((e.clientY - r.top) / (r.height || 1), 0, 1) })
  }
  const arrow = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowLeft' ? [-1, 0] : e.key === 'ArrowRight' ? [1, 0] : e.key === 'ArrowUp' ? [0, 1] : e.key === 'ArrowDown' ? [0, -1] : null
    if (d) e.preventDefault()
    return d && ([d[0]! * (e.shiftKey ? 10 : 1), d[1]! * (e.shiftKey ? 10 : 1)] as const)
  }
  const onRingKey = (e: KeyboardEvent) => {
    const d = arrow(e)
    if (d) set({ ...hsv, h: (hsv.h + d[0] + d[1] + 360) % 360 })
  }
  const onSquareKey = (e: KeyboardEvent) => {
    const d = arrow(e)
    if (d) set({ ...hsv, s: clamp(hsv.s + d[0] / 100, 0, 1), v: clamp(hsv.v + d[1] / 100, 0, 1) })
  }
  const typeHex = (raw: string) => {
    setHex(raw)
    const v = withHash(raw).toLowerCase()
    const parsed = HEX6.test(v) ? hexToHsv(v) : null
    if (!parsed) return // rejected: the last applied color stays
    setHsv(parsed.s && parsed.v ? parsed : { ...parsed, h: hsv.h }) // gray keeps the hue
    setApplied(v)
    onChange(v)
  }

  const pct = (n: number) => Math.round(n * 100)
  return (
    <div
      className="color-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation() // closes the picker, not the popover
          onCancel()
        }
      }}
    >
      <div className="color-wheel">
        <div className="color-ring" ref={ring} onPointerDown={onRing} onPointerMove={onRing} />
        <div
          className="color-ring-thumb"
          ref={hueThumb}
          role="slider"
          tabIndex={0}
          aria-label={t('editor.colorHue')}
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          aria-valuetext={`${Math.round(hsv.h)}° ${applied.toUpperCase()}`}
          style={{ transform: `rotate(${hsv.h}deg) translateY(calc(var(--ring-size) / -2 + var(--ring-width) / 2))`, background: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
          onKeyDown={onRingKey}
        />
        <div className="color-square" ref={square} style={{ ['--hue' as string]: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }} onPointerDown={onSquare} onPointerMove={onSquare}>
          <div
            className="color-square-thumb"
            role="slider"
            tabIndex={0}
            aria-label={t('editor.colorSv')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct(hsv.s)}
            aria-valuetext={`${fmt(t('editor.colorSvValue'), { s: pct(hsv.s), v: pct(hsv.v) })} ${applied.toUpperCase()}`}
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }}
            onKeyDown={onSquareKey}
          />
        </div>
      </div>
      <div className="color-hex-row">
        <span className="color-swatch" style={{ background: applied }} />
        <input
          className="color-hex"
          type="text"
          tabIndex={0}
          spellCheck={false}
          maxLength={7}
          aria-label={t('editor.colorHex')}
          value={hex}
          onChange={(e) => typeHex(e.target.value)}
          onBlur={() => setHex(applied)}
        />
        <button type="button" tabIndex={0} className="pen-popover-delete" onClick={onDone}>
          {t('editor.colorDone')}
        </button>
      </div>
    </div>
  )
}
