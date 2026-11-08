// Paper, background and strokes of one page onto a 2D canvas context (AD-11).
// The context's own transform is the device pixel ratio; the viewport maps
// page points (pt, top-left origin) into CSS pixels of the canvas.
import { isPdfBackground, patternOf } from '../model/pdfRules'
import { isValidStroke, type Page, type Stroke } from '../model/note'
import { pageBackground } from './pageBackground'
import { outlinePath, strokeOutlineFor } from './strokeOutline'
import { getPressureCurve } from '../storage/pressureCurve'
import { smoothPoints } from '../model/smooth'
import { getSmooth } from '../storage/smooth'
import { highlighterOutline, highlighterPath } from './highlighterOutline'
import { drawableImage, paintImage, type ImageSource } from './imagePainter'
import { dotHex, inkHex, invertLayers, lineHex, paperHex } from '../model/invert'
import { isAllDark } from '../storage/theme'
import { drawableText, paintTextBox } from './textPainter'
import { PENCIL_GRAIN_SCALE, PencilTextures, pencilDensity } from './pencilTexture'
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
  return [s.id, s.tool, pts.length, s.width, s.usePressure ? 1 : 0, JSON.stringify(getPressureCurve()), getSmooth(), first?.[0], first?.[1], last?.[0], last?.[1], h].join('|')
}

const strokePath = (s: Pick<Stroke, 'tool' | 'width' | 'usePressure' | 'points'>): Path2D => {
  const pts = smoothPoints(s.points, getSmooth()) // screen only: export and print call the outlines directly
  return s.tool === 'highlighter' ? highlighterPath(highlighterOutline(s.width, pts)) : outlinePath(strokeOutlineFor(s.tool, s.width, s.usePressure, pts))
}

/** Outlines of finished strokes by stroke id, so a repaint rebuilds none. */
export class StrokePathCache {
  private byId = new Map<string, { key: string; path: Path2D }>()
  /** The pencil grain tile; set `textures.onReady` to repaint when it is loaded. */
  readonly textures = new PencilTextures()

  pathOf(s: Stroke): Path2D {
    const key = cacheKey(s)
    const hit = this.byId.get(s.id)
    if (hit && hit.key === key) return hit.path
    const path = strokePath(s)
    this.byId.set(s.id, { key, path })
    return path
  }

  /** Forgets strokes that are no longer on the page. */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const id of this.byId.keys()) if (!ids.has(id)) this.byId.delete(id)
  }

  /** Kept for callers; the shared tile needs no freeing. */
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

// Scratch canvas for one pencil stroke: the polygon in the stroke colour, cut by the grain tile.
let scratch: HTMLCanvasElement | OffscreenCanvas | null = null
const MAX_SIDE = 4096

/** Fills a pencil stroke through the grain tile, anchored at its first point so the grain moves with the stroke. Falls back to the plain alpha polygon (no tile, or a huge area). */
function fillPencil(ctx: CanvasRenderingContext2D, path: Path2D, s: Pick<Stroke, 'color' | 'width' | 'usePressure' | 'points'>, tile: CanvasImageSource | null, view: { x0: number; y0: number; x1: number; y1: number }, alpha: number, dark: boolean) {
  const density = pencilDensity(meanPressure(s.usePressure, s.points)).density
  const plain = () => fill(ctx, path, s.color, 'pencil', alpha * density, dark)
  if (!tile || s.points.length === 0) return plain()
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of s.points) {
    x0 = Math.min(x0, p[0]!); x1 = Math.max(x1, p[0]!)
    y0 = Math.min(y0, p[1]!); y1 = Math.max(y1, p[1]!)
  }
  const r = s.width * 1.5 + 1
  x0 = Math.max(x0 - r, view.x0); y0 = Math.max(y0 - r, view.y0); x1 = Math.min(x1 + r, view.x1); y1 = Math.min(y1 + r, view.y1)
  if (x1 <= x0 || y1 <= y0) return
  const m = ctx.getTransform()
  const dx0 = Math.floor(m.a * x0 + m.e), dy0 = Math.floor(m.d * y0 + m.f)
  const w = Math.ceil(m.a * x1 + m.e) - dx0, h = Math.ceil(m.d * y1 + m.f) - dy0
  if (w <= 0 || h <= 0) return
  if (w > MAX_SIDE || h > MAX_SIDE) return plain()
  if (!scratch) scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas')
  if (scratch.width < w) scratch.width = w
  if (scratch.height < h) scratch.height = h
  const c = scratch.getContext('2d') as CanvasRenderingContext2D
  const col = typeof s.color === 'string' && COLOR.test(s.color) ? s.color : '#000000'
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalCompositeOperation = 'source-over'
  c.clearRect(0, 0, scratch.width, scratch.height)
  c.setTransform(m.a, 0, 0, m.d, m.e - dx0, m.f - dy0)
  c.fillStyle = dark ? inkHex(col.slice(0, 7)) : col
  c.fill(path, 'nonzero')
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalCompositeOperation = 'destination-in'
  const pat = c.createPattern(tile, 'repeat')
  if (!pat) return plain()
  const k = PENCIL_GRAIN_SCALE
  const f = s.points[0]!
  pat.setTransform(new DOMMatrix([m.a * k, 0, 0, m.d * k, m.a * f[0]! + m.e - dx0, m.d * f[1]! + m.f - dy0]))
  c.fillStyle = pat
  c.fillRect(0, 0, w, h)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = alpha * density
  ctx.drawImage(scratch, 0, 0, w, h, dx0, dy0, w, h)
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
        } else if (e.tool === 'pencil') fillPencil(ctx, cache.pathOf(e), e, cache.textures.tile, view, fa, dark)
        else fill(ctx, cache.pathOf(e), e.color, e.tool, fa, dark)
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
        if (live.tool === 'pencil') fillPencil(ctx, strokePath(live), live, cache.textures.tile, view, 1, dark)
        else fill(ctx, strokePath(live), live.color, live.tool, 1, dark)
      } catch {
        // the stroke in progress is skipped for this frame
      }
    }
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
