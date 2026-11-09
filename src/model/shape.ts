// spec/shape.md: shapes are strokes with a `shape` object; `points` are made from it (`shape.corners` stored, `shape.points` dense). Drag to draw is `shape.fromDrag`.
import { round2 } from './number'

export const SHAPE_KINDS = ['triangle', 'rect', 'circle'] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]
export type Shape = { kind: string; [k: string]: unknown }
const STEP = 4

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Whether `s` is a complete shape of a known kind (else it is kept as is and its stroke is a plain stroke). */
export function isKnownShape(s: unknown): s is Shape {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return false
  const o = s as Record<string, unknown>
  if (o.kind === 'triangle') {
    const v = o.vertices
    return Array.isArray(v) && v.length === 3 && v.every((p) => Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1]))
  }
  if (o.kind === 'rect' || o.kind === 'circle') return ['x', 'y', 'width', 'height', 'rotation'].every((k) => num(o[k])) && (o.width as number) > 0 && (o.height as number) > 0
  return false
}

/** `shape.points`: the dense closed outline of `s` as `[x, y, 0.5, 16 * i]` (partial erase cuts it); null for an unknown or incomplete shape. */
export const shapePoints = (s: unknown): number[][] | null => outlineOf(s, false)

/** `shape.corners`: the points a shape stroke stores: one per corner of a rect or triangle (closed), the dense ring of a circle. */
export const shapeCorners = (s: unknown): number[][] | null => outlineOf(s, true)

function outlineOf(s: unknown, corners: boolean): number[][] | null {
  if (!isKnownShape(s)) return null
  const raw: [number, number][] = []
  const edge = (a: number[], b: number[]) => {
    if (corners) return void raw.push([a[0]!, a[1]!])
    const n = Math.max(1, Math.ceil(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!) / STEP))
    for (let k = 0; k < n; k++) raw.push([a[0]! + ((b[0]! - a[0]!) * k) / n, a[1]! + ((b[1]! - a[1]!) * k) / n])
  }
  let rot = (x: number, y: number): [number, number] => [x, y]
  if (s.kind === 'triangle') {
    const v = s.vertices as number[][]
    for (let i = 0; i < 3; i++) edge(v[i]!, v[(i + 1) % 3]!)
  } else {
    const { x, y, width: w, height: h, rotation } = s as unknown as Record<'x' | 'y' | 'width' | 'height' | 'rotation', number>
    const cx = x + w / 2, cy = y + h / 2
    const r = (rotation * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r)
    rot = (px, py) => [cx + (px - cx) * c - (py - cy) * sn, cy + (px - cx) * sn + (py - cy) * c]
    if (s.kind === 'rect') {
      const q = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      for (let i = 0; i < 4; i++) edge(q[i]!, q[(i + 1) % 4]!)
    } else {
      const a = w / 2, b = h / 2
      const p = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
      const n = Math.min(256, Math.max(16, Math.ceil(p / STEP)))
      for (let k = 0; k < n; k++) raw.push([cx + a * Math.cos((2 * Math.PI * k) / n), cy + b * Math.sin((2 * Math.PI * k) / n)])
    }
  }
  raw.push(raw[0]!)
  return raw.map(([px, py], i) => {
    const [x, y] = rot(px, py)
    return [round2(x), round2(y), 0.5, 16 * i]
  })
}

/** `shape.fromDrag`: the shape of a drag from `from` to `to`; null when the drag is under 4 pt on both axes. */
export function shapeFromDrag(kind: string, from: readonly number[], to: readonly number[], lockRatio: boolean): Shape | null {
  let dx = to[0]! - from[0]!, dy = to[1]! - from[1]!
  if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return null
  if (lockRatio) {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    dx = dx < 0 ? -side : side
    dy = dy < 0 ? -side : side
  }
  const x = Math.min(from[0]!, from[0]! + dx), y = Math.min(from[1]!, from[1]! + dy)
  const w = Math.abs(dx), h = Math.abs(dy)
  if (kind === 'triangle') return { kind, vertices: [[round2(x + w / 2), round2(y)], [round2(x + w), round2(y + h)], [round2(x), round2(y + h)]] }
  if (kind !== 'rect' && kind !== 'circle') return null
  return { kind, x: round2(x), y: round2(y), width: round2(w), height: round2(h), rotation: 0 }
}

