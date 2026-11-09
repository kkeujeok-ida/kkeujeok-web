// spec rules `stroke.texture.pencil` and `stroke.texture.pencilStamps` (pen-kinds.md): stamps placed along the stroke
// from its points and id, never stored in a note. The stamp is public/pencil_stamp.png (128 px, alpha only).
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

let imgPromise: Promise<HTMLImageElement | null> | null = null
function loadStamp(): Promise<HTMLImageElement | null> {
  imgPromise ??= new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null) // the plain alpha polygon stays
    img.src = `${import.meta.env.BASE_URL}pencil_stamp.png`
  })
  return imgPromise
}

/** The stamp image (shared by every page). `image` is null until loaded; set `onReady` to repaint then. */
export class PencilTextures {
  image: HTMLImageElement | null = null
  onReady: (() => void) | null = null
  private tinted = new Map<string, CanvasImageSource>()
  private ready = loadStamp().then((t) => {
    this.image = t
    if (t) this.onReady?.()
  })

  /** Resolves when the stamp is loaded (export). */
  settled(): Promise<void> {
    return this.ready
  }

  /** The stamp in `color` (the stamp is alpha only), one per color. */
  tint(color: string): CanvasImageSource | null {
    const img = this.image
    if (!img) return null
    let t = this.tinted.get(color)
    if (!t) {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth || 128
      c.height = img.naturalHeight || 128
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      g.globalCompositeOperation = 'source-in'
      g.fillStyle = color
      g.fillRect(0, 0, c.width, c.height)
      if (this.tinted.size > 64) this.tinted.clear()
      this.tinted.set(color, (t = c))
    }
    return t
  }
}
