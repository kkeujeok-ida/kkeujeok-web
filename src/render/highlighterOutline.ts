// spec rule `stroke.outline.highlighter` (stroke-geometry.md): the chisel-nib
// rectangles of a highlighter stroke; their union is the stroke. Never stored.
import { round2 } from '../model/number'
import { DEDUPE_DISTANCE } from './strokeOutline'

/** `points` are `[x, y, pressure, t]` (pressure is not used). Returns the rectangles in point order, `[]` for no points. */
export function highlighterOutline(width: number, points: readonly (readonly number[])[]): number[][][] {
  // upright chisel; the 1/16 lean keeps a straight vertical stroke visible
  const ax = width / 16
  const ay = -width / 2
  const kept: number[][] = []
  for (const p of points) {
    const last = kept[kept.length - 1]
    if (last && Math.hypot(p[0]! - last[0]!, p[1]! - last[1]!) < DEDUPE_DISTANCE) continue
    kept.push([p[0]!, p[1]!])
  }
  const r = (x: number, y: number) => [round2(x), round2(y)]
  if (kept.length === 0) return []
  if (kept.length === 1) {
    const [x, y] = kept[0]!
    // n = a turned 90 degrees, times 0.25
    const nx = -ay * 0.25
    const ny = ax * 0.25
    return [[r(x! + ax, y! + ay), r(x! + nx, y! + ny), r(x! - ax, y! - ay), r(x! - nx, y! - ny)]]
  }
  const out: number[][][] = []
  for (let i = 1; i < kept.length; i++) {
    const [px, py] = kept[i - 1]!
    const [qx, qy] = kept[i]!
    out.push([r(px! + ax, py! + ay), r(qx! + ax, qy! + ay), r(qx! - ax, qy! - ay), r(px! - ax, py! - ay)])
  }
  return out
}

/** The rectangles each wound the same way, so overlaps never cancel under the non-zero rule. */
export function windAlike(rects: readonly (readonly (readonly number[])[])[]): (readonly number[])[][] {
  return rects.map((rect) => {
    let area = 0
    rect.forEach((p, i) => {
      const q = rect[(i + 1) % rect.length]!
      area += p[0]! * q[1]! - q[0]! * p[1]!
    })
    return area < 0 ? [...rect].reverse() : [...rect]
  })
}

/** One path of all rectangles; fill it once with the non-zero rule. */
export function highlighterPath(rects: readonly (readonly (readonly number[])[])[]): Path2D {
  const path = new Path2D()
  for (const rect of windAlike(rects)) {
    rect.forEach((p, i) => (i === 0 ? path.moveTo(p[0]!, p[1]!) : path.lineTo(p[0]!, p[1]!)))
    path.closePath()
  }
  return path
}
