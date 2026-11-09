// spec rule `brush.resolve` (spec/brush.md): the drawing parameters of a stroke from its `tool` and optional `brush`.
import { type Curve, opacityPressureCurve, validCurve } from './curve'
import { pressureCurve } from './pressureCurve'

export type BrushParams = {
  pressureCurve: Curve | null
  tiltCurve: Curve
  tiltTarget: 'none' | 'size' | 'opacity'
  opacity: number
  texture: 'none' | 'pencil'
}

const LINEAR = [1 / 3, 1 / 3, 2 / 3, 2 / 3]

/** Default opacity of a tool; the highlighter layer alpha. */
export const toolOpacity = (tool: unknown) => (tool === 'highlighter' ? 0.4 : 1)

export function brushResolve(tool: unknown, brush: unknown): BrushParams {
  const b = brush && typeof brush === 'object' && !Array.isArray(brush) ? (brush as Record<string, unknown>) : {}
  const o = b.opacity
  const opacity = tool === 'tape' ? 1 : typeof o === 'number' && o >= 0.05 && o <= 1 ? o : toolOpacity(tool)
  const tx = b.texture
  return {
    pressureCurve: validCurve(b.pressureCurve),
    tiltCurve: validCurve(b.tiltCurve) ?? LINEAR,
    tiltTarget: b.tiltTarget === 'size' || b.tiltTarget === 'opacity' ? b.tiltTarget : 'none',
    opacity,
    texture: tx === 'none' || tx === 'pencil' ? tx : tool === 'pencil' ? 'pencil' : 'none',
  }
}

/** Curve output q (0..1) of a point's tilt, or null when the point has no tilt (4 numbers). */
export function tiltQ(p: readonly number[], curve: readonly number[]): number | null {
  if (p.length < 6 || typeof p[4] !== 'number' || !Number.isFinite(p[4])) return null
  return pressureCurve(curve, Math.min(90, Math.max(0, p[4])) / 90)
}

/** Width factor of a point: `0.5 + q` under tilt `size`; 1 when the tilt is unknown. */
export const tiltSizeFactor = (p: readonly number[], curve: readonly number[]) => {
  const q = tiltQ(p, curve)
  return q === null ? 1 : 0.5 + q
}

/**
 * Multiplier of the stroke's layer alpha relative to the tool default.
 * shortcut: tilt `opacity` is one mean value per stroke (a stroke is one filled layer), not per point; upgrade with a per-segment renderer.
 */
export function brushAlphaFactor(tool: unknown, brush: unknown, points: readonly (readonly number[])[], usePressure = true, perStamp = false): number {
  if (brush === undefined) return 1
  const b = brushResolve(tool, brush)
  let a = perStamp ? 1 : b.opacity / toolOpacity(tool) // perStamp: opacity and its pressure curve are inside each pencil stamp
  if (b.tiltTarget === 'opacity' && tool !== 'tape') {
    const qs = points.map((p) => tiltQ(p, b.tiltCurve)).filter((q): q is number => q !== null)
    if (qs.length) a *= qs.reduce((x, y) => x + y, 0) / qs.length
  }
  const oc = tool === 'tape' || perStamp ? null : opacityPressureCurve(brush)
  if (oc && points.length) {
    // pressure alone drives it; usePressure off counts as 0.5 (spec/brush.md)
    const q = (p: readonly number[]) => pressureCurve(oc, usePressure && Number.isFinite(p[2]) ? p[2]! : 0.5)
    a *= points.reduce((x, p) => x + q(p), 0) / points.length
  }
  return a
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export type BrushPatch = Partial<Record<'pressureCurve' | 'tiltCurve' | 'opacityPressureCurve' | 'tiltTarget' | 'opacity' | 'texture', unknown>>

/**
 * `brush` with `patch` applied, keeping only what differs from the tool default (spec/brush.md).
 * A `null` value clears a parameter. Unknown parameters stay. `undefined` when nothing is left.
 */
export function patchBrush(tool: unknown, brush: unknown, patch: BrushPatch): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = brush && typeof brush === 'object' && !Array.isArray(brush) ? { ...(brush as Record<string, unknown>) } : {}
  const d = brushResolve(tool, undefined) as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || (k !== 'pressureCurve' && sameJson(v, d[k]))) delete out[k]
    else out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}
