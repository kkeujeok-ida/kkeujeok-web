// Paper, background and strokes of one page onto a 2D canvas context (AD-11).
// The context's own transform is the device pixel ratio; the viewport maps
// page points (pt, top-left origin) into CSS pixels of the canvas.
import { isPdfBackground, patternOf } from '../model/pdfRules'
import { isValidStroke, type Page, type Stroke } from '../model/note'
import { shapeRings } from '../model/shape'
import { pageBackground } from './pageBackground'
import { outlinePath, strokeOutlineFor, strokeSamples } from './strokeOutline'
import { brushAlpha, brushAlphaFactor, brushCurves, brushResolve, tiltSizeFactor } from '../model/brush'
import { getPressureCurve } from '../storage/pressureCurve'
import { smoothPoints } from '../model/smooth'
import { getSmooth } from '../storage/smooth'
import { highlighterOutline, highlighterPath } from './highlighterOutline'
import { drawableImage, paintImage, type ImageSource } from './imagePainter'
import { dotHex, inkHex, invertLayers, lineHex, paperHex } from '../model/invert'
import { isAllDark } from '../storage/theme'
import { drawableText, paintTextBox } from './textPainter'
import { type PencilStampV2, PencilTextures, PencilWalk, pencilDensity, pencilStampsV2 } from './pencilTexture'
import { opacityPressureCurve } from '../model/curve'
import { meanPressure } from './strokeOutline'

/** page point = (local - offset) / scale. Only 2.12 (zoom/pan) changes it. */
export type PageViewport = { scale: number; offsetX: number; offsetY: number }

const finitePositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** The whole page fitted and centered in a `width` x `height` area. */
export function fitViewport(width: number, height: number, pageW: number, pageH: number): PageViewport {
  if (!finitePositive(width) || !finitePositive(height) || !finitePositive(pageW) || !finitePositive(pageH)) {
    return { scale: 1, offsetX: 0, offsetY: 0 }
  }
  const scale = Math.min(width / pageW, height / pageH)
  return { scale, offsetX: (width - pageW * scale) / 2, offsetY: (height - pageH * scale) / 2 }
}

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 8

/** `gap` above, below (and the toolbar side) of the visible area; there is no side margin, so a width fit is the full view width; `extraBottom` more room under a page that is scrolled to its end. */
/** `extraTop`: room above the first page that can be scrolled into (the [페이지 추가] button sits there). */
export type ViewInsets = { gap: number; extraBottom: number; extraTop?: number }
/** A scrollbar thumb as fractions (0..1) of its track. */
export type Thumb = { start: number; size: number }

export const clampScale = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s))
/** Spec zoom.snap: a scale within 10% of the width-fit scale shows as that scale. */
export function snapScale(scale: number, fitScale: number): number {
  const f = clampScale(fitScale)
  const s = clampScale(scale)
  return f * 0.9 <= s && s <= f * 1.1 ? f : s
}
/** A page this close to the view width (float error of a width fit) counts as fitting. */
const FIT_EPS = 0.01
const IDENTITY: PageViewport = { scale: 1, offsetX: 0, offsetY: 0 }

/** The padded area (left, top, width, height without extraBottom), or null when nothing fits. */
function area(w: number, h: number, pageW: number, pageH: number, ins: ViewInsets) {
  const gap = Number.isFinite(ins.gap) && ins.gap > 0 ? ins.gap : 0
  const extra = Number.isFinite(ins.extraBottom) && ins.extraBottom > 0 ? ins.extraBottom : 0
  if (![w, h, pageW, pageH].every(finitePositive)) return null
  const aw = w
  const ah = h - gap * 2 - extra
  if (aw <= 0 || ah <= 0) return null
  const top = Number.isFinite(ins.extraTop) && (ins.extraTop ?? 0) > 0 ? (ins.extraTop as number) : 0
  return { gap, extra, top, aw, ah }
}

/** Page point under the local position (x, y). */
export function toPage(vp: PageViewport, x: number, y: number): [number, number] {
  return [(x - vp.offsetX) / vp.scale, (y - vp.offsetY) / vp.scale]
}

/**
 * `vp` moved into range: an axis where the page fits is centered in the padded
 * area; on a larger one the page may not leave a gap at either edge. The area
 * excludes `extraBottom`, so the end of the page can rise above the toolbar.
 */
export function clampViewport(vp: PageViewport, w: number, h: number, pageW: number, pageH: number, ins: ViewInsets): PageViewport {
  const a = area(w, h, pageW, pageH, ins)
  if (!a || !finitePositive(vp.scale)) return vp
  const axis = (o: number, len: number, avail: number, gap: number, top = 0) => {
    if (len <= avail + FIT_EPS) return gap + (avail - len) / 2
    return Math.min(gap + top, Math.max(gap + avail - len, Number.isFinite(o) ? o : gap))
  }
  return {
    scale: vp.scale,
    offsetX: axis(vp.offsetX, pageW * vp.scale, a.aw, 0),
    offsetY: axis(vp.offsetY, pageH * vp.scale, a.ah, a.gap, a.top),
  }
}

