// spec rules select.lasso, select.tap, select.rect (spec/select.md) and the bounding box of
// spec/transform.md. Pure functions over raw elements (port of the Android lib/model/select.dart).

import { textHeight } from './textLayout'

export type El = Record<string, unknown>
export type P = readonly [number, number]
export type Bounds = { left: number; top: number; right: number; bottom: number }

const EPS = 1e-9
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStroke = (e: El) => e.type === 'stroke'

/** A text box has a string `text`; a bare `type: text` box keeps its stored height (spec/transform.md "Text boxes"). */
export const isTextBox = (e: El) => e.type === 'text' && typeof e.text === 'string'

// A text box is a box element whose height is computed from its content.
export const withHeights = (els: readonly El[]): El[] => els.map((e) => (isTextBox(e) ? { ...e, height: textHeight(e) } : e))

// An element that cannot be judged (no id, a box without numeric geometry, a malformed point) is ignored, never thrown on.
function usable(e: El): boolean {
  if (typeof e?.id !== 'string') return false
  if (isStroke(e)) {
    const pts = e.points
    return pts == null || (Array.isArray(pts) && pts.every((p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1])))
  }
  return ['x', 'y', 'width', 'height'].every((k) => isNum(e[k])) && (e.rotation == null || isNum(e.rotation))
}

const points = (e: El): P[] => ((e.points as number[][] | undefined) ?? []).map((p) => [p[0]!, p[1]!] as const)

/** The four corners of a box element after rotation, clockwise from top-left. */
export function boxCorners(e: El): P[] {
  const x = e.x as number, y = e.y as number, w = e.width as number, h = e.height as number
  const a = (((e.rotation as number | null | undefined) ?? 0) * Math.PI) / 180
  const cx = x + w / 2, cy = y + h / 2
  const c = Math.cos(a), s = Math.sin(a)
  return ([[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as const).map(
    ([px, py]) => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c] as const,
  )
}

function area(poly: readonly P[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!
    const [x1, y1] = poly[(i + 1) % poly.length]!
    s += x0 * y1 - x1 * y0
  }
  return Math.abs(s) / 2
}

function inPolygon([px, py]: P, poly: readonly P[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    const cross = (xj - xi) * (py - yi) - (yj - yi) * (px - xi)
    if (
      Math.abs(cross) <= EPS &&
      px >= Math.min(xi, xj) - EPS && px <= Math.max(xi, xj) + EPS &&
      py >= Math.min(yi, yj) - EPS && py <= Math.max(yi, yj) + EPS
    ) {
      return true // on the boundary
    }
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function cut(a: P, b: P, da: number, db: number): P {
  const t = da / (da - db)
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

// Sutherland-Hodgman: `subject` clipped by the convex `clip`.
function clip(subject: P[], clipPoly: readonly P[]): P[] {
  let signed = 0
  for (let i = 0; i < clipPoly.length; i++) {
    const [x0, y0] = clipPoly[i]!
    const [x1, y1] = clipPoly[(i + 1) % clipPoly.length]!
    signed += x0 * y1 - x1 * y0
  }
  const k = signed >= 0 ? 1 : -1
  let out = subject
  for (let i = 0; i < clipPoly.length && out.length > 0; i++) {
    const [ax, ay] = clipPoly[i]!
    const [bx, by] = clipPoly[(i + 1) % clipPoly.length]!
    const side = (p: P) => k * ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax))
    const input = out
    out = []
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!, prev = input[(j + input.length - 1) % input.length]!
      const dc = side(cur), dp = side(prev)
      if (dc >= 0) {
        if (dp < 0) out.push(cut(prev, cur, dp, dc))
        out.push(cur)
      } else if (dp >= 0) {
        out.push(cut(prev, cur, dp, dc))
      }
    }
  }
  return out
}

/** `select.lasso`: ids in array order. */
export function selectLasso(elements: readonly El[], polygon: readonly P[]): string[] {
  if (polygon.length < 3 || area(polygon) === 0) return []
  const ids: string[] = []
  for (const e of withHeights(elements).filter(usable)) {
    if (isStroke(e)) {
      const pts = points(e)
      if (pts.length === 0) continue
      if (pts.filter((p) => inPolygon(p, polygon)).length >= Math.ceil(pts.length / 2)) ids.push(e.id as string)
    } else {
      const box = boxCorners(e)
      const a = Math.abs(e.width as number) * Math.abs(e.height as number)
      if (box.every((p) => inPolygon(p, polygon)) || (a > 0 && area(clip([...polygon], box)) >= a * 0.5 - EPS)) ids.push(e.id as string)
    }
  }
  return ids
}

function segDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** `select.tap`: the topmost hit element id, or null. */
export function selectTap(elements: readonly El[], point: P, tolerance = 6): string | null {
  for (const e of withHeights(elements).filter(usable).reverse()) {
    if (isStroke(e)) {
      const pts = points(e)
      if (pts.length === 0) continue
      const reach = (isNum(e.width) ? e.width : 0) / 2 + tolerance + EPS
      let d = segDist(point, pts[0]!, pts[0]!)
      for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(point, pts[i]!, pts[i + 1]!))
      if (d <= reach) return e.id as string
    } else {
      const w = e.width as number, h = e.height as number
      const cx = (e.x as number) + w / 2, cy = (e.y as number) + h / 2
      const a = (-((e.rotation as number | null | undefined) ?? 0) * Math.PI) / 180
      const dx = point[0] - cx, dy = point[1] - cy
      // Into the box's own axes.
      const lx = dx * Math.cos(a) - dy * Math.sin(a)
      const ly = dx * Math.sin(a) + dy * Math.cos(a)
      if (Math.hypot(Math.max(Math.abs(lx) - w / 2, 0), Math.max(Math.abs(ly) - h / 2, 0)) <= tolerance + EPS) return e.id as string
    }
  }
  return null
}