/**
 * Moves, scales or turns a known `s` in place with the point map `f` (spec/transform.md: the box center is mapped,
 * size scales along the box's own axes, `rotation` gets `turn` degrees). False for an unknown or collapsed one, `s` untouched.
 */
export function transformShape(s: Shape, f: (x: number, y: number) => [number, number], sx: number, sy: number, turn: number): boolean {
  if (!isKnownShape(s)) return false
  if (s.kind === 'triangle') {
    s.vertices = (s.vertices as number[][]).map((p) => {
      const [x, y] = f(p[0]!, p[1]!)
      return [round2(x), round2(y)]
    })
    return true
  }
  const o = s as unknown as Record<'x' | 'y' | 'width' | 'height' | 'rotation', number>
  const w = o.width * sx, h = o.height * sy
  if (round2(w) <= 0 || round2(h) <= 0) return false // keep it valid
  const [cx, cy] = f(o.x + o.width / 2, o.y + o.height / 2)
  o.x = round2(cx - w / 2)
  o.y = round2(cy - h / 2)
  o.width = round2(w)
  o.height = round2(h)
  o.rotation = round2((((o.rotation + turn) % 360) + 360) % 360) % 360
  return true
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)

function segDist(px: number, py: number, a: number[], b: number[]): number {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a[0]!) * dx + (py - a[1]!) * dy) / l2))
  return dist(px, py, a[0]! + t * dx, a[1]! + t * dy)
}

/** `shape.recognizeTilted` (spec/shape.md): the shape a held stroke is turned into (a rect may be tilted), and whether a stroke with no shape is straight enough to become a line. */
export function recognizeTilted(points: readonly number[][]): { shape: Shape | null; line: boolean } {
  const shape = fitShape(points, true)
  return { shape, line: !shape && isStraight(points) }
}

/** `shape.recognize`, the axis-aligned rule kept as it was (a diamond is not a rect here; the editor uses `recognizeTilted`). */
export const recognizeShape = (points: readonly number[][]): Shape | null => fitShape(points, false)

/** The largest distance of the raw points from the segment first-last is at most 8% of its length. */
function isStraight(points: readonly number[][]): boolean {
  if (points.length < 2) return false
  const a = points[0]!, b = points[points.length - 1]!
  const len = dist(a[0]!, a[1]!, b[0]!, b[1]!)
  if (len < 1e-9) return false
  return points.every((q) => segDist(q[0]!, q[1]!, a, b) <= 0.08 * len)
}

