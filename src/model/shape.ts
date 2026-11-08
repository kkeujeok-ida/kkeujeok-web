// spec/shape.md: shapes are strokes with a `shape` object; `points` are made from it (`shape.points`). Drag to draw is `shape.fromDrag`.
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

/** `shape.points`: the closed outline of `s` as `[x, y, 0.5, 16 * i]`; null for an unknown or incomplete shape. */
export function shapePoints(s: unknown): number[][] | null {
  if (!isKnownShape(s)) return null
  const raw: [number, number][] = []
  const edge = (a: number[], b: number[]) => {
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

/** `shape.recognize` (spec/shape.md): the shape a held stroke is turned into, or null when nothing fits. Same steps as the Android `recognizeShape`. */
export function recognizeShape(points: readonly number[][]): Shape | null {
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
  const eRect = rms((q) => Math.min(Math.abs(q[0]! - x0), Math.abs(q[0]! - x1), Math.abs(q[1]! - y0), Math.abs(q[1]! - y1))) / diag
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
  let bx = x0, by = y0, bw = w, bh = h
  if (kind === 0 && Math.abs(w - h) <= 0.15 * Math.max(w, h)) {
    bw = bh = (w + h) / 2
    bx = cx - bw / 2
    by = cy - bh / 2
  }
  return { kind: kind === 0 ? 'circle' : 'rect', x: round2(bx), y: round2(by), width: round2(bw), height: round2(bh), rotation: 0 }
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
