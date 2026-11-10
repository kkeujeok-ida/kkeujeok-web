import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { type Pt, curveEdit, isPointList } from '../model/curve'
import { MAX_INNER, pressureCurve } from '../model/pressureCurve'
import { tiltSizeFactor } from '../model/brush'
import { strokeOutline, strokeOutlineFor } from '../render/strokeOutline'
import { penLean } from './library/writer'

const PREVIEW_WIDTH = 6
const SIZE = 220 // graph side, CSS px (at least 160)
const EPS = 0.01 // least gap between neighbouring points of a legacy curve

const toPts = (v: readonly number[]): Pt[] => Array.from({ length: Math.floor(v.length / 2) }, (_, i) => [v[2 * i]!, v[2 * i + 1]!])

/** Legacy curve: point i of p moved to (x, y), held between its neighbours; null when there is no room. (A point list uses `curveEdit`.) */
function clampAt(p: Pt[], i: number, x: number, y: number): Pt | null {
  const lo = i === 0 ? [0, 0] : p[i - 1]!
  const hi = i === p.length - 1 ? [1, 1] : p[i + 1]!
  if (hi[0]! - lo[0]! < 2 * EPS) return null
  return [Math.min(hi[0]! - EPS, Math.max(lo[0]! + EPS, x)), Math.min(hi[1]!, Math.max(lo[1]!, y))]
}

export type CurveEditorProps = {
  /** The inner points `[x1, y1, x2, y2, ...]` (the curve also passes (0,0) and (1,1)), or a point list `[[x, y], ...]` with free end values (brush.md). */
  value: readonly number[] | readonly (readonly number[])[]
  onChange(next: number[] | Pt[]): void
  /** `pressure`: the test pad draws with the pen's pressure; `tilt`: with the pen's tilt as the width. */
  mode?: 'pressure' | 'tilt'
  /** A fixed number of points (no add or remove). */
  fixedCount?: number
  /** Label keys are `${i18n}.graph|in|out|add|remove|reset|pad`. */
  i18n?: string
  onReset?: () => void
  /** The device curve a pressure test stroke is drawn with when `mode` is `pressure`; defaults to `value`. */
  curveOf?: (value: CurveEditorProps['value']) => Parameters<typeof strokeOutline>[3]
  /** false: no test pad (e.g. for a curve that is not a width). */
  pad?: boolean
  /** Name of the graph for screen readers; defaults to `${i18n}.graph`. */
  label?: string
  /** Called at pointer down on the graph, before the edit (a curve switched off turns on here, brush.md "Curve switches"). */
  onTouch?: () => void
}

/**
 * A curve graph with draggable, keyboard-movable points and an optional pen-only test pad (pen-feel.md, brush.md `brush.curveEdit`).
 * A point list adds a point by touching off the line, and deletes an inner point dragged out of the graph or by Delete; there is no value popup.
 */