function fitShape(points: readonly number[][], tilted: boolean): Shape | null {
  const p: number[][] = []
  for (const q of points) if (p.length === 0 || dist(q[0]!, q[1]!, p[p.length - 1]![0]!, p[p.length - 1]![1]!) >= 0.01) p.push([q[0]!, q[1]!])
  if (p.length < 8) return null
  const x0 = Math.min(...p.map((q) => q[0]!)), x1 = Math.max(...p.map((q) => q[0]!))
  const y0 = Math.min(...p.map((q) => q[1]!)), y1 = Math.max(...p.map((q) => q[1]!))
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h)
  if (diag < 30) return null
  if (dist(p[0]![0]!, p[0]![1]!, p[p.length - 1]![0]!, p[p.length - 1]![1]!) > 0.25 * diag) return null
  const path = [...p, p[0]!]
  let len = 0
  for (let i = 1; i < path.length; i++) len += dist(path[i - 1]![0]!, path[i - 1]![1]!, path[i]![0]!, path[i]![1]!)
  if (len < 1.8 * diag) return null
  const s: number[][] = []
  let seg = 1, acc = 0
  for (let i = 0; i < 64; i++) {
    const target = (len * i) / 64
    while (seg < path.length - 1 && acc + dist(path[seg - 1]![0]!, path[seg - 1]![1]!, path[seg]![0]!, path[seg]![1]!) < target) {
      acc += dist(path[seg - 1]![0]!, path[seg - 1]![1]!, path[seg]![0]!, path[seg]![1]!)
      seg++
    }
    const a = path[seg - 1]!, b = path[seg]!
    const sl = dist(a[0]!, a[1]!, b[0]!, b[1]!)
    const t = sl === 0 ? 0 : Math.min(1, Math.max(0, (target - acc) / sl))
    s.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t])
  }
  const rms = (f: (q: number[]) => number) => Math.sqrt(s.reduce((m, q) => m + f(q) ** 2, 0) / s.length)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const eCircle = w > 0 && h > 0 ? rms((q) => dist((q[0]! - cx) / (w / 2), (q[1]! - cy) / (h / 2), 0, 0) - 1) : Infinity
  // Convex hull (monotone chain, collinear dropped) of S, indices kept.
  const idx = s.map((_, i) => i).sort((a, b) => s[a]![0]! - s[b]![0]! || s[a]![1]! - s[b]![1]!)
  const cross = (o: number, a: number, b: number) => (s[a]![0]! - s[o]![0]!) * (s[b]![1]! - s[o]![1]!) - (s[a]![1]! - s[o]![1]!) * (s[b]![0]! - s[o]![0]!)
  const half = (order: number[]) => {
    const r: number[] = []
    for (const i of order) {
      while (r.length >= 2 && cross(r[r.length - 2]!, r[r.length - 1]!, i) <= 0) r.pop()
      r.push(i)
    }
    r.pop()
    return r
  }
  const hull = [...half(idx), ...half([...idx].reverse())].sort((a, b) => a - b)
  const rect = orientedRect(tilted ? hull.map((i) => s[i]!) : [], x0, x1, y0, y1)
  const eRect = rms((q) => {
    const dx = Math.abs((q[0]! - rect.cx) * rect.ux + (q[1]! - rect.cy) * rect.uy) - rect.w / 2
    const dy = Math.abs(-(q[0]! - rect.cx) * rect.uy + (q[1]! - rect.cy) * rect.ux) - rect.h / 2
    return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.min(-dx, -dy)
  }) / diag
  let best = -1
  let tri: number[] = []
  for (let i = 0; i < hull.length; i++)
    for (let j = i + 1; j < hull.length; j++)
      for (let k = j + 1; k < hull.length; k++) {
        const a = Math.abs(cross(hull[i]!, hull[j]!, hull[k]!))
        if (a > best) {
          best = a
          tri = [hull[i]!, hull[j]!, hull[k]!]
        }
      }
  const eTri = tri.length < 3 ? Infinity : rms((q) => Math.min(...[0, 1, 2].map((i) => segDist(q[0]!, q[1]!, s[tri[i]!]!, s[tri[(i + 1) % 3]!]!)))) / diag
  const scores = [eCircle / 0.1, eRect / 0.05, eTri / 0.05]
  let kind = 0
  for (let i = 1; i < 3; i++) if (scores[i]! < scores[kind]!) kind = i
  if (!(scores[kind]! <= 1)) return null
  if (kind === 2) return { kind: 'triangle', vertices: tri.map((i) => [round2(s[i]![0]!), round2(s[i]![1]!)]) }
  if (kind === 1) return { kind: 'rect', x: round2(rect.cx - rect.w / 2), y: round2(rect.cy - rect.h / 2), width: round2(rect.w), height: round2(rect.h), rotation: round2(rect.theta) }
  let bx = x0, by = y0, bw = w, bh = h
  if (kind === 0 && Math.abs(w - h) <= 0.15 * Math.max(w, h)) {
    bw = bh = (w + h) / 2
    bx = cx - bw / 2
    by = cy - bh / 2
  }
  return { kind: 'circle', x: round2(bx), y: round2(by), width: round2(bw), height: round2(bh), rotation: 0 }
}

