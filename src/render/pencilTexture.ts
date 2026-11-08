// spec rule `stroke.texture.pencil` (pen-kinds.md): the pencil grain. Integer maths only (Math.imul, >>> 0);
// the texture is never stored, it is cut from the stroke polygon at draw time.
import { smoothPoints } from '../model/smooth'
import { getSmooth } from '../storage/smooth'
import { getPressureCurve } from '../storage/pressureCurve'
import type { Stroke } from '../model/note'
import { strokeOutlineFor, strokeSamples } from './strokeOutline'

export const PENCIL_CELL = 0.5
const MAX_CELLS = 4_000_000
const MAX_SIDE = 8192

/** 32-bit FNV-1a of the UTF-8 bytes of the stroke id. */
export function pencilSeed(id: string): number {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(id)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h
}

/** The grain 0..65535 of cell (i, j); negative cells wrap modulo 2^32. */
export function pencilGrain(seed: number, i: number, j: number): number {
  let h = (seed ^ Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca77)) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h >>> 16
}

/** `density(q)` and `threshold(q)`; q is clamped to 0..1. */
export function pencilDensity(q: number): { density: number; threshold: number } {
  const c = Number.isNaN(q) ? 0.5 : Math.min(1, Math.max(0, q))
  const density = 0.35 + 0.6 * c
  return { density, threshold: Math.floor(density * 65536 + 1e-6) }
}

export type PencilCells = { i0: number; j0: number; w: number; h: number; alpha: Uint8Array }
export type Samples = { x: number[]; y: number[]; q: number[] }

/**
 * Cuts the texture out of `polygon` (non-zero rule): a cell is inked when its centre is inside and
 * `grain < threshold(q)`, q from the nearest sample (lower index on a tie). Null when the box is over the limits.
 */
