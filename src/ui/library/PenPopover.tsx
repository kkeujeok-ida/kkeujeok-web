import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import type { Pen } from '../../model/pen'
import { strokeOutline } from '../../render/strokeOutline'

const W = 240
const H = 72
const AMP = 8
const MARGIN = 32 // room for the round caps
const SCALE = 3 // the preview is drawn this much thicker than the page

// A wave whose pressure rises and falls: flat when "use pressure" is off.
function previewPath(pen: Pen): string {
  const n = 40
  const pts = Array.from({ length: n + 1 }, (_, i) => [
    MARGIN + ((W - 2 * MARGIN) * i) / n,
    H / 2 + AMP * Math.sin((2 * Math.PI * i) / n),
    0.1 + 0.8 * Math.sin((Math.PI * i) / n),
    i * 10,
  ])
  // A radius is at most 1.75x half the width: keep the stroke inside the box.
  const w = Math.min(pen.width * SCALE, (H / 2 - 2 - AMP) / 0.875, (MARGIN - 2) / 0.875)
  const poly = strokeOutline(w, pen.usePressure, pts)
  return poly.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('') + 'Z'
}

/**
 * The pen edit popover: tool name, "use pressure" switch, preview stroke.
 * Modal: the scrim takes the pointer, Tab stays on the switch, Esc and a press
 * outside close it. The owner puts focus back on the slot in onClose.
 */
export function PenPopover({ pen, anchor, onUsePressure, onClose }: {
  pen: Pen
  anchor: HTMLElement | null
  onUsePressure: (v: boolean) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const sw = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const labelId = useId()
  useEffect(() => sw.current?.focus(), [])
  // Below the toolbar, kept inside the viewport; recomputed on resize.
  const place = () => {
    const r = anchor?.closest('[role="toolbar"]')?.getBoundingClientRect()
    if (!r) return undefined
    const margin = 12
    const width = Math.min(320, window.innerWidth - margin * 2)
    return {
      top: Math.max(margin, Math.min(r.bottom, window.innerHeight - 160)),
      left: Math.max(margin, Math.min(r.left, window.innerWidth - width - margin)),
    }
  }
  const [pos, setPos] = useState(place)
  useEffect(() => {
    const on = () => setPos(place())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
    // place reads the current anchor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      e.preventDefault() // the switch is the only stop
      sw.current?.focus()
    }
  }
  return (
    <div
      className="pen-popover-scrim"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="pen-popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={pos}
      >
        <h2 id={titleId} className="pen-popover-title">
          {t('editor.penEditTitle')}
        </h2>
        <button
          ref={sw}
          type="button"
          role="switch"
          aria-checked={pen.usePressure}
          aria-labelledby={labelId}
          className="pen-popover-switch"
          onClick={() => onUsePressure(!pen.usePressure)}
        >
          <span id={labelId}>{t('editor.usePressure')}</span>
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </button>
        <svg className="pen-preview" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <path d={previewPath(pen)} fill={pen.color} />
        </svg>
      </div>
    </div>
  )
}
