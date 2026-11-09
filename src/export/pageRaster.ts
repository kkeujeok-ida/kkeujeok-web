// The flat picture of a page with an answer tape (spec/export.md "Answer tape"): the screen drawing in original colors,
// tapes closed, at 2.5 px/pt, PDF ground and pictures included. PNG bytes, or null when it cannot be drawn.
import type { Page } from '../model/note'
import { isPdfBackground } from '../model/pdfRules'
import { browserPdfjs } from '../model/pdfParse'
import { StrokePathCache, paintPage } from '../render/pagePainter'
import type { ImageSource } from '../render/imagePainter'
import type { AssetSource } from './pdfExport'

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

function surface(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null | undefined
  return canvas && ctx ? { canvas, ctx } : null
}

const toPng = (c: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array | null> =>
  'convertToBlob' in c
    ? c.convertToBlob({ type: 'image/png' }).then(async (b) => new Uint8Array(await b.arrayBuffer()))
    : new Promise((res) => c.toBlob((b) => (b ? void b.arrayBuffer().then((a) => res(new Uint8Array(a)), () => res(null)) : res(null)), 'image/png'))

/** The original PDF page drawn at wPx x hPx, or null (no file): the page then has plain paper. */
async function pdfGround(assets: AssetSource, bg: { asset: string; page: number }, wPx: number, hPx: number): Promise<HTMLCanvasElement | null> {
  const rec = await assets.get(bg.asset)
  if (!rec) return null
  const lib = await browserPdfjs()
  const doc = await lib.getDocument({ data: rec.bytes.slice(), verbosity: 0 }).promise
  try {
    const page = await doc.getPage(bg.page + 1)
    const v1 = page.getViewport({ scale: 1 })
    const kx = wPx / v1.width, ky = hPx / v1.height
    const canvas = Object.assign(document.createElement('canvas'), { width: wPx, height: hPx })
    await page.render({ canvas, viewport: page.getViewport({ scale: kx }), transform: [1, 0, 0, ky / kx, 0, 0] }).promise
    return canvas
  } finally {
    void doc.destroy()
  }
}

export async function renderPageRaster(page: Page, wPx: number, hPx: number, assets: AssetSource): Promise<Uint8Array | null> {
  const cache = new StrokePathCache()
  const owned: ImageBitmap[] = []
  try {
    const s = surface(wPx, hPx)
    if (!s) return null
    const bitmaps = new Map<string, ImageBitmap>()
    for (const e of page.elements as Record<string, any>[]) {
      if (e?.type !== 'image' || typeof e.asset !== 'string' || bitmaps.has(e.asset)) continue
      try {
        const rec = await assets.get(e.asset)
        if (rec) {
          const bmp = await createImageBitmap(new Blob([rec.bytes as BlobPart], { type: MIME[rec.ext] ?? 'image/png' }))
          owned.push(bmp)
          bitmaps.set(e.asset, bmp)
        }
      } catch { /* undecodable: the grey box, as on screen */ }
    }
    let ground: HTMLCanvasElement | null = null
    if (isPdfBackground(page.background)) {
      try { ground = await pdfGround(assets, page.background as { asset: string; page: number }, wPx, hPx) } catch { /* plain paper */ }
    }
    const src: ImageSource = {
      bitmap: (h) => bitmaps.get(h) ?? 'broken',
      state: () => 'ready',
      pending: () => false,
      labels: { downloading: '', failed: '', broken: '' },
      ...(ground && { pdf: { labels: { downloading: '', failed: '' }, state: () => 'ready' as const, retry() {}, paint: (ctx: CanvasRenderingContext2D, p: { width: number; height: number }) => ctx.drawImage(ground!, 0, 0, p.width, p.height) } }),
    }
    const draw = () => {
      s.ctx.fillStyle = '#fff' // opaque, also the sub-pixel edge strip (no alpha plane in the PNG)
      s.ctx.fillRect(0, 0, wPx, hPx)
      paintPage(s.ctx, page, { scale: 2.5, offsetX: 0, offsetY: 0 }, cache, null, null, src, null, false)
    }
    await cache.textures.settled() // the pencil stamp image
    draw()
    if (ground) ground.width = 0
    return await toPng(s.canvas)
  } catch {
    return null
  } finally {
    cache.dispose()
    for (const b of owned) b.close()
  }
}
