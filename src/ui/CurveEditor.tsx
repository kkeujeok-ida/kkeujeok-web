import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { MAX_INNER, pressureCurve } from '../model/pressureCurve'
import { tiltSizeFactor } from '../model/brush'
import { strokeOutline, strokeOutlineFor } from '../render/strokeOutline'
import { penLean } from './library/writer'

const PREVIEW_WIDTH = 6
const SIZE = 220 // graph side, CSS px
const EPS = 0.01 // least gap between neighbouring points

type Pt = [number, number]
const toPts = (v: readonly number[]): Pt[] => Array.from({ length: Math.floor(v.length / 2) }, (_, i) => [v[2 * i]!, v[2 * i + 1]!])

/** Point i of p moved to (x, y), held between its neighbours; null when there is no room. */
function clampAt(p: Pt[], i: number, x: number, y: number): Pt | null {
  const lo = i === 0 ? [0, 0] : p[i - 1]!
  const hi = i === p.length - 1 ? [1, 1] : p[i + 1]!
  if (hi[0]! - lo[0]! < 2 * EPS) return null
  return [Math.min(hi[0]! - EPS, Math.max(lo[0]! + EPS, x)), Math.min(hi[1]!, Math.max(lo[1]!, y))]
}

export type CurveEditorProps = {
  /** The inner points `[x1, y1, x2, y2, ...]`; the curve also passes (0,0) and (1,1). */
  value: readonly number[]
  onChange: (next: number[]) => void
  /** `pressure`: the test pad draws with the pen's pressure; `tilt`: with the pen's tilt as the width. */
  mode?: 'pressure' | 'tilt'
  /** A fixed number of points (no add or remove), e.g. the 2 points of a brush curve. */
  fixedCount?: number
  /** Label keys are `${i18n}.graph|in|out|add|remove|reset|pad`. */
  i18n?: string
  onReset?: () => void
  /** The device curve a pressure test stroke is drawn with when `mode` is `pressure`; defaults to `value`. */
  curveOf?: (value: readonly number[]) => Parameters<typeof strokeOutline>[3]
}

/** A curve graph with draggable, keyboard-movable points, number sliders, and a pen-only test pad (pen-feel.md, brush.md). */
export function CurveEditor({ value, onChange, mode = 'pressure', fixedCount, i18n = 'settings.pressureCurve', onReset, curveOf }: CurveEditorProps) {
  const { t } = useI18n()
  const k = (name: string) => t(`${i18n}.${name}` as never)
  const p = toPts(value)
  const [sel, setSel] = useState(-1)
  const drag = useRef(-1)
  const lastTap = useRef({ i: -1, at: 0 })
  const pad = useRef<HTMLCanvasElement>(null)
  const pts = useRef<number[][]>([])
  const [drawing, setDrawing] = useState(false)
  const selected = sel >= 0 && sel < p.length ? sel : -1
  const fixed = fixedCount !== undefined

  const save = (next: Pt[]) => onChange(next.flat())
  const remove = (i: number) => {
    if (fixed || i < 0) return
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
        ? strokeOutlineFor('pen', PREVIEW_WIDTH, false, pts.current, 'normal', (q) => tiltSizeFactor(q, value))
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
  const at = (e: React.PointerEvent<SVGSVGElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect()
    return [(e.clientX - r.left) / SIZE, 1 - (e.clientY - r.top) / SIZE]
  }
  const graphDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const [x, y] = at(e)
    let i = p.findIndex((q) => Math.hypot((q[0] - x) * SIZE, (q[1] - y) * SIZE) < 22)
    if (i >= 0) {
      const again = i === lastTap.current.i && e.timeStamp - lastTap.current.at < 350
      lastTap.current = { i: again ? -1 : i, at: e.timeStamp }
      if (again && !fixed) return remove(i)
    } else if (!fixed && p.length < MAX_INNER) {
      lastTap.current = { i: -1, at: 0 }
      i = p.findIndex((q) => q[0] > x)
      if (i < 0) i = p.length
      const next = [...p.slice(0, i), [x, y] as Pt, ...p.slice(i)]
      const c = clampAt(next, i, x, y)
      if (!c) return
      next[i] = c
      save(next)
    } else return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = i
    setSel(i)
  }
  const graphMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current < 0 || drag.current >= p.length) return
    const c = clampAt(p, drag.current, ...at(e))
    if (c) save(p.map((q, k) => (k === drag.current ? c : q)))
  }
  // A point on the curve in the widest gap.
  const addMid = () => {
    const xs = [0, ...p.map((q) => q[0]), 1]
    let g = 0
    for (let k = 1; k < xs.length - 1; k++) if (xs[k + 1]! - xs[k]! > xs[g + 1]! - xs[g]!) g = k
    const x = (xs[g]! + xs[g + 1]!) / 2
    setSel(g)
    save([...p.slice(0, g), [x, pressureCurve(value, x)] as Pt, ...p.slice(g)])
  }
  const edit = (axis: 0 | 1, v: number) => selected >= 0 && save(p.map((q, k) => (k === selected ? (axis ? [q[0], v] : [v, q[1]]) : q) as Pt))
  // A focused point moves with the arrow keys (Shift: 5 times as far); Delete removes it.
  const key = (i: number, e: React.KeyboardEvent) => {
    const d = (e.shiftKey ? 0.05 : 0.01) * (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      return remove(i)
    }
    if (!d) return
    e.preventDefault()
    const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
    const c = clampAt(p, i, p[i]![0] + (horizontal ? d : 0), p[i]![1] + (horizontal ? 0 : d))
    if (c) save(p.map((q, k) => (k === i ? c : q)))
  }
  const prev: Pt = selected > 0 ? p[selected - 1]! : [0, 0]
  const next: Pt = selected >= 0 && selected < p.length - 1 ? p[selected + 1]! : [1, 1]

  const line = Array.from({ length: 65 }, (_, i) => `${(i / 64) * SIZE},${(1 - pressureCurve(value, i / 64)) * SIZE}`).join(' ')
  return (
    <>
      <div className="pressure-row">
        <svg
          className="pressure-graph"
          width={SIZE}
          height={SIZE}
          role="group"
          aria-label={k('graph')}
          onPointerDown={graphDown}
          onPointerMove={graphMove}
          onPointerUp={() => (drag.current = -1)}
          onPointerCancel={() => (drag.current = -1)}
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
              aria-label={`${k('graph')} ${i + 1}`}
              aria-valuetext={`${k('in')} ${q[0].toFixed(2)}, ${k('out')} ${q[1].toFixed(2)}`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={q[1]}
              onFocus={() => setSel(i)}
              onKeyDown={(e) => key(i, e)}
            />
          ))}
        </svg>
        <div className="pressure-sliders">
          {selected >= 0 &&
            ([0, 1] as const).map((axis) => (
              <label key={axis} className="option">
                <span>{k(axis ? 'out' : 'in')}</span>
                <input
                  type="range"
                  className="setting-range"
                  min={axis ? prev[1] : prev[0] + EPS}
                  max={axis ? next[1] : next[0] - EPS}
                  step={0.01}
                  value={p[selected]![axis]}
                  onChange={(e) => edit(axis, Number(e.target.value))}
                />
                <output>{p[selected]![axis].toFixed(2)}</output>
              </label>
            ))}
        </div>
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
      </div>
      <div className="pressure-graph-actions">
        {!fixed && (
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
