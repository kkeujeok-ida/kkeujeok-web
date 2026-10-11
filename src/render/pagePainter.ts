// Paper, background and strokes of one page onto a 2D canvas context (AD-11).
// The context's own transform is the device pixel ratio; the viewport maps
// page points (pt, top-left origin) into CSS pixels of the canvas.
import { isValidStroke, type Page, type Stroke } from '../model/note'
import { pageBackground } from './pageBackground'
import { outlinePath, strokeOutline } from './strokeOutline'

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
    for (const e of Array.isArray(elements) ? elements : []) {
      try {
        if (!isValidStroke(e)) continue
        ids.add(e.id)
        fill(ctx, cache.pathOf(e), e.color)
      } catch {
        // one bad element must not hide the rest
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