/** `select.rect`: `r` is x0, y0, x1, y1 in any corner order. */
export const selectRect = (elements: readonly El[], r: readonly [number, number, number, number]): string[] =>
  selectLasso(elements, [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]])

/** Union of the bounding boxes of `elements` (transform.md); null when none has one. */
export function selectionBounds(elements: readonly El[]): Bounds | null {
  let out: Bounds | null = null
  for (const e of withHeights(elements).filter(usable)) {
    const pts = isStroke(e) ? points(e) : boxCorners(e)
    if (pts.length === 0) continue
    const b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    for (const [x, y] of pts) {
      b.left = Math.min(b.left, x)
      b.right = Math.max(b.right, x)
      b.top = Math.min(b.top, y)
      b.bottom = Math.max(b.bottom, y)
    }
    out = out && { left: Math.min(out.left, b.left), top: Math.min(out.top, b.top), right: Math.max(out.right, b.right), bottom: Math.max(out.bottom, b.bottom) }
    out ??= b
  }
  return out
}

/**
 * The box of `elements` in a frame turned by `angle` degrees (clockwise): its center in page coordinates and its size along
 * the frame's axes. With angle 0 it is the plain bounds. Null when no element has a box.
 */
export function selectionFrame(elements: readonly El[], angle: number): { cx: number; cy: number; w: number; h: number } | null {
  const a = (angle * Math.PI) / 180
  const c = Math.cos(a), s = Math.sin(a)
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (const e of withHeights(elements).filter(usable)) {
    const pts: readonly (readonly [number, number])[] = isStroke(e) ? points(e) : boxCorners(e)
    for (const [x, y] of pts) {
      const u = x * c + y * s, v = -x * s + y * c
      l = Math.min(l, u)
      r = Math.max(r, u)
      t = Math.min(t, v)
      b = Math.max(b, v)
    }
  }
  if (!Number.isFinite(l + r + t + b)) return null
  const cu = (l + r) / 2, cv = (t + b) / 2
  return { cx: cu * c - cv * s, cy: cu * s + cv * c, w: r - l, h: b - t }
}
