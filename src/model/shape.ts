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
