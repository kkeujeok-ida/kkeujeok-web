// spec rule `pen.pressureCurve` (pen-feel.md): maps a stored pressure p to the drawing pressure q.
/** The inner points as a flat list `[x1, y1, x2, y2, ...]`; the curve also passes (0,0) and (1,1). */
export type CurveValues = readonly number[]
export type PressureCurve = 'soft' | 'normal' | 'firm' | CurveValues
export const PRESETS = ['soft', 'normal', 'firm'] as const
export const PRESET_VALUES: Record<(typeof PRESETS)[number], CurveValues> = {
  soft: [0.2, 0.4, 0.5, 0.8],
  normal: [],
  firm: [0.5, 0.1, 0.8, 0.5],
}
export const MAX_INNER = 6

/** Even length up to 12, values in 0..1, x strictly increasing inside (0,1), y never decreasing. */
export function validCurveValues(v: unknown): v is CurveValues {
  if (!Array.isArray(v) || v.length % 2 || v.length > MAX_INNER * 2) return false
  let px = 0
  let py = 0
  for (let i = 0; i < v.length; i += 2) {
    const x: unknown = v[i]
    const y: unknown = v[i + 1]
    if (typeof x !== 'number' || typeof y !== 'number' || !(x > px && x < 1 && y >= py && y <= 1)) return false
    px = x
    py = y
  }
  return true
}

/** The inner points of a curve; an invalid one counts as `normal`. */
export function curveValues(c: unknown): CurveValues {
  if (c === 'soft' || c === 'normal' || c === 'firm') return PRESET_VALUES[c]
  return validCurveValues(c) ? c : PRESET_VALUES.normal
}

/** q for a stored pressure p (clamped to 0..1): monotone cubic Hermite with Fritsch-Butland tangents. */
export function pressureCurve(curve: unknown, p: number): number {
  const v = curveValues(curve)
  p = Math.min(1, Math.max(0, p))
  if (p === 0 || p === 1 || v.length === 0) return p
  const x = [0, ...v.filter((_, i) => i % 2 === 0), 1]
  const y = [0, ...v.filter((_, i) => i % 2 === 1), 1]
  const n = x.length - 1
  const h = Array.from({ length: n }, (_, k) => x[k + 1]! - x[k]!)
  const d = Array.from({ length: n }, (_, k) => (y[k + 1]! - y[k]!) / h[k]!)
  const m = new Array<number>(n + 1).fill(0)
  m[0] = d[0]!
  m[n] = d[n - 1]!
  for (let k = 1; k < n; k++) {
    if (d[k - 1]! * d[k]! <= 0) continue
    const w1 = 2 * h[k]! + h[k - 1]!
    const w2 = h[k]! + 2 * h[k - 1]!
    m[k] = (w1 + w2) / (w1 / d[k - 1]! + w2 / d[k]!)
  }
  let k = 0
  while (k < n - 1 && p > x[k + 1]!) k++
  const u = (p - x[k]!) / h[k]!
  const u2 = u * u
  const u3 = u2 * u
  const r =
    (2 * u3 - 3 * u2 + 1) * y[k]! +
    (u3 - 2 * u2 + u) * h[k]! * m[k]! +
    (-2 * u3 + 3 * u2) * y[k + 1]! +
    (u3 - u2) * h[k]! * m[k + 1]!
  return Math.min(1, Math.max(0, r))
}

/** Radius factor f(q) of stroke-geometry.md. */
export const radiusFactor = (q: number) => (q < 0.5 ? 0.25 + 0.75 * (q / 0.5) : 1 + 0.75 * ((q - 0.5) / 0.5))

/** Fixture shape: q and factor for a point; no curve when usePressure is off or the pressure is missing. */
export function drawPressure(curve: unknown, usePressure: boolean, pressure: number | null | undefined): number {
  if (!usePressure || typeof pressure !== 'number' || !Number.isFinite(pressure)) return 0.5
  return pressureCurve(curve, pressure)
}
