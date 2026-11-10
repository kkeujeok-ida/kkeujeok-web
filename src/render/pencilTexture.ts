// spec rules `stroke.texture.pencil` and `stroke.texture.pencilStamps` (pen-kinds.md): stamps placed along the stroke
// from its points and id, never stored in a note. The stamps are public/pencil_stamp_0..2.png (128 px, alpha only).
import { pressureCurve } from '../model/pressureCurve'

export type PencilStamp = { x: number; y: number; size: number; angle: number; alpha: number }

/** `density(q)` and `threshold(q)`; `q` is clamped to 0..1. */
export function pencilDensity(q: number): { density: number; threshold: number } {
  const c = Number.isNaN(q) ? 0.5 : Math.min(1, Math.max(0, q))
  const density = 0.35 + 0.6 * c
  return { density, threshold: Math.floor(density * 65536 + 1e-6) }
}

const round2 = (v: number) => Math.round(v * 100) / 100

function fnv1a(id: string): number {
  let h = 2166136261
  for (const b of new TextEncoder().encode(id)) h = Math.imul(h ^ b, 16777619) >>> 0
  return h
}

/**
 * The stamps of a pencil stroke (`stroke.texture.pencilStamps`). `curve` and `opacityCurve` turn a stored pressure into
 * `q`; `curve` null is the identity, `opacityCurve` null is none. `opacity` is the brush opacity.
 */
export function pencilStamps(o: {
  id: string
  width: number
  usePressure: boolean
  points: readonly (readonly number[])[]
  opacity?: number
  curve?: unknown
  opacityCurve?: unknown
}): PencilStamp[] {
  const { id, width, usePressure, points, opacity = 1, curve = null, opacityCurve = null } = o
  const qOf = (p: readonly number[]) => {
    const v = p[2]
    if (!usePressure || typeof v !== 'number' || !Number.isFinite(v)) return 0.5
    let q = curve ? pressureCurve(curve, v) : Math.min(1, Math.max(0, v))
    if (opacityCurve) q = pressureCurve(opacityCurve, q)
    return q
  }
  const xs: number[] = [], ys: number[] = [], qs: number[] = []
  for (const p of points) {
    const x = p[0]!, y = p[1]!
    if (xs.length && Math.hypot(x - xs[xs.length - 1]!, y - ys[ys.length - 1]!) < 0.01) continue
    xs.push(x); ys.push(y); qs.push(qOf(p))
  }
  if (!xs.length) return []
  const cum = [0]
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!))
  const total = cum[cum.length - 1]!
  const seed = fnv1a(id)
  const out: PencilStamp[] = []
  let seg = 0, s = 0
  for (let k = 0; ; k++) {
    const last = !(s < total - 1e-9)
    if (last) s = total
    while (seg < xs.length - 2 && cum[seg + 1]! <= s) seg++
    let px: number, py: number, q: number, tx = 1, ty = 0
    if (xs.length === 1) {
      px = xs[0]!; py = ys[0]!; q = qs[0]!
    } else {
      const len = cum[seg + 1]! - cum[seg]!
      const t = len <= 0 ? 0 : Math.min(1, Math.max(0, (s - cum[seg]!) / len))
      px = xs[seg]! + (xs[seg + 1]! - xs[seg]!) * t
      py = ys[seg]! + (ys[seg + 1]! - ys[seg]!) * t
      q = qs[seg]! + (qs[seg + 1]! - qs[seg]!) * t
      tx = (xs[seg + 1]! - xs[seg]!) / len
      ty = (ys[seg + 1]! - ys[seg]!) / len
    }
    const d = Math.min(1, Math.max(0, pencilDensity(q).density * opacity))
    const w = width * (q < 0.5 ? 0.6 + 0.8 * q : 0.7 + 0.6 * q)
    let x = (seed ^ k) >>> 0 || 1
    const draw = () => {
      x = (x ^ (x << 13)) >>> 0
      x = (x ^ (x >>> 17)) >>> 0
      x = (x ^ (x << 5)) >>> 0
      return x / 4294967296
    }
    const off = (2 * draw() - 1) * 0.18 * w
    const angle = draw() * 360
    out.push({ x: round2(px + off * -ty), y: round2(py + off * tx), size: round2(1.6 * w), angle: round2(angle), alpha: Math.round(0.45 * d * 10000) / 10000 })
    if (last) break
    s += Math.max(0.3, w * (0.9 - 0.78 * d))
  }
  return out
}

export type PencilStampV2 = { x: number; y: number; size: number; angle: number; alpha: number; variant: number }

/** Where a live walk of `pencilStampsV2` stopped: the next stamp number `k`, its nominal arc length `s` and the segment that held it. */
export class PencilWalk {
  k = 0
  seg = 0
  s = 0
}

/**
 * Spec rule `stroke.texture.stamps` (stamps v2). `curve` and `densityCurve` turn a stored pressure into `q` (size) and `qd` (step); null is the
 * clamped pressure. `alphaOf` gives the alpha factor `O` of a point (brush.alpha); null uses `opacityFactor`. With `live` and a `walk`, only the
 * stamps new since the walk's last call are returned (append-only, so the earlier ones stay valid). `nominal` collects the nominal `s` of each.
 */