/** The page as wide as the padded area (scale kept in the zoom range), top aligned. */
export function fitWidthViewport(w: number, h: number, pageW: number, pageH: number, ins: ViewInsets): PageViewport {
  const a = area(w, h, pageW, pageH, ins)
  if (!a) return IDENTITY
  const scale = clampScale(a.aw / pageW)
  return clampViewport({ scale, offsetX: 0, offsetY: a.gap }, w, h, pageW, pageH, ins)
}

/** The whole page inside the padded area, centered. */
export function fitPageViewport(w: number, h: number, pageW: number, pageH: number, ins: ViewInsets): PageViewport {
  const a = area(w, h, pageW, pageH, ins)
  if (!a) return IDENTITY
  const scale = clampScale(Math.min(a.aw / pageW, a.ah / pageH))
  return clampViewport({ scale, offsetX: 0, offsetY: 0 }, w, h, pageW, pageH, ins)
}

/** `scale` (in range) with the page point under (fx, fy) staying under it. Not clamped to the page. */
export function zoomAbout(vp: PageViewport, fx: number, fy: number, scale: number): PageViewport {
  const s = clampScale(scale)
  const [px, py] = toPage(vp, fx, fy)
  return { scale: s, offsetX: fx - px * s, offsetY: fy - py * s }
}

/** Scrollbar thumbs of `vp`; an axis whose page is not larger than the area has none. */
export function scrollMetrics(vp: PageViewport, w: number, h: number, pageW: number, pageH: number, ins: ViewInsets) {
  const a = area(w, h, pageW, pageH, ins)
  const none = { x: null as Thumb | null, y: null as Thumb | null }
  if (!a) return none
  const thumb = (o: number, len: number, avail: number, extra: number, gap: number, top = 0): Thumb | null => {
    if (len <= avail + FIT_EPS) return null
    const total = len + extra + top
    const view = avail + extra
    return { start: Math.min(1, Math.max(0, (gap + top - o) / total)), size: Math.min(1, view / total) }
  }
  return {
    x: thumb(vp.offsetX, pageW * vp.scale, a.aw, 0, 0),
    y: thumb(vp.offsetY, pageH * vp.scale, a.ah, a.extra, a.gap, a.top),
  }
}

/** What an edit could change in a finished stroke's outline. */
function cacheKey(s: Stroke): string {
  const pts = s.points
  const first = pts[0]
  const last = pts[pts.length - 1]
  // A cheap digest of every point, so an edit in the middle invalidates too.
  let h = 0
  for (const p of pts) h = (Math.imul(h, 31) + Math.round(p[0]! * 100) + Math.imul(Math.round(p[1]! * 100), 7) + Math.round(p[2]! * 100)) | 0
  return [s.id, s.tool, pts.length, s.width, s.usePressure ? 1 : 0, JSON.stringify(getPressureCurve()), JSON.stringify(s.brush ?? null), getSmooth(), first?.[0], first?.[1], last?.[0], last?.[1], h].join('|')
}

const strokePath = (s: Pick<Stroke, 'tool' | 'width' | 'usePressure' | 'points'> & { brush?: unknown; shape?: unknown }): Path2D => {
  const rings = shapeRings(s) // a shape is a closed outline of one width: no pressure, taper or smoothing
  if (rings) {
    const path = new Path2D()
    for (const ring of rings) {
      ring.forEach((p, i) => (i === 0 ? path.moveTo(p[0]!, p[1]!) : path.lineTo(p[0]!, p[1]!)))
      path.closePath()
    }
    return path
  }
  return polygonsPath(s.tool, piecePolygons(s, s.points))
}

type Polys = number[][][]
const polygonsPath = (tool: unknown, polys: Polys): Path2D => (tool === 'highlighter' ? highlighterPath(polys) : outlinePath(polys[0] ?? []))

/**
 * The polygons of `points` of stroke `s` (all its points, or a piece of a live stroke). `head`/`tail`: the piece starts/ends at the stroke's own
 * start/end (only the fountain taper cares). `cutFrom`/`cutTo` are indices in `points`. Smoothing is screen only: export and print call the outlines directly.
 */
