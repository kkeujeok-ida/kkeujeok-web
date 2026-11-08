// spec rule `pen.straighten` (pen-feel.md): holding the pen still turns the stroke into a straight line.
export const HOLD_MS = 500
export const HOLD_DISTANCE = 8 // CSS px on the web

export type StraightenInput = {
  enabled: boolean
  tool: string
  palm: boolean
  secondPointer: boolean
  at: number
  samples: readonly (readonly number[])[] // [t, x, y]
}

/** The anchor is the first point, then every point farther than HOLD_DISTANCE from it. */
export function anchorOf(samples: StraightenInput['samples']): { t: number; x: number; y: number } | null {
  const f = samples[0]
  if (!f) return null
  let a = { t: f[0]!, x: f[1]!, y: f[2]! }
  for (const s of samples) if (Math.hypot(s[1]! - a.x, s[2]! - a.y) > HOLD_DISTANCE) a = { t: s[0]!, x: s[1]!, y: s[2]! }
  return a
}

/** Whether straightening is in effect at `at`. */
export function straightenActive(i: StraightenInput): boolean {
  if (!i.enabled || (i.tool !== 'pen' && i.tool !== 'highlighter') || i.palm || i.secondPointer) return false
  const a = anchorOf(i.samples)
  if (!a || i.at - a.t < HOLD_MS) return false
  const f = i.samples[0]!
  const e = i.samples[i.samples.length - 1]!
  return Math.hypot(e[1]! - f[1]!, e[2]! - f[2]!) > HOLD_DISTANCE
}
