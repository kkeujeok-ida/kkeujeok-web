// spec rule `stroke.smooth` (pen-feel.md): one neighbour-average pass over x, y and pressure, at draw time only.
export const SMOOTH_LEVELS = ['off', 'light', 'normal', 'strong'] as const
export type SmoothLevel = (typeof SMOOTH_LEVELS)[number]
const K: Record<SmoothLevel, number> = { off: 0, light: 0.25, normal: 0.5, strong: 0.75 }

/** Points are `[x, y, pressure, t]`. Ends stay, `t` stays, neighbours are the original values; the input is not changed. */
export function smoothPoints<P extends readonly number[]>(points: readonly P[], level: SmoothLevel): (P | number[])[] {
  const k = K[level]
  // 2-point strokes (a straightened line) never bend: no interior point.
  if (!k || points.length < 3) return points.slice()
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p
    const a = points[i - 1]!
    const b = points[i + 1]!
    const q = Array.from(p)
    for (let j = 0; j < 3; j++) q[j] = p[j]! + k * ((a[j]! + b[j]!) / 2 - p[j]!)
    return q
  })
}