export function pencilStampsV2(o: {
  id: string
  width: number
  usePressure: boolean
  points: readonly (readonly number[])[]
  density?: number
  opacityFactor?: number
  live?: boolean
  curve?: unknown
  densityCurve?: unknown
  alphaOf?: (p: readonly number[]) => number
  walk?: PencilWalk
  nominal?: number[]
}): PencilStampV2[] {
  const { id, width, usePressure, points, density = 1, opacityFactor = 1, live = false, curve = null, densityCurve = null, alphaOf, nominal } = o
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
  const xs: number[] = [], ys: number[] = [], qs: number[] = [], ds: number[] = [], os: number[] = []
  for (const p of points) {
    const x = p[0]!, y = p[1]!
    if (xs.length && Math.hypot(x - xs[xs.length - 1]!, y - ys[ys.length - 1]!) < 0.01) continue
    const v = p[2]
    const pr = !usePressure || typeof v !== 'number' || !Number.isFinite(v) ? 0.5 : v
    xs.push(x); ys.push(y)
    qs.push(curve ? pressureCurve(curve, pr) : clamp(pr, 0, 1))
    ds.push(densityCurve ? pressureCurve(densityCurve, pr) : clamp(pr, 0, 1))
    os.push(alphaOf ? alphaOf(p) : opacityFactor)
  }
  if (!xs.length) return []
  const n = xs.length
  const cum = [0]
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!))
  const total = cum[n - 1]!
  const seed = fnv1a(id)
  const w0 = o.walk ?? new PencilWalk()
  let { seg, s, k } = w0
  const out: PencilStampV2[] = []
  // Segment that holds `at`; a vertex belongs to the segment that starts at it.
  const segOf = (from: number, at: number) => {
    let g = Math.min(Math.max(from, 0), Math.max(0, n - 2))
    while (g > 0 && cum[g]! > at) g--
    while (g < n - 2 && cum[g + 1]! <= at) g++
    return g
  }
  const lerp = (v: number[], g: number, at: number) => {
    if (n === 1) return v[0]!
    const len = cum[g + 1]! - cum[g]!
    const t = len <= 0 ? 0 : clamp((at - cum[g]!) / len, 0, 1)
    return v[g]! + (v[g + 1]! - v[g]!) * t
  }
  for (;;) {
    seg = segOf(seg, s)
    const last = !live && !(s < total - 1e-9)
    if (last) s = total
    const q = lerp(qs, seg, s), qd = lerp(ds, seg, s)
    const w = width * (q < 0.5 ? 0.6 + 0.8 * q : 0.7 + 0.6 * q)
    const d = clamp(0.35 + 0.6 * qd, 0, 1) * density
    const step = Math.max(0.3, w * (0.9 - 0.78 * d))
    if (live && !(s < total - 1e-9 && s + 0.3 * step < total - 1e-9)) break
    let x = (seed ^ k) >>> 0 || 1
    const draw = () => {
      x = (x ^ (x << 13)) >>> 0
      x = (x ^ (x >>> 17)) >>> 0
      x = (x ^ (x << 5)) >>> 0
      return x / 4294967296
    }
    const u1 = draw(), u2 = draw(), u3 = draw(), u4 = draw(), u5 = draw(), u6 = draw()
    const sp = clamp(s + (2 * u6 - 1) * 0.3 * step, 0, total)
    const g = segOf(seg, sp)
    let tx = 1, ty = 0
    if (n > 1) {
      const len = cum[g + 1]! - cum[g]!
      tx = (xs[g + 1]! - xs[g]!) / len
      ty = (ys[g + 1]! - ys[g]!) / len
    }
    const off = (2 * u1 - 1) * 0.25 * w
    out.push({
      x: round2(lerp(xs, g, sp) + off * -ty),
      y: round2(lerp(ys, g, sp) + off * tx),
      size: round2(1.6 * w * (0.85 + 0.3 * u4)),
      angle: round2(u2 * 360),
      alpha: Math.round(0.45 * (0.7 + 0.6 * u5) * lerp(os, g, sp) * 10000) / 10000,
      variant: Math.min(2, Math.floor(u3 * 3)),
    })
    nominal?.push(s)
    if (last) break
    s += step
    k++
  }
  w0.seg = seg; w0.s = s; w0.k = k
  return out
}

const STAMP_FILES = ['pencil_stamp_0.png', 'pencil_stamp_1.png', 'pencil_stamp_2.png']
let imgPromise: Promise<HTMLImageElement[] | null> | null = null
function loadStamps(): Promise<HTMLImageElement[] | null> {
  imgPromise ??= new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null)
    Promise.all(
      STAMP_FILES.map(
        (f) =>
          new Promise<HTMLImageElement>((ok, no) => {
            const img = new Image()
            img.onload = () => ok(img)
            img.onerror = no
            img.src = `${import.meta.env.BASE_URL}${f}`
          }),
      ),
    ).then(resolve, () => resolve(null)) // the plain alpha polygon stays
  })
  return imgPromise
}

/** The three stamp images (shared by every page). `images` is null until all are loaded; set `onReady` to repaint then. */
export class PencilTextures {
  images: HTMLImageElement[] | null = null
  onReady: (() => void) | null = null
  private tinted = new Map<string, CanvasImageSource[]>()
  private ready = loadStamps().then((t) => {
    this.images = t
    if (t) this.onReady?.()
  })

  /** Resolves when the stamps are loaded (export). */
  settled(): Promise<void> {
    return this.ready
  }

  /** The three stamps in `color` (the stamps are alpha only), one set per color. */
  tint(color: string): CanvasImageSource[] | null {
    const imgs = this.images
    if (!imgs) return null
    let t = this.tinted.get(color)
    if (!t) {
      t = imgs.map((img) => {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth || 128
        c.height = img.naturalHeight || 128
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        g.globalCompositeOperation = 'source-in'
        g.fillStyle = color
        g.fillRect(0, 0, c.width, c.height)
        return c
      })
      if (this.tinted.size > 64) this.tinted.clear()
      this.tinted.set(color, t)
    }
    return t
  }
}
