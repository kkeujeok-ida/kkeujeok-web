// spec rule `brush.resolve` (spec/brush.md): the drawing parameters of a stroke from its `tool` and optional `brush`.
import { type Curve, curveEval, opacityPressureCurve, validCurve } from './curve'
import { pressureCurve } from './pressureCurve'

export type BrushParams = {
  pressureCurve: Curve | null
  tiltCurve: Curve
  tiltTarget: 'none' | 'size' | 'opacity'
  opacity: number
  texture: 'none' | 'pencil'
}

/** The Epic 28 parameters; not in `brush.resolve` (its fixture lists the five above), read with `brushCurves`. */
export type BrushCurves = {
  density: number
  curvesOff: string[]
  sizeTiltCurve: Curve | null
  opacityTiltCurve: Curve | null
  densityPressureCurve: Curve | null
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

/** `density`, `curvesOff` and the three new curves of a stroke's `brush` (tilt curves include the legacy `tiltTarget` reading). */
export function brushCurves(brush: unknown): BrushCurves {
  const b = brush && typeof brush === 'object' && !Array.isArray(brush) ? (brush as Record<string, unknown>) : {}
  const lt = brushLegacyTilt(brush)
  return {
    density: typeof b.density === 'number' && b.density >= 0.05 && b.density <= 1 ? b.density : 1,
    curvesOff: lt.curvesOff,
    sizeTiltCurve: lt.sizeTiltCurve,
    opacityTiltCurve: lt.opacityTiltCurve,
    densityPressureCurve: lt.curvesOff.includes('densityPressure') ? null : validCurve(b.densityPressureCurve),
  }
}

/** The strings of `brush.curvesOff` (unknown ones kept); `[]` when absent. */
export function curvesOffOf(brush: unknown): string[] {
  const o = brush && typeof brush === 'object' ? (brush as Record<string, unknown>).curvesOff : null
  return Array.isArray(o) ? o.filter((s): s is string => typeof s === 'string') : []
}

/** Spec rule `brush.legacyTilt`: the old `tiltTarget`/`tiltCurve` read as the two tilt curves; the new field wins, a switch in `curvesOff` gives null. */
export function brushLegacyTilt(brush: unknown): { sizeTiltCurve: Curve | null; opacityTiltCurve: Curve | null; curvesOff: string[] } {
  const b = brush && typeof brush === 'object' && !Array.isArray(brush) ? (brush as Record<string, unknown>) : {}
  const off = curvesOffOf(brush)
  const read = (field: string, name: string, target: string): Curve | null =>
    off.includes(name) ? null : validCurve(b[field]) ?? (b.tiltTarget === target ? validCurve(b.tiltCurve) ?? LINEAR : null)
  return { sizeTiltCurve: read('sizeTiltCurve', 'sizeTilt', 'size'), opacityTiltCurve: read('opacityTiltCurve', 'opacityTilt', 'opacity'), curvesOff: off }
}

/** Spec rule `brush.alpha`: the final alpha of one point. A missing curve is constant 1; a missing pressure (or `usePressure` false) counts as 0.5, a missing tilt gives qt 1. */
export function brushAlpha(o: { opacity: number; opacityPressureCurve?: unknown; opacityTiltCurve?: unknown; pressure?: number | null; tilt?: number | null; usePressure?: boolean }): number {
  let a = o.opacity
  const pc = validCurve(o.opacityPressureCurve)
  if (pc) {
    const p = (o.usePressure ?? true) && typeof o.pressure === 'number' && Number.isFinite(o.pressure) ? Math.min(1, Math.max(0, o.pressure)) : 0.5
    a *= curveEval(pc, p) ?? 1
  }
  const tc = validCurve(o.opacityTiltCurve)
  if (tc && typeof o.tilt === 'number' && Number.isFinite(o.tilt)) a *= curveEval(tc, Math.min(90, Math.max(0, o.tilt)) / 90) ?? 1
  return Math.min(1, Math.max(0, a))
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
  const off = curvesOffOf(brush) // a curve that is off counts as its default, constant 1
  if (b.tiltTarget === 'opacity' && tool !== 'tape' && !off.includes('opacityTilt')) {
    const qs = points.map((p) => tiltQ(p, b.tiltCurve)).filter((q): q is number => q !== null)
    if (qs.length) a *= qs.reduce((x, y) => x + y, 0) / qs.length
  }
  const oc = tool === 'tape' || perStamp || off.includes('opacityPressure') ? null : opacityPressureCurve(brush)
  if (oc && points.length) {
    // pressure alone drives it; usePressure off counts as 0.5 (spec/brush.md)
    const q = (p: readonly number[]) => pressureCurve(oc, usePressure && Number.isFinite(p[2]) ? p[2]! : 0.5)
    a *= points.reduce((x, p) => x + q(p), 0) / points.length
  }
  return a
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export type BrushPatch = Partial<Record<'pressureCurve' | 'tiltCurve' | 'opacityPressureCurve' | 'tiltTarget' | 'opacity' | 'texture' | 'density', unknown>>

/**
 * `brush` with `patch` applied, keeping only what differs from the tool default (spec/brush.md).
 * A `null` value clears a parameter. Unknown parameters stay. `undefined` when nothing is left.
 */
export function patchBrush(tool: unknown, brush: unknown, patch: BrushPatch): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = brush && typeof brush === 'object' && !Array.isArray(brush) ? { ...(brush as Record<string, unknown>) } : {}
  const d = { ...brushResolve(tool, undefined), density: 1 } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || (k !== 'pressureCurve' && sameJson(v, d[k]))) delete out[k]
    else out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}