export function CurveEditor({ value, onChange, mode = 'pressure', fixedCount, i18n = 'settings.pressureCurve', onReset, curveOf, pad: showPad = true, label, onTouch }: CurveEditorProps) {
  const { t } = useI18n()
  const k = (name: string) => t(`${i18n}.${name}` as never)
  const graphLabel = label ?? k('graph')
  const points = isPointList(value)
  const p = points ? (value as Pt[]) : toPts(value as number[])
  const [sel, setSel] = useState(-1)
  const drag = useRef(-1)
  const pad = useRef<HTMLCanvasElement>(null)
  const pts = useRef<number[][]>([])
  const [drawing, setDrawing] = useState(false)
  const selected = sel >= 0 && sel < p.length ? sel : -1
  const fixed = fixedCount !== undefined

  const save = (next: Pt[]) => onChange(points ? next : next.flat())
  const remove = (i: number) => {
    if (fixed || i < 0 || (points && (i === 0 || i === p.length - 1))) return
    setSel(-1)
    save(p.filter((_, k) => k !== i))
  }

  const paint = () => {
    const c = pad.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    if (pts.current.length === 0) return
    const k = c.width / (c.clientWidth || c.width)
    ctx.fillStyle = getComputedStyle(c).color
    ctx.beginPath()
    const poly =
      mode === 'tilt'
        ? strokeOutlineFor('pen', PREVIEW_WIDTH, false, pts.current, 'normal', (q) => tiltSizeFactor(q, value as never))
        : strokeOutline(PREVIEW_WIDTH, true, pts.current, curveOf ? curveOf(value) : (value as never))
    for (const [i, q] of poly.entries()) {
      if (i) ctx.lineTo(q[0]! * k, q[1]! * k)
      else ctx.moveTo(q[0]! * k, q[1]! * k)
    }
    ctx.closePath()
    ctx.fill()
  }
  useEffect(paint, [value]) // an earlier test stroke is drawn again with the new curve

  const add = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const base = [e.clientX - r.left, e.clientY - r.top, mode === 'tilt' ? 0.5 : e.pressure, 0]
    pts.current.push(mode === 'tilt' ? [...base, ...(penLean(e.nativeEvent) ?? [0, 0])] : base)
    paint()
  }
  const box = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return [(e.clientX - r.left) / SIZE, (e.clientY - r.top) / SIZE] as const
  }
  const at = (e: React.PointerEvent<SVGSVGElement>): Pt => {
    const [x, y] = box(e)
    return [x, 1 - y]
  }
  const graphDown = (e: React.PointerEvent<SVGSVGElement>) => {
    onTouch?.()
    const [x, y] = at(e)
    let i = p.findIndex((q) => Math.hypot((q[0] - x) * SIZE, (q[1] - y) * SIZE) < 22)
    if (i < 0 && !fixed) {
      if (points) {
        const next = curveEdit(p, { kind: 'add', x, y })
        if (next.length === p.length) return // on the line, near a point, or full
        i = next.findIndex((q) => !p.some((o) => o[0] === q[0] && o[1] === q[1]))
        save(next)
      } else if (p.length < MAX_INNER) {
        i = p.findIndex((q) => q[0] > x)
        if (i < 0) i = p.length
        const next = [...p.slice(0, i), [x, y] as Pt, ...p.slice(i)]
        const c = clampAt(next, i, x, y)
        if (!c) return
        next[i] = c
        save(next)
      }
    }
    if (i < 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // no capture (a test environment): the move events still reach the graph
    }
    drag.current = i
    setSel(i)
  }
  const graphMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current < 0 || drag.current >= p.length) return
    const [x, y] = at(e)
    if (points) return save(curveEdit(p, { kind: 'move', index: drag.current, x, y }))
    const c = clampAt(p, drag.current, x, y)
    if (c) save(p.map((q, k) => (k === drag.current ? c : q)))
  }
  // Letting go beyond the graph box deletes an inner point (brush.curveEdit `release`; a legacy curve uses the same distance).
  const graphUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const i = drag.current
    drag.current = -1
    if (i < 0 || fixed || e.type === 'pointercancel') return
    const [x, y] = box(e)
    const over = (v: number) => Math.max(-v, v - 1, 0)
    const outside = Math.max(over(x), over(y))
    if (outside <= 0.08) return
    if (!points) return remove(i)
    const next = curveEdit(p, { kind: 'release', index: i, outside })
    if (next.length !== p.length) {
      setSel(-1)
      save(next)
    }
  }
  // A point on the curve in the widest gap (legacy curve only; a point list adds by touch).
  const addMid = () => {
    const xs = [0, ...p.map((q) => q[0]), 1]
    let g = 0
    for (let k = 1; k < xs.length - 1; k++) if (xs[k + 1]! - xs[k]! > xs[g + 1]! - xs[g]!) g = k
    const x = (xs[g]! + xs[g + 1]!) / 2
    setSel(g)
    save([...p.slice(0, g), [x, pressureCurve(value, x)] as Pt, ...p.slice(g)])
  }
  // A focused point moves with the arrow keys (Shift: 5 times as far); Delete removes an inner point.
  const key = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (fixed) return
      if (!points) return remove(i)
      const next = curveEdit(p, { kind: 'release', index: i, outside: 1 })
      if (next.length !== p.length) {
        setSel(-1)
        save(next)
      }
      return
    }
    const d = (e.shiftKey ? 0.05 : 0.01) * (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0)
    if (!d) return
    e.preventDefault()
    const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
    const x = p[i]![0] + (horizontal ? d : 0)
    const y = p[i]![1] + (horizontal ? 0 : d)
    if (points) return save(curveEdit(p, { kind: 'move', index: i, x, y }))
    const c = clampAt(p, i, x, y)
    if (c) save(p.map((q, k) => (k === i ? c : q)))
  }

  const line = Array.from({ length: 65 }, (_, i) => `${(i / 64) * SIZE},${(1 - pressureCurve(value, i / 64)) * SIZE}`).join(' ')
  return (
    <>
      <div className="pressure-row">
        <svg
          className="pressure-graph"
          width={SIZE}
          height={SIZE}
          role="group"
          aria-label={graphLabel}
          onPointerDown={graphDown}
          onPointerMove={graphMove}
          onPointerUp={graphUp}
          onPointerCancel={graphUp}
        >
          {[1, 2, 3].map((i) => (
            <path key={i} className="grid" d={`M${(SIZE * i) / 4} 0V${SIZE}M0 ${(SIZE * i) / 4}H${SIZE}`} />
          ))}
          <polyline className="curve" points={line} />
          {p.map((q, i) => (
            <circle
              key={i}
              className={i === selected ? 'dot is-selected' : 'dot'}
              cx={q[0] * SIZE}
              cy={(1 - q[1]) * SIZE}
              r={i === selected ? 8 : 6}
              tabIndex={0}
              role="slider"
              aria-label={`${graphLabel} ${i + 1}`}
              aria-valuetext={`${k('in')} ${q[0].toFixed(2)}, ${k('out')} ${q[1].toFixed(2)}`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={q[1]}
              onFocus={() => setSel(i)}
              onKeyDown={(e) => key(i, e)}
            />
          ))}
        </svg>
        {showPad && (
          <canvas
            ref={pad}
            className="pressure-pad"
            role="img"
            aria-label={k('pad')}
            width={440}
            height={440}
            onPointerDown={(e) => {
              if (e.pointerType !== 'pen') return // a finger or mouse leaves the pad alone
              e.currentTarget.setPointerCapture(e.pointerId)
              pts.current = []
              setDrawing(true)
              add(e)
            }}
            onPointerMove={(e) => drawing && e.pointerType === 'pen' && add(e)}
            onPointerUp={() => setDrawing(false)}
            onPointerCancel={() => setDrawing(false)}
          />
        )}
      </div>
      <div className="pressure-graph-actions">
        {!fixed && !points && (
          <>
            <button type="button" className="btn" disabled={p.length >= MAX_INNER} onClick={addMid}>
              {k('add')}
            </button>
            <button type="button" className="btn" disabled={selected < 0} onClick={() => remove(selected)}>
              {k('remove')}
            </button>
          </>
        )}
        {onReset && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSel(-1)
              onReset()
            }}
          >
            {k('reset')}
          </button>
        )}
      </div>
    </>
  )
}
