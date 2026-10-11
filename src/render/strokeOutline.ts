// spec rule `stroke.outline.pen` (stroke-geometry.md): the closed polygon of a
// pen stroke, built from the stored points only when drawing; never stored.
import { round2 } from '../model/number'

const DEDUPE_DISTANCE = 0.01
const SMOOTHING_PASSES = 2
const SMOOTHING_FACTOR = 0.5
const SPACING = 2.0
const MIN_RATIO = 0.25
const MAX_RATIO = 1.75
const CAP_SEGMENTS = 8

function pressure(usePressure: boolean, p: readonly number[]): number {
  if (!usePressure) return 0.5
  const v = p[2]
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0.5
  return Math.min(1, Math.max(0, v))
}

/** `points` are `[x, y, pressure, t]`. Returns `[]` for no points. */
export function strokeOutline(width: number, usePressure: boolean, points: readonly (readonly number[])[]): number[][] {
  // 1. Prepare: dedupe against the last kept point.
  const xs: number[] = []
  const ys: number[] = []
  const qs: number[] = []
  for (const p of points) {
    const x = p[0]!
    const y = p[1]!
    if (xs.length > 0 && Math.hypot(x - xs[xs.length - 1]!, y - ys[ys.length - 1]!) < DEDUPE_DISTANCE) continue
    xs.push(x)
    ys.push(y)
    qs.push(pressure(usePressure, p))
  }
  if (xs.length === 0) return []

  const radius = (q: number) => (width / 2) * (q < 0.5 ? MIN_RATIO + (1 - MIN_RATIO) * (q / 0.5) : 1 + (MAX_RATIO - 1) * ((q - 0.5) / 0.5))

  // 2. One point: a 16-point circle.
  if (xs.length === 1) {
    const r = radius(qs[0]!)
    return Array.from({ length: 16 }, (_, k) => [
      round2(xs[0]! + r * Math.cos((2 * Math.PI * k) / 16)),
      round2(ys[0]! + r * Math.sin((2 * Math.PI * k) / 16)),
    ])
  }

  // 3. Smooth x, y and q; the ends stay.
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    for (const a of [xs, ys, qs]) {
      const old = a.slice()
      for (let i = 1; i < a.length - 1; i++) {
        a[i] = old[i]! + SMOOTHING_FACTOR * ((old[i - 1]! + old[i + 1]!) / 2 - old[i]!)
      }
    }
  }

  // 4. Resample at equal arc length.
  const cum: number[] = [0]
  for (let i = 1; i < xs.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!))
  }
  const total = cum[cum.length - 1]!
  const n = Math.max(1, Math.floor(total / SPACING + 0.5))
  const sx: number[] = []
  const sy: number[] = []
  const sq: number[] = []
  let seg = 1
  for (let i = 0; i <= n; i++) {
    if (i === n) {
      sx.push(xs[xs.length - 1]!)
      sy.push(ys[ys.length - 1]!)
      sq.push(qs[qs.length - 1]!)
      break
    }
    const target = (total * i) / n
    while (seg < cum.length - 1 && cum[seg]! < target) seg++
    const len = cum[seg]! - cum[seg - 1]!
    const t = len <= 0 ? 0 : Math.min(1, Math.max(0, (target - cum[seg - 1]!) / len))
    sx.push(xs[seg - 1]! + (xs[seg]! - xs[seg - 1]!) * t)
    sy.push(ys[seg - 1]! + (ys[seg]! - ys[seg - 1]!) * t)
    sq.push(qs[seg - 1]! + (qs[seg]! - qs[seg - 1]!) * t)
  }

  // 5. Tangents (never NaN).
  const tx: number[] = new Array(n + 1).fill(1)
  const ty: number[] = new Array(n + 1).fill(0)
  for (let i = 0; i <= n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n, i + 1)
    let dx = sx[b]! - sx[a]!
    let dy = sy[b]! - sy[a]!
    let len = Math.hypot(dx, dy)
    if (len < 1e-9 && i > 0) {
      dx = sx[i]! - sx[i - 1]!
      dy = sy[i]! - sy[i - 1]!
      len = Math.hypot(dx, dy)
    }
    if (len < 1e-9) {
      if (i > 0) {
        tx[i] = tx[i - 1]!
        ty[i] = ty[i - 1]!
      }
    } else {
      tx[i] = dx / len
      ty[i] = dy / len
    }
  }

  // 6-8. Sides, caps, polygon. Normal N = (-Ty, Tx).
  const left: number[][] = []
  const right: number[][] = []
  for (let i = 0; i <= n; i++) {
    const r = radius(sq[i]!)
    left.push([sx[i]! - r * ty[i]!, sy[i]! + r * tx[i]!])
    right.push([sx[i]! + r * ty[i]!, sy[i]! - r * tx[i]!])
  }
  const rEnd = radius(sq[n]!)
  const rStart = radius(sq[0]!)
  const endCap: number[][] = []
  const startCap: number[][] = []
  for (let k = 1; k < CAP_SEGMENTS; k++) {
    const phi = (Math.PI * k) / CAP_SEGMENTS
    const c = Math.cos(phi)
    const s = Math.sin(phi)
    endCap.push([sx[n]! + rEnd * (-ty[n]! * c + tx[n]! * s), sy[n]! + rEnd * (tx[n]! * c + ty[n]! * s)])
    startCap.push([sx[0]! - rStart * (-ty[0]! * c + tx[0]! * s), sy[0]! - rStart * (tx[0]! * c + ty[0]! * s)])
  }
  return [...left, ...endCap, ...right.reverse(), ...startCap].map((p) => [round2(p[0]!), round2(p[1]!)])
}

/** The polygon as a path; fill it with the non-zero rule. */
export function outlinePath(polygon: readonly (readonly number[])[]): Path2D {
  const path = new Path2D()
  polygon.forEach((p, i) => (i === 0 ? path.moveTo(p[0]!, p[1]!) : path.lineTo(p[0]!, p[1]!)))
  if (polygon.length > 0) path.closePath()
  return path
}