export function buildPencilCells(polygon: readonly (readonly number[])[], smp: Samples, seed: number, maxCells = MAX_CELLS, maxSide = MAX_SIDE): PencilCells | null {
  const n = smp.x.length
  if (polygon.length < 3 || n === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of polygon) {
    minX = Math.min(minX, p[0]!); maxX = Math.max(maxX, p[0]!)
    minY = Math.min(minY, p[1]!); maxY = Math.max(maxY, p[1]!)
  }
  const i0 = Math.floor(minX / PENCIL_CELL), j0 = Math.floor(minY / PENCIL_CELL)
  const w = Math.floor(maxX / PENCIL_CELL) - i0 + 1
  const h = Math.floor(maxY / PENCIL_CELL) - j0 + 1
  if (!(w > 0 && h > 0) || w > maxSide || h > maxSide || w * h > maxCells) return null

  // Crossings of the cell-centre rows with the polygon edges, with winding.
  const rows: ([number, number][] | undefined)[] = new Array(h)
  for (let k = 0; k < polygon.length; k++) {
    const a = polygon[k]!, b = polygon[(k + 1) % polygon.length]!
    if (a[1] === b[1]) continue
    const lo = Math.min(a[1]!, b[1]!), hi = Math.max(a[1]!, b[1]!)
    const dir = b[1]! > a[1]! ? 1 : -1
    const jFrom = Math.max(j0, Math.ceil(lo / PENCIL_CELL - 0.5))
    const jTo = Math.min(j0 + h - 1, Math.ceil(hi / PENCIL_CELL - 0.5) - 1)
    for (let j = jFrom; j <= jTo; j++) {
      const yc = (j + 0.5) * PENCIL_CELL
      const x = a[0]! + ((yc - a[1]!) * (b[0]! - a[0]!)) / (b[1]! - a[1]!)
      ;(rows[j - j0] ??= []).push([x, dir])
    }
  }

  // Bucket grid of the samples for the nearest-sample search.
  const bs = 4
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity
  for (let s = 0; s < n; s++) {
    sMinX = Math.min(sMinX, smp.x[s]!); sMaxX = Math.max(sMaxX, smp.x[s]!)
    sMinY = Math.min(sMinY, smp.y[s]!); sMaxY = Math.max(sMaxY, smp.y[s]!)
  }
  const gw = Math.floor((sMaxX - sMinX) / bs) + 1
  const gh = Math.floor((sMaxY - sMinY) / bs) + 1
  const grid: (number[] | undefined)[] = new Array(gw * gh)
  for (let s = 0; s < n; s++) {
    ;(grid[Math.floor((smp.y[s]! - sMinY) / bs) * gw + Math.floor((smp.x[s]! - sMinX) / bs)] ??= []).push(s)
  }
  const nearestQ = (cx: number, cy: number): number => {
    const gx = Math.floor((cx - sMinX) / bs), gy = Math.floor((cy - sMinY) / bs)
    let best = Infinity, bestIdx = 0
    for (let k = 0; k <= gw + gh + 3; k++) {
      if (Number.isFinite(best)) {
        // Distance from the centre to outside the buckets already searched.
        const margin = Math.min(cx - (sMinX + (gx - k + 1) * bs), sMinX + (gx + k) * bs - cx, cy - (sMinY + (gy - k + 1) * bs), sMinY + (gy + k) * bs - cy)
        if (Math.sqrt(best) <= margin) break
      }
      for (let y = gy - k; y <= gy + k; y++) {
        if (y < 0 || y >= gh) continue
        const edge = y === gy - k || y === gy + k
        for (let x = gx - k; x <= gx + k; x += edge || k === 0 ? 1 : 2 * k) {
          if (x < 0 || x >= gw) continue
          for (const s of grid[y * gw + x] ?? []) {
            const dx = smp.x[s]! - cx, dy = smp.y[s]! - cy
            const d = dx * dx + dy * dy
            if (d < best || (d === best && s < bestIdx)) { best = d; bestIdx = s }
          }
        }
      }
    }
    if (!Number.isFinite(best)) {
      // The grid search ran out (a cell far from every sample): scan them all.
      for (let s = 0; s < n; s++) {
        const dx = smp.x[s]! - cx, dy = smp.y[s]! - cy
        const d = dx * dx + dy * dy
        if (d < best) { best = d; bestIdx = s }
      }
    }
    return smp.q[bestIdx]!
  }

  const maxThreshold = pencilDensity(1).threshold
  const alpha = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) {
    const cr = rows[r]
    if (!cr) continue
    cr.sort((p, q) => p[0] - q[0])
    const j = j0 + r, cy = (j + 0.5) * PENCIL_CELL
    let wind = 0
    for (let k = 0; k + 1 < cr.length; k++) {
      wind += cr[k]![1]
      if (wind === 0) continue
      const iFrom = Math.max(i0, Math.ceil(cr[k]![0] / PENCIL_CELL - 0.5))
      const iTo = Math.min(i0 + w, Math.ceil(cr[k + 1]![0] / PENCIL_CELL - 0.5))
      for (let i = iFrom; i < iTo; i++) {
        const g = pencilGrain(seed, i, j)
        if (g >= maxThreshold) continue
        if (g >= pencilDensity(nearestQ((i + 0.5) * PENCIL_CELL, cy)).threshold) continue
        alpha[r * w + (i - i0)] = 255
      }
    }
  }
  return { i0, j0, w, h, alpha }
}

/** A ready texture: `image` covers `dst` (page pt) in the frame it was built in; draw it under the similarity `m` = [a, b, tx, ty] (x' = a x - b y + tx, y' = b x + a y + ty), null when unmoved. */
export type PencilDraw = { image: CanvasImageSource; w: number; h: number; dst: { x: number; y: number; w: number; h: number }; m: number[] | null }