/** The least-area rectangle around the hull points (rotating calipers, angle folded to 0..90); within 4 degrees of an axis it is the bounding box. */
function orientedRect(hull: readonly number[][], x0: number, x1: number, y0: number, y1: number) {
  const fit = (theta: number) => {
    const ux = Math.cos((theta * Math.PI) / 180), uy = Math.sin((theta * Math.PI) / 180)
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity
    for (const q of hull) {
      const a = q[0]! * ux + q[1]! * uy, b = -q[0]! * uy + q[1]! * ux
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b)
    }
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2
    return { theta, ux, uy, w: a1 - a0, h: b1 - b0, cx: ca * ux - cb * uy, cy: ca * uy + cb * ux }
  }
  let best: ReturnType<typeof fit> | null = null
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i]!, q = hull[(i + 1) % hull.length]!
    const alpha = (Math.atan2(q[1]! - p[1]!, q[0]! - p[0]!) * 180) / Math.PI
    const f = fit(((alpha % 90) + 90) % 90)
    if (!best || f.w * f.h < best.w * best.h) best = f
  }
  if (!best || best.theta < 4 || best.theta > 86) return { theta: 0, ux: 1, uy: 0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
  return best
}

type Box = Record<'x' | 'y' | 'width' | 'height' | 'rotation', number>

/** `shape.resize`: `s` with `handle` (`nw ne se sw` or `v0 v1 v2`) dragged to `to`; the opposite corner stays on the page. Null for an unknown shape or handle. */
export function shapeResize(s: Shape, handle: string, to: readonly number[], keepRatio: boolean): Shape | null {
  if (!isKnownShape(s)) return null
  const tx = to[0]!, ty = to[1]!
  if (s.kind === 'triangle') {
    const i = ['v0', 'v1', 'v2'].indexOf(handle)
    if (i < 0) return null
    return { kind: 'triangle', vertices: (s.vertices as number[][]).map((v, k) => (k === i ? [round2(tx), round2(ty)] : [v[0]!, v[1]!])) }
  }
  const corner = ['nw', 'ne', 'se', 'sw'].indexOf(handle)
  if (corner < 0) return null
  const { x, y, width: w, height: h, rotation } = s as unknown as Box
  const cx = x + w / 2, cy = y + h / 2
  const r = (rotation * Math.PI) / 180
  const ux = Math.cos(r), uy = Math.sin(r) // the box's own x axis
  const ox = corner === 0 || corner === 3 ? w / 2 : -w / 2
  const oy = corner === 0 || corner === 1 ? h / 2 : -h / 2
  const px = cx + ox * ux - oy * uy, py = cy + ox * uy + oy * ux
  let du = (tx - px) * ux + (ty - py) * uy
  let dv = -(tx - px) * uy + (ty - py) * ux
  if (keepRatio) {
    const k = Math.max(Math.abs(du) / w, Math.abs(dv) / h)
    du = (du < 0 ? -1 : 1) * w * k
    dv = (dv < 0 ? -1 : 1) * h * k
  }
  if (Math.abs(du) < 1) du = du < 0 ? -1 : 1
  if (Math.abs(dv) < 1) dv = dv < 0 ? -1 : 1
  const ncx = px + (du * ux - dv * uy) / 2, ncy = py + (du * uy + dv * ux) / 2
  return { kind: s.kind, x: round2(ncx - Math.abs(du) / 2), y: round2(ncy - Math.abs(dv) / 2), width: round2(Math.abs(du)), height: round2(Math.abs(dv)), rotation }
}

/** `shape.rotate`: the `rotation` a rotation handle dragged to `to` gives, snapped within 3 degrees of a multiple of 15. */
export function shapeRotate(s: Shape, to: readonly number[]): number {
  const { x, y, width, height } = s as unknown as Box
  let a = (Math.atan2(to[1]! - (y + height / 2), to[0]! - (x + width / 2)) * 180) / Math.PI + 90
  a = ((a % 360) + 360) % 360
  const near = Math.round(a / 15) * 15
  if (Math.abs(a - near) <= 3) a = near
  return round2(a) % 360
}

