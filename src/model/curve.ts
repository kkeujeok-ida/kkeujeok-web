// spec rule `brush.curve` (spec/brush.md): a curve is legacy `[x1, y1, x2, y2]` (always rising) or a point list `[[x, y], ...]` (ends free, can fall).
import { hermite } from './pressureCurve'

export type Pt = [number, number]
export type Curve = number[] | number[][]
export const MAX_POINTS = 8

const unit = (n: unknown): n is number => typeof n === 'number' && n >= 0 && n <= 1

export const isPointList = (c: unknown): c is number[][] => Array.isArray(c) && c.length > 0 && Array.isArray(c[0])

/** The curve in either valid form, as read; null when it is invalid. */
export function validCurve(c: unknown): Curve | null {
  if (!Array.isArray(c)) return null
  if (c.length > 0 && c.every((q) => typeof q === 'number')) {
    const [x1, y1, x2, y2] = c as number[]
    return c.length === 4 && c.every(unit) && x1! > 0 && x1! < x2! && x2! < 1 && y1! <= y2! ? (c.slice() as number[]) : null
  }
  if (c.length < 2 || c.length > MAX_POINTS) return null
  let px = -1
  for (const q of c) {
    if (!Array.isArray(q) || q.length !== 2 || !unit(q[0]) || !unit(q[1]) || q[0] <= px) return null
    px = q[0]
  }
  return c[0][0] === 0 && px === 1 ? (c.map((q) => q.slice()) as number[][]) : null
}

/**
 * y for x (clamped to 0..1) on a valid curve; null when invalid. Both forms use the Fritsch-Carlson spline: the fixture value of a legacy curve
 * (test/brush.curve.json) matches it, not the Fritsch-Butland tangents that spec/brush.md names (drawing a legacy brush curve still uses Butland, as before).
 */
export function curveEval(curve: unknown, x: number): number | null {
  const c = validCurve(curve)
  if (!c) return null
  x = Math.min(1, Math.max(0, x))
  const pts = isPointList(c) ? c : [[0, 0], [c[0]!, c[1]!], [c[2]!, c[3]!], [1, 1]]
  const xs = pts.map((q) => q[0]!)
  const ys = pts.map((q) => q[1]!)
  const n = xs.length - 1
  const d = Array.from({ length: n }, (_, k) => (ys[k + 1]! - ys[k]!) / (xs[k + 1]! - xs[k]!))
  const m = Array.from({ length: n + 1 }, (_, k) => {
    if (k === 0) return d[0]!
    if (k === n) return d[n - 1]!
    if (d[k - 1]! * d[k]! <= 0) return 0
    const t = (ys[k + 1]! - ys[k - 1]!) / (xs[k + 1]! - xs[k - 1]!)
    return Math.sign(t) * Math.min(Math.abs(t), 3 * Math.abs(d[k - 1]!), 3 * Math.abs(d[k]!))
  })
  return hermite(xs, ys, m, x)
}

/** A valid legacy curve sampled at 0, .25, .5, .75, 1; null for anything else (a point list needs no conversion). */
export function curveToPoints(curve: unknown): Pt[] | null {
  const c = validCurve(curve)
  if (!c) return null
  if (isPointList(c)) return null
  return [0, 0.25, 0.5, 0.75, 1].map((x) => [x, curveEval(c, x)!] as Pt)
}

/** `brush.opacityPressureCurve` as read when valid, else null. */
export function opacityPressureCurve(brush: unknown): Curve | null {
  return brush && typeof brush === 'object' && !Array.isArray(brush) ? validCurve((brush as Record<string, unknown>).opacityPressureCurve) : null
}

/** The point list the editor edits: a point list as it is, a legacy curve converted. */
export const editPoints = (c: unknown): Pt[] | null => (isPointList(c) ? (validCurve(c) as Pt[] | null) : curveToPoints(c))

const r4 = (v: number) => Math.sign(v) * Math.floor(Math.abs(v) * 1e4 + 0.5) / 1e4
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export type CurveEditOp =
  | { kind: 'add'; x: number; y: number }
  | { kind: 'move'; index: number; x: number; y: number }
  | { kind: 'release'; index: number; outside: number }

/** Spec rule `brush.curveEdit`: `op` applied to a point list (2 to 8 points); the output is rounded to 4 decimals. */
export function curveEdit(points: readonly (readonly number[])[], op: CurveEditOp): Pt[] {
  const p = points.map((q) => [q[0]!, q[1]!] as Pt)
  if (op.kind === 'add') {
    const x = clamp01(op.x)
    const y = clamp01(op.y)
    const onLine = Math.abs(y - (curveEval(p, x) ?? y)) <= 0.04
    const near = p.some((q) => Math.abs(q[0] - x) < 0.02)
    if (onLine && !near && p.length < MAX_POINTS) {
      const at = p.findIndex((q) => q[0] > x)
      p.splice(at < 0 ? p.length : at, 0, [x, y])
    }
  } else if (op.kind === 'move') {
    const i = op.index
    if (i >= 0 && i < p.length) {
      const y = clamp01(op.y)
      if (i === 0 || i === p.length - 1) p[i] = [p[i]![0], y]
      else {
        const lo = p[i - 1]![0] + 0.02
        const hi = p[i + 1]![0] - 0.02
        p[i] = [lo > hi ? p[i]![0] : Math.min(hi, Math.max(lo, op.x)), y]
      }
    }
  } else if (op.outside > 0.08 && op.index > 0 && op.index < p.length - 1 && p.length > 2) p.splice(op.index, 1)
  return p.map((q) => [r4(q[0]), r4(q[1])])
}