/** The opaque mask of `cells` as a canvas (white where inked); the colour is applied when drawing. */
function makeImage(c: PencilCells): CanvasImageSource {
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(c.w, c.h) : Object.assign(document.createElement('canvas'), { width: c.w, height: c.h })
  const data = new Uint8ClampedArray(c.w * c.h * 4)
  for (let k = 0; k < c.alpha.length; k++) if (c.alpha[k]) data.fill(255, k * 4, k * 4 + 4)
  ;(canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(data, c.w, c.h), 0, 0)
  return canvas
}
const release = (img: CanvasImageSource | null) => {
  if (img && 'width' in img) (img as HTMLCanvasElement).width = 0 // frees the backing store
}

type Pts = readonly (readonly number[])[]
type Entry = {
  id: string; sig: unknown[]; points: Pts; width: number; usePressure: boolean; frame: Float64Array
  image: CanvasImageSource | null; dst: PencilDraw['dst']; w: number; h: number; cells: number; used: number
  m: number[] | null; curKey: number[] | null
  queued: boolean; failed: boolean; evicted: boolean; lost: boolean
}

const xy = (pts: Pts): Float64Array => {
  const f = new Float64Array(pts.length * 2)
  pts.forEach((p, i) => { f[2 * i] = p[0]!; f[2 * i + 1] = p[1]! })
  return f
}

/** The similarity taking the build frame to `pts`: from the first two distinct points, checked at the middle and last point to 0.01. Null when it does not hold or the scale is outside 0.5..2; [] for no change. */
function fit(f: Float64Array, pts: Pts): number[] | null {
  let k = 0
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(f[2 * i]! - f[0]!) > 1e-9 || Math.abs(f[2 * i + 1]! - f[1]!) > 1e-9) { k = i; break }
  }
  let a = 1, b = 0
  if (k > 0) {
    const ax = f[2 * k]! - f[0]!, ay = f[2 * k + 1]! - f[1]!
    const bx = pts[k]![0]! - pts[0]![0]!, by = pts[k]![1]! - pts[0]![1]!
    const d = ax * ax + ay * ay
    a = (bx * ax + by * ay) / d
    b = (by * ax - bx * ay) / d
    const sc = Math.hypot(a, b)
    if (!(sc >= 0.5 && sc <= 2)) return null
  }
  const tx = pts[0]![0]! - (a * f[0]! - b * f[1]!)
  const ty = pts[0]![1]! - (b * f[0]! + a * f[1]!)
  for (const i of [pts.length >> 1, pts.length - 1]) {
    const ex = a * f[2 * i]! - b * f[2 * i + 1]! + tx, ey = b * f[2 * i]! + a * f[2 * i + 1]! + ty
    if (Math.abs(ex - pts[i]![0]!) > 0.01 || Math.abs(ey - pts[i]![1]!) > 0.01) return null
  }
  return Math.abs(a - 1) < 1e-9 && Math.abs(b) < 1e-9 && Math.abs(tx) < 1e-9 && Math.abs(ty) < 1e-9 ? [] : [a, b, tx, ty]
}

/**
 * Cell images of finished pencil strokes by id (never stored in the note). Built one stroke per tick off the paint
 * path; `lookup` is null until a texture is ready (the caller draws the alpha polygon) and `onReady` repaints.
 * With no `onReady` (a one-off painter: thumbnail, preview) nothing is built. A move, scale or rotate that is a
 * similarity (scale 0.5..2) reuses the image under a transform.
 */
export class PencilTextures {
  static maxTotalCells = 16_000_000
  onReady: (() => void) | null = null
  private byId = new Map<string, Entry>()
  private queue: Entry[] = []
  private running = false
  private disposed = false
  private clock = 0
  private total = 0
  constructor(private makeImg: (c: PencilCells) => CanvasImageSource = makeImage) {}