/** Where handle `i` of a line (2 points), triangle (v0..v2) or rect/circle (nw ne se sw) is, in page coordinates. */
export function handlePoint(s: Shape, i: number): [number, number] {
  if (s.kind === 'triangle') return (s.vertices as [number, number][])[i]!
  const { x, y, width: w, height: h, rotation } = s as unknown as Box
  const cx = x + w / 2, cy = y + h / 2
  const r = (rotation * Math.PI) / 180
  const ox = i === 0 || i === 3 ? -w / 2 : w / 2
  const oy = i < 2 ? -h / 2 : h / 2
  return [cx + ox * Math.cos(r) - oy * Math.sin(r), cy + ox * Math.sin(r) + oy * Math.cos(r)]
}

/** `shape.outline`: the two rings of a closed polyline at `width`; fill both together with the non-zero rule. `join` miter (limit 4) for rect/triangle, round for a circle. */
export function shapeOutline(points: readonly (readonly number[])[], width: number, join: 'miter' | 'round'): number[][][] {
  const V: number[][] = []
  for (const p of points) if (!V.length || dist(p[0]!, p[1]!, V[V.length - 1]![0]!, V[V.length - 1]![1]!) >= 0.01) V.push([p[0]!, p[1]!])
  if (V.length > 1 && dist(V[V.length - 1]![0]!, V[V.length - 1]![1]!, V[0]![0]!, V[0]![1]!) < 0.01) V.pop()
  const n = V.length
  if (n < 2) return [[], []]
  const d = V.map((v, i) => {
    const w = V[(i + 1) % n]!
    const l = dist(v[0]!, v[1]!, w[0]!, w[1]!)
    return [(w[0]! - v[0]!) / l, (w[1]! - v[1]!) / l]
  })
  const h = width / 2
  const side = (sg: number) => {
    const out: number[][] = []
    for (let i = 0; i < n; i++) {
      const dp = d[(i + n - 1) % n]!, dc = d[i]!, v = V[i]!
      const a = [-dp[1]!, dp[0]!], b = [-dc[1]!, dc[0]!]
      const c = a[0]! * b[0]! + a[1]! * b[1]!
      const k = dp[0]! * dc[1]! - dp[1]! * dc[0]!
      const at = (x: number[]) => out.push([v[0]! + sg * h * x[0]!, v[1]! + sg * h * x[1]!])
      const miter = () => at([(a[0]! + b[0]!) / (1 + c), (a[1]! + b[1]!) / (1 + c)])
      if (1 + c < 1e-9) { at(a); at(b) }
      else if (sg * k > 0 || k === 0) miter()
      else if (join === 'miter') { if ((1 + c) / 2 >= 1 / 16) miter(); else { at(a); at(b) } }
      else {
        const phi = Math.acos(Math.max(-1, Math.min(1, c)))
        const K = Math.max(1, Math.ceil(phi / (Math.PI / 8)))
        const a0 = Math.atan2(a[1]!, a[0]!), sn = k >= 0 ? 1 : -1
        for (let j = 0; j <= K; j++) {
          const t = a0 + (sn * phi * j) / K
          at([Math.cos(t), Math.sin(t)])
        }
      }
    }
    return out
  }
  const r = (ring: number[][]) => ring.map((p) => [round2(p[0]!), round2(p[1]!)])
  return [r(side(1)), r(side(-1).reverse())]
}

