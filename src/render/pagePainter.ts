// Paper, background and strokes of one page onto a 2D canvas context (AD-11).
// The context's own transform is the device pixel ratio; the viewport maps
// page points (pt, top-left origin) into CSS pixels of the canvas.
import { isValidStroke, type Page, type Stroke } from '../model/note'
import { pageBackground } from './pageBackground'
import { outlinePath, strokeOutline } from './strokeOutline'
import { drawableImage, paintImage, type ImageSource } from './imagePainter'
import { drawableText, paintTextBox } from './textPainter'

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

/** `gap` around the visible area; `extraBottom` more room under a page that is scrolled to its end. */
export type ViewInsets = { gap: number; extraBottom: number }
/** A scrollbar thumb as fractions (0..1) of its track. */
export type Thumb = { start: number; size: number }

export const clampScale = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s))
/** Spec zoom.snap: a scale within 10% of the width-fit scale shows as that scale. */
export function snapScale(scale: number, fitScale: number): number {
  const f = clampScale(fitScale)
  const s = clampScale(scale)
  return f * 0.9 <= s && s <= f * 1.1 ? f : s
}
const IDENTITY: PageViewport = { scale: 1, offsetX: 0, offsetY: 0 }

/** The padded area (left, top, width, height without extraBottom), or null when nothing fits. */
function area(w: number, h: number, pageW: number, pageH: number, ins: ViewInsets) {
  const gap = Number.isFinite(ins.gap) && ins.gap > 0 ? ins.gap : 0
  const extra = Number.isFinite(ins.extraBottom) && ins.extraBottom > 0 ? ins.extraBottom : 0
  if (![w, h, pageW, pageH].every(finitePositive)) return null
  const aw = w - gap * 2
  const ah = h - gap * 2 - extra
  if (aw <= 0 || ah <= 0) return null
  return { gap, extra, aw, ah }
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
  const axis = (o: number, len: number, avail: number) => {
    if (len <= avail) return a.gap + (avail - len) / 2
    return Math.min(a.gap, Math.max(a.gap + avail - len, Number.isFinite(o) ? o : a.gap))
  }
  return {
    scale: vp.scale,
    offsetX: axis(vp.offsetX, pageW * vp.scale, a.aw),
    offsetY: axis(vp.offsetY, pageH * vp.scale, a.ah),
  }
}

/** The page as wide as the padded area (scale kept in the zoom range), top aligned. */
export function fitWidthViewport(w: number, h: number, pageW: number, pageH: number, ins: ViewInsets): PageViewport {
  const a = area(w, h, pageW, pageH, ins)
  if (!a) return IDENTITY
  const scale = clampScale(a.aw / pageW)
  return clampViewport({ scale, offsetX: a.gap, offsetY: a.gap }, w, h, pageW, pageH, ins)
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
  const thumb = (o: number, len: number, avail: number, extra: number): Thumb | null => {
    if (len <= avail) return null
    const total = len + extra
    const view = avail + extra
    return { start: Math.min(1, Math.max(0, (a.gap - o) / total)), size: Math.min(1, view / total) }
  }
  return {
    x: thumb(vp.offsetX, pageW * vp.scale, a.aw, 0),
    y: thumb(vp.offsetY, pageH * vp.scale, a.ah, a.extra),
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
  return [s.id, pts.length, s.width, s.usePressure ? 1 : 0, first?.[0], first?.[1], last?.[0], last?.[1], h].join('|')
}

/** Outlines of finished strokes by stroke id, so a repaint rebuilds none. */
export class StrokePathCache {
  private byId = new Map<string, { key: string; path: Path2D }>()

  pathOf(s: Stroke): Path2D {
    const key = cacheKey(s)
    const hit = this.byId.get(s.id)
    if (hit && hit.key === key) return hit.path
    const path = outlinePath(strokeOutline(s.width, s.usePressure, s.points))
    this.byId.set(s.id, { key, path })
    return path
  }

  /** Forgets strokes that are no longer on the page. */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const id of this.byId.keys()) if (!ids.has(id)) this.byId.delete(id)
  }
}

const MAX_BACKGROUND_ITEMS = 100000
const COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/
const fill = (ctx: CanvasRenderingContext2D, path: Path2D, color: unknown) => {
  ctx.fillStyle = typeof color === 'string' && COLOR.test(color) ? color : '#000000'
  ctx.fill(path, 'nonzero')
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

    const name = typeof page.background === 'string' ? page.background : 'plain'
    // A huge page would make the pattern explode: paper only past this count.
    const count = name === 'dot' ? (w / 28) * (h / 28) : name === 'grid' ? (w + h) / 28 : h / 28
    const bg = count > MAX_BACKGROUND_ITEMS ? pageBackground('plain', w, h) : pageBackground(name, w, h)
    ctx.fillStyle = bg.paper
    ctx.fillRect(0, 0, w, h)
    if (bg.lines.length > 0) {
      ctx.strokeStyle = bg.lineColor
      ctx.lineWidth = bg.lineWidth
      ctx.beginPath()
      for (const [x1, y1, x2, y2] of bg.lines) {
        ctx.moveTo(x1!, y1!)
        ctx.lineTo(x2!, y2!)
      }
      ctx.stroke()
    }
    if (bg.dots.length > 0) {
      ctx.fillStyle = bg.dotColor
      ctx.beginPath()
      for (const [x, y] of bg.dots) {
        ctx.moveTo(x! + bg.dotRadius, y!)
        ctx.arc(x!, y!, bg.dotRadius, 0, Math.PI * 2)
      }
      ctx.fill()
    }

    const ids = new Set<string>()
    const elements: unknown = page.elements
    let drafted = false
    for (const e of Array.isArray(elements) ? elements : []) {
      try {
        if (draft && (e as { id?: unknown } | null)?.id === draft.id) {
          drafted = true
          paintTextBox(ctx, draft.el)
        } else if (drawableText(e)) paintTextBox(ctx, e)
        else if (drawableImage(e)) paintImage(ctx, e, images)
        if (!isValidStroke(e)) continue
        ids.add(e.id)
        fill(ctx, cache.pathOf(e), e.color)
      } catch {
        // one bad element must not hide the rest
      }
    }
    if (draft && !drafted) {
      try {
        paintTextBox(ctx, draft.el)
      } catch {
        // the draft is skipped for this frame
      }
    }
    cache.keepOnly(ids)
    if (live && isValidStroke(live)) {
      try {
        fill(ctx, outlinePath(strokeOutline(live.width, live.usePressure, live.points)), live.color)
      } catch {
        // the stroke in progress is skipped for this frame
      }
    }
  } finally {
    ctx.restore()
  }
}