  /** Resolves when every queued build is done (tests). */
  async settled(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 1))
  }

  lookup(s: Pick<Stroke, 'id' | 'width' | 'usePressure' | 'points'>): PencilDraw | null {
    const pts = s.points
    if (this.disposed || !this.onReady || pts.length === 0) return null
    const sig = [pts.length, s.width, s.usePressure, JSON.stringify(getPressureCurve()), getSmooth()]
    let e = this.byId.get(s.id)
    if (e && (e.lost || e.sig.length !== sig.length || e.sig.some((v, i) => v !== sig[i]))) {
      this.drop(e)
      e = undefined
    }
    if (!e) {
      e = { id: s.id, sig, points: pts, width: s.width, usePressure: s.usePressure, frame: xy(pts), image: null, dst: { x: 0, y: 0, w: 0, h: 0 }, w: 0, h: 0, cells: 0, used: 0, m: null, curKey: null, queued: false, failed: false, evicted: false, lost: false }
      this.byId.set(s.id, e)
    }
    if (!e.image && !e.queued && !e.failed && !e.evicted) {
      e.queued = true
      this.queue.push(e)
      void this.pump()
    }
    e.used = ++this.clock
    if (!e.image) return null
    const last = pts.length - 1
    const key = [0, pts.length >> 1, last].flatMap((i) => [pts[i]![0]!, pts[i]![1]!])
    if (!e.curKey || e.curKey.some((v, i) => v !== key[i])) {
      e.curKey = key
      const m = fit(e.frame, pts)
      if (!m) { e.lost = true; return null }
      e.m = m.length ? m : null
    }
    return { image: e.image, w: e.w, h: e.h, dst: e.dst, m: e.m }
  }

  /** Forgets strokes that are no longer on the page. */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const e of [...this.byId.values()]) if (!ids.has(e.id)) this.drop(e)
  }

  dispose(): void {
    this.disposed = true
    this.queue.length = 0
    for (const e of [...this.byId.values()]) this.drop(e)
  }

  private drop(e: Entry): void {
    if (this.byId.get(e.id) === e) this.byId.delete(e.id)
    this.total -= e.cells
    e.cells = 0
    release(e.image)
    e.image = null
    e.lost = true
    // Room was freed: strokes evicted for lack of it may build again.
    for (const o of this.byId.values()) o.evicted = false
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 0)) // let frames run between builds
        const e = this.queue.shift()!
        e.queued = false
        if (this.byId.get(e.id) !== e) continue
        try {
          const pts = smoothPoints(e.points as number[][], getSmooth())
          const cells = buildPencilCells(strokeOutlineFor('pencil', e.width, e.usePressure, pts), strokeSamples(e.usePressure, pts), pencilSeed(e.id))
          if (!cells) { e.failed = true; continue } // too big or empty: alpha polygon
          e.image = this.makeImg(cells)
          e.w = cells.w
          e.h = cells.h
          e.cells = cells.w * cells.h
          e.dst = { x: cells.i0 * PENCIL_CELL, y: cells.j0 * PENCIL_CELL, w: cells.w * PENCIL_CELL, h: cells.h * PENCIL_CELL }
          this.total += e.cells
          this.evict(e)
          if (!this.disposed) this.onReady?.()
        } catch {
          e.failed = true // falls back to the alpha polygon, never rebuilt
        }
      }
    } finally {
      this.running = false
    }
  }

  // Least recently used first, never `keep`. The entry stays (marked) so it is not rebuilt and evicted again in a loop.
  private evict(keep: Entry): void {
    if (this.total <= PencilTextures.maxTotalCells) return
    const old = [...this.byId.values()].filter((e) => e !== keep && e.image).sort((a, b) => a.used - b.used)
    for (const e of old) {
      if (this.total <= PencilTextures.maxTotalCells) break
      this.total -= e.cells
      e.cells = 0
      release(e.image)
      e.image = null
      e.evicted = true
    }
  }
}

/** True when `s` (with its widest radius) can touch the page-space rectangle. */
export function pencilTouches(s: Pick<Stroke, 'width' | 'points'>, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
  let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity
  for (const p of s.points) {
    l = Math.min(l, p[0]!); rr = Math.max(rr, p[0]!)
    t = Math.min(t, p[1]!); b = Math.max(b, p[1]!)
  }
  const m = s.width + 1
  return l - m <= r.x1 && rr + m >= r.x0 && t - m <= r.y1 && b + m >= r.y0
}