function piecePolygons(s: Pick<Stroke, 'tool' | 'width' | 'usePressure'> & { brush?: unknown }, points: readonly (readonly number[])[], head = true, tail = true, cutFrom?: number, cutTo?: number): Polys {
  const level = getSmooth()
  const pts = smoothPoints(points, level)
  const dense = level > 0 && points.length >= 3 ? 2 : 1 // smoothing doubles the indices
  const from = cutFrom === undefined ? undefined : cutFrom * dense
  const to = cutTo === undefined ? undefined : cutTo * dense
  if (s.tool === 'highlighter') return highlighterOutline(s.width, pts.slice(from ?? 0, to === undefined ? undefined : to + 1))
  if (s.brush === undefined) return [strokeOutlineFor(s.tool, s.width, s.usePressure, pts, undefined, undefined, head, tail, from, to)]
  const b = brushResolve(s.tool, s.brush)
  const tc = brushCurves(s.brush).sizeTiltCurve // the new field, or the old tiltTarget/tiltCurve (brush.legacyTilt)
  const size = tc ? (p: readonly number[]) => tiltSizeFactor(p, tc as number[]) : undefined
  return [strokeOutlineFor(s.tool, s.width, s.usePressure, pts, b.pressureCurve ?? undefined, size, head, tail, from, to)]
}

/** True when stroke `s` is drawn with an alpha per point: a pen or fountain stroke (no stamps, no shape) with an opacity pressure or tilt curve (spec/brush.md "Drawing per-point alpha"). */
export function perPointAlpha(s: { tool?: unknown; brush?: unknown; shape?: unknown }): boolean {
  if (s.tool !== 'pen' && s.tool !== 'fountain') return false
  if (s.brush === undefined || s.shape || brushDraw({ ...s, points: [] }).grain) return false
  const b = brushCurves(s.brush)
  return b.opacityTiltCurve !== null || (!b.curvesOff.includes('opacityPressure') && opacityPressureCurve(s.brush) !== null)
}

export type AlphaPiece = { poly: number[][]; alpha: number }

/**
 * The pieces of a `perPointAlpha` stroke: one quad per gap between outline samples, each starting half a gap early so neighbours overlap, plus the
 * two round caps. Draw them in order with `fillAlphaPieces`. Arguments as `piecePolygons`.
 */
export function alphaPieces(s: Stroke, points: readonly (readonly number[])[], head = true, tail = true, cutFrom?: number, cutTo?: number): AlphaPiece[] {
  const poly = piecePolygons(s, points, head, tail, cutFrom, cutTo)[0] ?? []
  const level = getSmooth()
  const pts = smoothPoints(points, level)
  const dense = level > 0 && points.length >= 3 ? 2 : 1
  const b = { ...brushResolve(s.tool, s.brush), ...brushCurves(s.brush) }
  const up = s.usePressure
  const oc = b.curvesOff.includes('opacityPressure') ? null : opacityPressureCurve(s.brush)
  const num = (p: readonly number[], i: number) => (p.length > i && typeof p[i] === 'number' ? p[i]! : null)
  const alphaOf = (p: readonly number[]) => brushAlpha({ opacity: b.opacity, opacityPressureCurve: oc, opacityTiltCurve: b.opacityTiltCurve, pressure: num(p, 2), tilt: num(p, 4), usePressure: up })
  // Same samples as the outline; the size channel carries the alpha instead.
  const a = strokeSamples(up, pts, (b.pressureCurve ?? undefined) as never, alphaOf, cutFrom === undefined ? undefined : cutFrom * dense, cutTo === undefined ? undefined : cutTo * dense).m
  if (poly.length === 0 || a.length === 0) return []
  if (a.length === 1) return [{ poly, alpha: a[0]! }]
  // polygon = left(n), end cap(7), right reversed(n), start cap(7)
  const n = a.length
  const l = (i: number) => poly[i]!
  const r = (i: number) => poly[n + 7 + (n - 1 - i)]!
  const mid = (p: number[], q: number[]) => [(p[0]! + q[0]!) / 2, (p[1]! + q[1]!) / 2]
  return [
    { poly: [r(0), ...poly.slice(2 * n + 7), l(0)], alpha: a[0]! },
    ...Array.from({ length: n - 1 }, (_, i) => ({
      poly: [i === 0 ? l(0) : mid(l(i - 1), l(i)), l(i + 1), r(i + 1), i === 0 ? r(0) : mid(r(i - 1), r(i))],
      alpha: (a[i]! + a[i + 1]!) / 2,
    })),
    { poly: [l(n - 1), ...poly.slice(n, n + 7), r(n - 1)], alpha: a[n - 1]! },
  ]
}

const piecePath = (poly: readonly (readonly number[])[]) => {
  const path = new Path2D()
  poly.forEach((q, i) => (i === 0 ? path.moveTo(q[0]!, q[1]!) : path.lineTo(q[0]!, q[1]!)))
  path.closePath()
  return path
}

/**
 * Draws `pieces` in one layer; a later piece replaces what is under it (erase, then draw), so seams and self-crossings are not darker.
 * shortcut: the anti-aliased edge pixels of two neighbouring pieces can make a seam on the outer edge a little darker; upgrade by clipping to a union path.
 */
