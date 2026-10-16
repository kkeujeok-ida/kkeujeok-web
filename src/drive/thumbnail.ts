// The first page as a PNG of `width` x `height` pixels with its background and
// every element (spec drive-layout "Library list summary"), drawn by the writing
// screen's renderer. Null when it cannot be drawn: no canvas, no 2D context, a
// failed encode. Never throws.
import type { Page } from '../model/note'
import { StrokePathCache, paintPage } from '../render/pagePainter'

type Surface = { ctx: CanvasRenderingContext2D; toPng: () => Promise<Uint8Array | null> }

function surface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(width, height)
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | null
    if (!ctx) return null
    return {
      ctx,
      toPng: async () => new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()),
    }
  }
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const ctx = c.getContext('2d')
  if (!ctx) return null
  return {
    ctx,
    toPng: () =>
      new Promise((resolve) =>
        c.toBlob((b) => (b ? void b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), () => resolve(null)) : resolve(null)), 'image/png'),
      ),
  }
}

export async function renderThumbnail(page: Page, width: number, height: number): Promise<Uint8Array | null> {
  try {
    const s = surface(width, height)
    if (!s || !(page.width > 0)) return null
    const scale = width / page.width
    paintPage(s.ctx, page, { scale, offsetX: 0, offsetY: 0 }, new StrokePathCache())
    return await s.toPng()
  } catch {
    return null
  }
}
