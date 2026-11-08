// spec rule `pen.pressureCurve` (pen-feel.md): maps a stored pressure p to the drawing pressure q.
export type CurveValues = readonly [number, number, number, number]
export type PressureCurve = 'soft' | 'normal' | 'firm' | CurveValues
export const PRESETS = ['soft', 'normal', 'firm'] as const
export const PRESET_VALUES: Record<(typeof PRESETS)[number], CurveValues> = {
  soft: [0.2, 0.4, 0.5, 0.8],
  normal: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  firm: [0.5, 0.1, 0.8, 0.5],
}

/** Four numbers in 0..1 with x1 <= x2 and y1 <= y2 (a monotone curve). */
export function validCurveValues(v: unknown): v is CurveValues {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === 'number' && n >= 0 && n <= 1) &&
    v[0] <= v[2] &&
    v[1] <= v[3]
  )
}

/** The four values of a curve; an invalid one counts as `normal`. */
export function curveValues(c: unknown): CurveValues {
  if (c === 'soft' || c === 'normal' || c === 'firm') return PRESET_VALUES[c]
  return validCurveValues(c) ? c : PRESET_VALUES.normal
}

const bez = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t

/** q for a stored pressure p (clamped to 0..1), by bisection on x(t) = p. */
export function pressureCurve(curve: unknown, p: number): number {
  const [x1, y1, x2, y2] = curveValues(curve)
  p = Math.min(1, Math.max(0, p))
  if (p === 0 || p === 1) return p
  if (x1 === y1 && x2 === y2) return p // y = x exactly (the normal preset), no bisection error
  let lo = 0
  let hi = 1
  let mid = 0.5
  while (hi - lo >= 1e-6) {
    mid = (lo + hi) / 2
    if (bez(x1, x2, mid) < p) lo = mid
    else hi = mid
  }
  return bez(y1, y2, mid)
}

/** Radius factor f(q) of stroke-geometry.md. */
export const radiusFactor = (q: number) => (q < 0.5 ? 0.25 + 0.75 * (q / 0.5) : 1 + 0.75 * ((q - 0.5) / 0.5))

/** Fixture shape: q and factor for a point; no curve when usePressure is off or the pressure is missing. */
export function drawPressure(curve: unknown, usePressure: boolean, pressure: number | null | undefined): number {
  if (!usePressure || typeof pressure !== 'number' || !Number.isFinite(pressure)) return 0.5
  return pressureCurve(curve, pressure)
}