export function fillAlphaPieces(ctx: CanvasRenderingContext2D, pieces: readonly AlphaPiece[], color: unknown, fade = 1, dark = false): void {
  if (pieces.length === 0) return
  const c = typeof color === 'string' && COLOR.test(color) ? color : '#000000'
  const hex = dark ? inkHex(c.slice(0, 7)) : c.slice(0, 7)
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const m = ctx.getTransform()
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pieces) for (const [x, y] of p.poly) {
    const dx = m.a * x! + m.c * y! + m.e, dy = m.b * x! + m.d * y! + m.f
    x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy)
  }
  const bx = Math.floor(x0) - 1, by = Math.floor(y0) - 1
  const w = Math.ceil(x1) + 1 - bx, h = Math.ceil(y1) + 1 - by
  let layer: HTMLCanvasElement | null = null
  let g: CanvasRenderingContext2D | null = null
  try {
    if (w > 0 && h > 0 && w * h < 6e7) {
      layer = document.createElement('canvas')
      layer.width = w
      layer.height = h
      g = layer.getContext('2d')
    }
  } catch { g = null }
  if (!layer || !g) {
    // no offscreen canvas: pieces drawn straight over the paper (seams may show)
    for (const p of pieces) fill(ctx, piecePath(p.poly), hex, 'pen', p.alpha * fade)
    return
  }
  g.setTransform(m.a, m.b, m.c, m.d, m.e - bx, m.f - by)
  for (const p of pieces) {
    const path = piecePath(p.poly)
    g.globalCompositeOperation = 'destination-out'
    g.fillStyle = '#000'
    g.fill(path, 'nonzero')
    g.globalCompositeOperation = 'source-over'
    g.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(1, Math.max(0, p.alpha * fade))})`
    g.fill(path, 'nonzero')
  }
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, bx, by)
  ctx.restore()
}

type Pts = readonly (readonly number[])[]
/** The points after the Prepare step (stroke-geometry.md): one closer than 0.01 pt to the last kept one is dropped. */
export function keptPoints(points: Pts): (readonly number[])[] {
  const out: (readonly number[])[] = []
  for (const p of points) {
    const l = out[out.length - 1]
    if (l && Math.hypot(p[0]! - l[0]!, p[1]! - l[1]!) < 0.01) continue
    out.push(p)
  }
  return out
}

/**
 * What is kept of the stroke being drawn (spec rule `stroke.liveFreeze`). Pens: the kept points are cut into pieces of `CHUNK` points sharing
 * their joint; a piece that ends inside the frozen part (all but the last three) is built once and kept. Smoothing and resampling look at the
 * neighbours, so a piece is built from a window around it and cut back to its own points. Stamps: the live list is append-only.
 */
export class LiveCache {
  static readonly CHUNK = 8
  static readonly MARGIN = 6
  /** The polygons of the closed pieces, in order, and of the open piece built by the last `pathOf`. */
  polygons: Polys = []
  openPolygons: Polys = []
  stamps: PencilStampV2[] = []
  /** Per-point alpha stroke (`perPointAlpha`): the closed pieces (alpha fixed once made) and the open piece of the last `pathOf`. */
  frozenAlpha: AlphaPiece[] = []
  openAlpha: AlphaPiece[] = []
  private key: string | null = null
  private frozen: Path2D | null = null // made on first use: a cache can exist where Path2D does not
  private start = 0
  private kept = 0
  private first: readonly number[] | null = null
  private joint: readonly number[] | null = null
  private walk = new PencilWalk()
  private stampKept = 0
  private stampLast: readonly number[] | null = null

  private reset() {
    this.frozen = null
    this.polygons = []
    this.openPolygons = []
    this.stamps = []
    this.frozenAlpha = []
    this.openAlpha = []
    this.start = this.kept = this.stampKept = 0
    this.first = this.joint = this.stampLast = null
    this.walk = new PencilWalk()
  }

  private sync(s: Stroke, extra: string) {
    const key = JSON.stringify([s.id, s.tool, s.width, s.usePressure, s.brush ?? null, s.color, extra, getSmooth(), getPressureCurve()])
    if (key !== this.key) {
      this.reset()
      this.key = key
    }
  }

  /** Forgets the stroke (pen up or cancel; the next pen down starts clean). */
  clear() {
    if (this.key === null) return
    this.reset()
    this.key = null
  }

  /** The live pen stroke as its kept `frozen` part and the `open` piece. */
  pathOf(s: Stroke): { frozen: Path2D; open: Path2D } {
    this.sync(s, 'path')
    const kept = keptPoints(s.points)
    const same = (a: readonly number[] | null, p: readonly number[] | undefined) => !!a && !!p && a[0] === p[0] && a[1] === p[1]
    if (kept.length < this.kept || (kept.length && this.first && !same(this.first, kept[0])) || (this.joint && !same(this.joint, kept[this.start]))) {
      this.reset()
      this.key = null
      return this.pathOf(s)
    }
    this.kept = kept.length
    if (kept.length) this.first ??= kept[0]!
    const frozen = Math.max(0, kept.length - 3)
    const { CHUNK, MARGIN } = LiveCache
    const pp = perPointAlpha(s)
    // Built from a window around the piece and cut back to its own points: its ends then match what the whole stroke gives at pen up.
    for (;;) {
      const e = this.start + CHUNK - 1
      if (e > frozen - 1 || e + MARGIN > kept.length - 1) break
      const ws = Math.max(0, this.start - MARGIN)
      if (pp) this.frozenAlpha.push(...alphaPieces(s, kept.slice(ws, e + MARGIN + 1), this.start === 0, false, this.start - ws, e - ws))
      else {
        const polys = piecePolygons(s, kept.slice(ws, e + MARGIN + 1), this.start === 0, false, this.start - ws, e - ws)
        this.polygons.push(...polys)
        ;(this.frozen ??= new Path2D()).addPath(polygonsPath(s.tool, polys))
      }
      this.start = e
      this.joint = kept[this.start]!
    }
    const ws = Math.max(0, this.start - MARGIN)
    if (pp) {
      this.openAlpha = alphaPieces(s, kept.slice(ws), this.start === 0, true, this.start - ws)
      return { frozen: this.frozen ?? new Path2D(), open: new Path2D() }
    }
    this.openPolygons = piecePolygons(s, kept.slice(ws), this.start === 0, true, this.start - ws)
    return { frozen: this.frozen ?? new Path2D(), open: polygonsPath(s.tool, this.openPolygons) }
  }

  /** The stamps of the live pencil stroke, with the new ones added. */
  stampsOf(s: Stroke): PencilStampV2[] {
    this.sync(s, 'stamps')
    const kept = keptPoints(s.points)
    const last = this.stampLast
    if (kept.length < this.stampKept || (this.stampKept > 0 && !(last && last[0] === kept[this.stampKept - 1]![0] && last[1] === kept[this.stampKept - 1]![1]))) {
      this.reset()
      this.key = null
      return this.stampsOf(s)
    }
    this.stamps.push(...stampsOf(s, true, this.walk))
    this.stampKept = kept.length
    this.stampLast = kept.length ? kept[kept.length - 1]! : null
    return this.stamps
  }
}

/** Layer alpha of a stroke from its brush, and whether it is drawn through the pencil grain. */
const brushDraw = (s: { tool?: unknown; brush?: unknown; usePressure?: boolean; points: readonly (readonly number[])[] }) => ({
  alpha: brushAlphaFactor(s.tool, s.brush, s.points, s.usePressure !== false),
  grain: s.tool === 'highlighter' || s.tool === 'tape' ? false : s.brush === undefined ? s.tool === 'pencil' : brushResolve(s.tool, s.brush).texture === 'pencil',
})

/** Outlines of finished strokes by stroke id, so a repaint rebuilds none. */
export class StrokePathCache {
  private byId = new Map<string, { key: string; path: Path2D }>()
  private stampsById = new Map<string, { key: string; stamps: PencilStampV2[] }>()
  private alphaById = new Map<string, { key: string; pieces: AlphaPiece[] }>()
  /** The stroke being drawn: its frozen part is kept between frames. */
  readonly live = new LiveCache()
  /** The pencil stamp image; set `textures.onReady` to repaint when it is loaded. */
  readonly textures = new PencilTextures()

  pathOf(s: Stroke): Path2D {
    const key = cacheKey(s)
    const hit = this.byId.get(s.id)
    if (hit && hit.key === key) return hit.path
    const path = strokePath(s)
    this.byId.set(s.id, { key, path })
    return path
  }

  /** Stamps of a finished pencil stroke; rebuilt only when the stroke changes. */
  stampsOf(s: Stroke): PencilStampV2[] {
    const key = cacheKey(s)
    const hit = this.stampsById.get(s.id)
    if (hit && hit.key === key) return hit.stamps
    const stamps = stampsOf(s)
    this.stampsById.set(s.id, { key, stamps })
    return stamps
  }

  /** Pieces of a finished per-point alpha stroke; rebuilt only when the stroke changes. */
  alphaOf(s: Stroke): AlphaPiece[] {
    const key = cacheKey(s)
    const hit = this.alphaById.get(s.id)
    if (hit && hit.key === key) return hit.pieces
    const pieces = alphaPieces(s, s.points)
    this.alphaById.set(s.id, { key, pieces })
    return pieces
  }

  /** Forgets strokes that are no longer on the page. */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const id of this.byId.keys()) if (!ids.has(id)) this.byId.delete(id)
    for (const id of this.stampsById.keys()) if (!ids.has(id)) this.stampsById.delete(id)
    for (const id of this.alphaById.keys()) if (!ids.has(id)) this.alphaById.delete(id)
  }

  /** Kept for callers; the shared stamp needs no freeing. */
  dispose(): void {
    this.textures.onReady = null
  }
}

/** Eraser preview opacity: the design token `components.eraser.preview-opacity`, read from the element's computed style. */
let previewOpacity: number | null = null
export function eraserPreviewOpacity(el: Element): number {
  if (previewOpacity !== null) return previewOpacity
  const n = parseFloat(getComputedStyle(el).getPropertyValue('--components-eraser-preview-opacity'))
  return (previewOpacity = n >= 0 && n <= 1 ? n : 0.35)
}

const MAX_BACKGROUND_ITEMS = 100000
const COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/
const HIGHLIGHTER_ALPHA = 0.4
// A highlighter stroke is one layer (one fill) composited once: 0.4 opacity, multiply (spec stroke-geometry.md).
// All Dark (`dark`): pens use the corrected inverted ink; a highlighter keeps its color with normal alpha (spec invert.md).
const fill = (ctx: CanvasRenderingContext2D, path: Path2D, color: unknown, tool?: unknown, alpha = 1, dark = false) => {
  const c = typeof color === 'string' && COLOR.test(color) ? color : '#000000'
  ctx.fillStyle = dark && tool !== 'highlighter' && tool !== 'tape' ? // a tape is a cover color: drawn as stored (invert.md)
     inkHex(c.slice(0, 7)) : c
  if (tool !== 'highlighter') {
    if (alpha === 1) return ctx.fill(path, 'nonzero')
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fill(path, 'nonzero')
    return ctx.restore()
  }
  ctx.save()
  ctx.globalAlpha = HIGHLIGHTER_ALPHA * alpha
  if (!dark) ctx.globalCompositeOperation = 'multiply'
  ctx.fill(path, 'nonzero')
  ctx.restore()
}

/** Stamps of a stroke (spec stroke.texture.stamps). `live` with a `walk`: only the stamps new since the walk's last call. */
function stampsOf(s: Stroke, live = false, walk?: PencilWalk): PencilStampV2[] {
  const b = { ...brushResolve(s.tool, s.brush), ...brushCurves(s.brush) }
  const up = s.usePressure
  const oc = b.curvesOff.includes('opacityPressure') ? null : opacityPressureCurve(s.brush)
  const num = (p: readonly number[], i: number) => (p.length > i && typeof p[i] === 'number' ? p[i]! : null)
  return pencilStampsV2({
    id: s.id,
    width: s.width,
    usePressure: up,
    points: s.points,
    density: b.density,
    opacityFactor: b.opacity,
    live,
    walk,
    curve: !up ? null : b.pressureCurve && !b.curvesOff.includes('pressure') ? b.pressureCurve : getPressureCurve(),
    densityCurve: !up ? null : b.densityPressureCurve,
    // shortcut: with no opacity curve the alpha is the constant brush opacity; upgrade with a per-point cache if curves make live frames slow.
    alphaOf: oc || b.opacityTiltCurve ? (p) => brushAlpha({ opacity: b.opacity, opacityPressureCurve: oc, opacityTiltCurve: b.opacityTiltCurve, pressure: num(p, 2), tilt: num(p, 4), usePressure: up }) : undefined,
  })
}

/** Draws a pencil stroke: stamps along its path (they are the stroke), or the plain alpha polygon without the stamp image. */
function paintPencil(ctx: CanvasRenderingContext2D, s: Stroke, path: () => Path2D, stamps: () => PencilStampV2[], textures: PencilTextures, fade: number, dark: boolean) {
  const bd = brushDraw(s)
  const col = typeof s.color === 'string' && COLOR.test(s.color) ? s.color.slice(0, 7) : '#000000'
  const img = bd.grain ? textures.tint(dark ? inkHex(col) : col) : null
  if (!img) return fill(ctx, path(), s.color, 'pencil', fade * bd.alpha * pencilDensity(meanPressure(s.usePressure, s.points)).density, dark)
  const m = ctx.getTransform()
  const f = fade // opacity, pressure and tilt alpha are inside each stamp
  ctx.save()
  for (const t of stamps()) {
    const c = Math.cos((t.angle * Math.PI) / 180), n = Math.sin((t.angle * Math.PI) / 180)
    ctx.setTransform(m.a * c + m.c * n, m.b * c + m.d * n, -m.a * n + m.c * c, -m.b * n + m.d * c, m.a * t.x + m.c * t.y + m.e, m.b * t.x + m.d * t.y + m.f)
    ctx.globalAlpha = Math.min(1, t.alpha * f)
    ctx.drawImage(img[t.variant]!, -t.size / 2, -t.size / 2, t.size, t.size)
  }
  ctx.restore()
}

/**
 * Draws `page` (clipped to its bounds) and the optional in-progress stroke
 * `live`. Never throws on bad data: an element that cannot be drawn is skipped.
 */
export function paintPage(
  ctx: CanvasRenderingContext2D,
  page: Page,
  viewport: PageViewport,
  cache: StrokePathCache,
  live?: Stroke | null,
  /** A text box being edited: this draft is drawn in place of the stored element `id` (or on top when it is new). */
  draft?: { id: string; el: Record<string, unknown> } | null,
  /** Where the pictures of image elements come from; none (a thumbnail) draws grey boxes. */
  images?: ImageSource,
  /** Strokes (by id) drawn at `alpha` of their opacity: the ones the eraser would remove. */
  fade?: { ids: ReadonlySet<string>; alpha: number } | null,
  /** Draw in All Dark; default: the current theme. A copy that is saved or exported passes false. */
  allDark: boolean = isAllDark(),
  /** Ids of answer tapes that are open (screen state, pen-kinds.md): drawn as an outline only. */
  openTapes?: ReadonlySet<string>,
): void {
  const { width: w, height: h } = page
  const { scale, offsetX, offsetY } = viewport
  if (!finitePositive(w) || !finitePositive(h)) return
  if (!finitePositive(scale) || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return
  ctx.save()
  try {
    ctx.translate(offsetX, offsetY)
    ctx.scale(scale, scale)
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    ctx.clip()

    // A PDF page inverts nothing, so one rule decides for every layer.
    const dark = allDark && invertLayers({ page, layer: 'paper' }).invert
    const name = patternOf(page.background)
    // A huge page would make the pattern explode: paper only past this count.
    const count = name === 'dot' ? (w / 28) * (h / 28) : name === 'grid' ? (w + h) / 28 : h / 28
    const bg = count > MAX_BACKGROUND_ITEMS ? pageBackground('plain', w, h) : pageBackground(name, w, h)
    ctx.fillStyle = dark ? paperHex() : bg.paper
    ctx.fillRect(0, 0, w, h)
    if (bg.lines.length > 0) {
      ctx.strokeStyle = dark ? lineHex() : bg.lineColor
      ctx.lineWidth = bg.lineWidth
      ctx.beginPath()
      for (const [x1, y1, x2, y2] of bg.lines) {
        ctx.moveTo(x1!, y1!)
        ctx.lineTo(x2!, y2!)
      }
      ctx.stroke()
    }
    if (bg.dots.length > 0) {
      ctx.fillStyle = dark ? dotHex() : bg.dotColor
      ctx.beginPath()
      for (const [x, y] of bg.dots) {
        ctx.moveTo(x! + bg.dotRadius, y!)
        ctx.arc(x!, y!, bg.dotRadius, 0, Math.PI * 2)
      }
      ctx.fill()
    }

    if (images?.pdf && isPdfBackground(page.background)) {
      // The part of the page on screen, for the sharp tile of a zoomed view.
      const dpr = ctx.getTransform().a / scale || 1 // the transform already holds the page scale
      const x0 = -offsetX / scale, y0 = -offsetY / scale
      const vis = { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(w, x0 + ctx.canvas.width / dpr / scale), y1: Math.min(h, y0 + ctx.canvas.height / dpr / scale) }
      images.pdf.paint(ctx, page, vis, scale * dpr)
    }

    const ids = new Set<string>()
    const elements: unknown = page.elements
    // Partial erase: pieces `<id>~<j>` of a faded stroke; its faded copy is clipped to skip them so nothing composites twice.
    const pieces = new Map<string, unknown[]>()
    if (fade && Array.isArray(elements)) {
      for (const e of elements) {
        const id = (e as { id?: unknown } | null)?.id
        const i = typeof id === 'string' ? id.lastIndexOf('~') : -1
        if (i > 0 && fade.ids.has((id as string).slice(0, i))) {
          const k = (id as string).slice(0, i)
          pieces.set(k, [...(pieces.get(k) ?? []), e])
        }
      }
    }
    const ink = dark ? inkHex : undefined
    let dpr = 1
    try { dpr = ctx.getTransform().a / scale || 1 } catch { /* a context without a transform */ }
    const cw = ctx.canvas?.width, ch = ctx.canvas?.height
    const view = cw && ch ? { x0: -offsetX / scale, y0: -offsetY / scale, x1: (cw / dpr - offsetX) / scale, y1: (ch / dpr - offsetY) / scale } : { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }
    let drafted = false
    for (const e of Array.isArray(elements) ? elements : []) {
      try {
        if (draft && (e as { id?: unknown } | null)?.id === draft.id) {
          drafted = true
          paintTextBox(ctx, draft.el, ink)
        } else if (drawableText(e)) paintTextBox(ctx, e, ink)
        else if (drawableImage(e)) paintImage(ctx, e, images, allDark ? invertLayers({ page, element: e as { type: string } }).underlay : undefined)
        if (!isValidStroke(e)) continue
        ids.add(e.id)
        const pcs = pieces.get(e.id)
        if (pcs) {
          ctx.save()
          const hole = new Path2D()
          hole.rect(-1e5, -1e5, 2e5, 2e5)
          // shortcut: even-odd clip, a self-overlapping piece leaks a sliver of the faded copy.
          for (const p of pcs) if (isValidStroke(p)) hole.addPath(cache.pathOf(p))
          ctx.clip(hole, 'evenodd')
        }
        const fa = fade?.ids.has(e.id) ? fade.alpha : 1
        if (e.tool === 'tape' && openTapes?.has(e.id)) {
          ctx.save()
          ctx.globalAlpha = 0.6 * fa
          ctx.lineWidth = 1.5 / scale
          ctx.strokeStyle = COLOR.test(e.color) ? e.color : '#000000'
          ctx.stroke(cache.pathOf(e))
          ctx.restore()
        } else {
          const bd = brushDraw(e)
          if (e.tool === 'pencil' || bd.grain) paintPencil(ctx, e, () => cache.pathOf(e), () => cache.stampsOf(e), cache.textures, fa, dark)
          else if (perPointAlpha(e)) fillAlphaPieces(ctx, cache.alphaOf(e), e.color, fa, dark)
          else fill(ctx, cache.pathOf(e), e.color, e.tool, fa * bd.alpha, dark)
        }
        if (pcs) ctx.restore()
      } catch {
        // one bad element must not hide the rest
      }
    }
    if (draft && !drafted) {
      try {
        paintTextBox(ctx, draft.el, ink)
      } catch {
        // the draft is skipped for this frame
      }
    }
    cache.keepOnly(ids)
    if (live && isValidStroke(live)) {
      try {
        const bd = brushDraw(live)
        const cached = !(live as { shape?: unknown }).shape // a shape has no pen points to freeze: built each frame
        if (live.tool === 'pencil' || bd.grain) paintPencil(ctx, live, () => strokePath(live), () => (cached ? cache.live.stampsOf(live) : stampsOf(live)), cache.textures, 1, dark)
        else if (cached && perPointAlpha(live)) {
          cache.live.pathOf(live)
          fillAlphaPieces(ctx, [...cache.live.frozenAlpha, ...cache.live.openAlpha], live.color, 1, dark)
        } else if (!cached) fill(ctx, strokePath(live), live.color, live.tool, bd.alpha, dark)
        else {
          const lp = cache.live.pathOf(live)
          if (live.tool !== 'highlighter' && bd.alpha === 1) {
            fill(ctx, lp.frozen, live.color, live.tool, 1, dark)
            fill(ctx, lp.open, live.color, live.tool, 1, dark)
          } else {
            // one layer, so the overlap of the pieces is not drawn twice
            const all = new Path2D(lp.frozen)
            all.addPath(lp.open)
            fill(ctx, all, live.color, live.tool, bd.alpha, dark)
          }
        }
      } catch {
        // the stroke in progress is skipped for this frame
      }
    } else cache.live.clear()
  } finally {
    ctx.restore()
  }
}

/** A `pageW` x `pageH` box (a page, or two side by side) as tall as the padded area, starting at its left edge. */
export function fitHeightViewport(w: number, h: number, pageW: number, pageH: number, ins: ViewInsets): PageViewport {
  const a = area(w, h, pageW, pageH, ins)
  if (!a) return IDENTITY
  const scale = clampScale(a.ah / pageH)
  return clampViewport({ scale, offsetX: 0, offsetY: a.gap }, w, h, pageW, pageH, ins)
}

/** Spec rule `stroke.liveFreeze`: how many kept points are frozen while the pen is down (all but the last three), and for a pencil `stamps` how many `live` stamps lie at or before the length of the frozen polyline. */
export function liveFreeze(points: Pts, stamps?: { id: string; width: number; usePressure: boolean; density?: number }) {
  const kept = keptPoints(points)
  const frozen = Math.max(0, kept.length - 3)
  let frozenStamps: number | undefined
  if (stamps) {
    let lk = 0
    for (let i = 1; i < frozen; i++) lk += Math.hypot(kept[i]![0]! - kept[i - 1]![0]!, kept[i]![1]! - kept[i - 1]![1]!)
    const nominal: number[] = []
    pencilStampsV2({ ...stamps, points, live: true, nominal })
    frozenStamps = frozen === 0 ? 0 : nominal.filter((s) => s <= lk + 1e-9).length
  }
  return { keptCount: kept.length, frozenCount: frozen, ...(frozenStamps === undefined ? {} : { frozenStamps }) }
}