/** `shape.holdResize`: `s` as recognized, the pen moved from `p0` to `p`; the corner nearest `p0` follows the pen, the opposite one stays. */
export function holdResize(s: Shape, p0: readonly number[], p: readonly number[]): Shape {
  const tri = s.kind === 'triangle'
  const v = tri ? (s.vertices as number[][]) : []
  let cx: number, cy: number, w: number, h: number, r: number
  if (tri) {
    let bi = 0, bl = -1
    for (let i = 0; i < 3; i++) {
      const l = dist(v[i]![0]!, v[i]![1]!, v[(i + 1) % 3]![0]!, v[(i + 1) % 3]![1]!)
      if (l > bl) { bl = l; bi = i }
    }
    const a = v[bi]!, b = v[(bi + 1) % 3]!
    r = ((((Math.atan2(b[1]! - a[1]!, b[0]! - a[0]!) * 180) / Math.PI) % 90) + 90) % 90
    const ux = Math.cos((r * Math.PI) / 180), uy = Math.sin((r * Math.PI) / 180)
    const us = v.map((q) => q[0]! * ux + q[1]! * uy), vs = v.map((q) => -q[0]! * uy + q[1]! * ux)
    const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)]
    w = u1 - u0
    h = v1 - v0
    const ca = (u0 + u1) / 2, cb = (v0 + v1) / 2
    cx = ca * ux - cb * uy
    cy = ca * uy + cb * ux
  } else {
    const o = s as unknown as Box
    cx = o.x + o.width / 2; cy = o.y + o.height / 2; w = o.width; h = o.height; r = o.rotation
  }
  const ux = Math.cos((r * Math.PI) / 180), uy = Math.sin((r * Math.PI) / 180)
  const sgn = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
  const at = ([a, b]: readonly [number, number]) => [cx + ((a * w) / 2) * ux - ((b * h) / 2) * uy, cy + ((a * w) / 2) * uy + ((b * h) / 2) * ux]
  let hi = 0, hd = Infinity
  sgn.forEach((g, i) => {
    const q = at(g)
    const dd = dist(q[0]!, q[1]!, p0[0]!, p0[1]!)
    if (dd < hd - 1e-9) { hd = dd; hi = i }
  })
  const A = at(sgn[(hi + 2) % 4]!), H = at(sgn[hi]!)
  const tx = H[0]! + p[0]! - p0[0]!, ty = H[1]! + p[1]! - p0[1]!
  let du = (tx - A[0]!) * ux + (ty - A[1]!) * uy
  let dv = -(tx - A[0]!) * uy + (ty - A[1]!) * ux
  if (Math.abs(du) < 1) du = du < 0 ? -1 : 1
  if (Math.abs(dv) < 1) dv = dv < 0 ? -1 : 1
  if (tri) {
    const hx = (sgn[hi]![0] * w) / 2, hy = (sgn[hi]![1] * h) / 2
    return {
      kind: 'triangle',
      vertices: v.map((q) => {
        const lu = (q[0]! - A[0]!) * ux + (q[1]! - A[1]!) * uy, lv = -(q[0]! - A[0]!) * uy + (q[1]! - A[1]!) * ux
        const nu = hx === 0 ? lu : (lu * du) / (2 * hx), nv = hy === 0 ? lv : (lv * dv) / (2 * hy)
        return [round2(A[0]! + nu * ux - nv * uy), round2(A[1]! + nu * uy + nv * ux)]
      }),
    }
  }
  const ncx = A[0]! + (du * ux - dv * uy) / 2, ncy = A[1]! + (du * uy + dv * ux) / 2
  return { kind: s.kind, x: round2(ncx - Math.abs(du) / 2), y: round2(ncy - Math.abs(dv) / 2), width: round2(Math.abs(du)), height: round2(Math.abs(dv)), rotation: r }
}

/** The two rings a shape stroke is drawn with (spec shape.md, Pen pipeline); null for a stroke that is not a known shape (draw it as a plain stroke). */
export function shapeRings(s: { shape?: unknown; width: number; points: readonly (readonly number[])[] }): number[][][] | null {
  if (!isKnownShape(s.shape) || s.points.length < 2) return null
  return shapeOutline(s.points, s.width, s.shape.kind === 'circle' ? 'round' : 'miter')
}
