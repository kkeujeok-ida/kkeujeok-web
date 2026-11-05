// Story 9.5: the PDF ground of a page (spec pdf.md `pdf.pageDisplay`). pdf.js draws a page of the stored PDF into a
// canvas; its visible area (CropBox ∩ MediaBox, /Rotate applied) is stretched to the stored width x height, which is
// what `pdf.pageMatrix` says. Every page seen has a low-resolution whole-page canvas; a zoomed view adds one sharp tile
// of the visible part, asked for only once the zoom has been still. Both live in a byte-bounded LRU. Port of the
// Android lib/render/pdf_pages.dart.
import { type PdfJs, browserPdfjs } from '../model/pdfParse'
import type { AssetState } from '../model/imageRules'
import { isPdfBackground, pdfPageDisplay } from '../model/pdfRules'
import type { AssetStore } from '../storage/assetStore'
import type { AssetSync } from '../sync/assetSync'

export type PdfRect = { x0: number; y0: number; x1: number; y1: number }
type Size = { bw: number; bh: number; sx: number; sy: number; fw: number; fh: number }

/** Pixels to render for `rect` (page pt, null = the whole page) at `scale` px/pt: bitmap size, offset and the full-page size. */
export function pdfRenderSize(pageW: number, pageH: number, rect: PdfRect | null, scale: number): Size {
  const fw = Math.max(1, Math.round(pageW * scale))
  const fh = Math.max(1, Math.round(pageH * scale))
  if (!rect) return { bw: fw, bh: fh, sx: 0, sy: 0, fw, fh }
  return { bw: Math.max(1, Math.round((rect.x1 - rect.x0) * scale)), bh: Math.max(1, Math.round((rect.y1 - rect.y0) * scale)), sx: -Math.round(rect.x0 * scale), sy: -Math.round(rect.y0 * scale), fw, fh }
}

/** A map that drops its oldest entries past `budget` bytes, except those touched within `keepMs` (they are on screen). */
export class ByteLru<V extends { bytes: number }> {
  private m = new Map<string, { v: V; at: number }>()
  total = 0
  constructor(private budget: number, private onEvict: (v: V) => void, private now: () => number = Date.now, private keepMs = 500) {}
  get(key: string): V | undefined {
    const e = this.m.get(key)
    if (!e) return undefined
    this.m.delete(key)
    e.at = this.now()
    this.m.set(key, e)
    return e.v
  }
  put(key: string, v: V): void {
    this.drop(key)
    this.m.set(key, { v, at: this.now() })
    this.total += v.bytes
    const recent = this.now() - this.keepMs
    for (const [k, e] of this.m) {
      if (this.total <= this.budget || this.m.size <= 1) break
      if (e.at >= recent) continue
      this.drop(k)
    }
  }
  drop(key: string): void {
    const e = this.m.get(key)
    if (!e) return
    this.m.delete(key)
    this.total -= e.v.bytes
    this.onEvict(e.v)
  }
  clear(): void {
    for (const k of [...this.m.keys()]) this.drop(k)
  }
  get size() {
    return this.m.size
  }
}

type Entry = { canvas: HTMLCanvasElement; rect: PdfRect | null; scale: number; bytes: number }
type Job = { key: string; hash: string; index: number; w: number; h: number; rect: PdfRect | null; scale: number; at: number }

const BASE_SIDE = 768 // px, long side of the whole-page canvas
const TILE_SIDE = 3072 // px, long side cap of a sharp tile
const BUDGET = 160 * 1024 * 1024
const STALE_MS = 3000
const STILL_MS = 200

/** What the page painter needs: paints the PDF ground (or its placeholder) of `page` under the elements. */
export type PdfLayer = {
  labels: { downloading: string; failed: string }
  /** `visible`: the part of the page on screen (page pt); `scale`: device px per pt. */
  paint(ctx: CanvasRenderingContext2D, page: { width: number; height: number; background?: unknown }, visible: PdfRect, scale: number): void
  state(page: { background?: unknown }): AssetState | null
  retry(asset: string): void
}

export function createPdfPages(d: { store: AssetStore; sync: AssetSync; changed: () => void; load?: () => Promise<PdfJs> }) {
  const load = d.load ?? browserPdfjs
  const docs = new Map<string, Promise<Awaited<ReturnType<PdfJs['getDocument']>['promise']> | null>>()
  const broken = new Set<string>()
  const lru = new ByteLru<Entry>(BUDGET, (e) => ((e.canvas.width = 0), (e.canvas.height = 0)))
  const queue = new Map<string, Job>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inflight = new Set<string>()
  let running = false

  const openDoc = (hash: string) => {
    let p = docs.get(hash)
    if (!p) {
      p = (async () => {
        try {
          const rec = await d.store.get(hash)
          if (!rec) return null
          const lib = await load()
          return await lib.getDocument({ data: rec.bytes.slice(), verbosity: 0 }).promise
        } catch {
          return null
        }
      })()
      docs.set(hash, p)
    }
    return p
  }

  async function run(job: Job) {
    if (Date.now() - job.at > STALE_MS) return // it left the screen long ago; asked again when it returns
    const doc = await openDoc(job.hash)
    let canvas: HTMLCanvasElement | null = null
    try {
      if (!doc) throw new Error('no document')
      const page = await doc.getPage(job.index + 1)
      const s = pdfRenderSize(job.w, job.h, job.rect, job.scale)
      const v1 = page.getViewport({ scale: 1 })
      const kx = s.fw / v1.width
      const ky = s.fh / v1.height
      canvas = document.createElement('canvas')
      canvas.width = s.bw
      canvas.height = s.bh
      await page.render({ canvas, viewport: page.getViewport({ scale: kx }), transform: [1, 0, 0, ky / kx, s.sx, s.sy] }).promise
      page.cleanup()
      lru.put(job.key, { canvas, rect: job.rect, scale: job.scale, bytes: s.bw * s.bh * 4 })
    } catch {
      if (canvas) canvas.width = canvas.height = 0
      // Only a failed whole-page render says the PDF is unreadable; a failed sharp tile is dropped and the base stays.
      if (!job.rect) broken.add(job.hash)
    }
    d.changed()
  }

  async function pump() {
    running = true
    try {
      while (queue.size > 0) {
        const key = [...queue.keys()].pop()!
        const job = queue.get(key)!
        queue.delete(key)
        inflight.add(key)
        try {
          await run(job)
        } finally {
          inflight.delete(key)
        }
      }
    } finally {
      running = false
    }
  }

  function enqueue(job: Job) {
    if (broken.has(job.hash) || !d.sync.local().has(job.hash) || inflight.has(job.key)) return
    queue.delete(job.key)
    queue.set(job.key, job) // newest last: what is on screen now goes first
    if (!running) void pump()
  }

  const stateOf = (page: { background?: unknown }): AssetState | null => {
    const disp = pdfPageDisplay({ page, local: [...d.sync.local()], failed: [...d.sync.failed()] })
    if (disp.layer !== 'pdf') return null
    return disp.state === 'ready' && broken.has((page.background as { asset: string }).asset) ? 'failed' : (disp.state as AssetState)
  }

  const layer: PdfLayer = {
    labels: { downloading: '', failed: '' },
    state: stateOf,
    retry(asset) {
      broken.delete(asset)
      docs.delete(asset)
      d.changed()
    },
    paint(ctx, page, visible, scale) {
      const bg = page.background
      if (!isPdfBackground(bg)) return
      const { width: w, height: h } = page
      const disp = pdfPageDisplay({ page, local: [...d.sync.local()], failed: [...d.sync.failed()] })
      const state = stateOf(page)
      ctx.save()
      try {
        if (state === 'ready') {
          const key = `${bg.asset}:${bg.page}`
          const job = (rect: PdfRect | null, s: number, k: string): Job => ({ key: k, hash: bg.asset, index: bg.page, w, h, rect, scale: s, at: Date.now() })
          // All Dark never inverts a PDF page (`invertPdf` is false); a theme that asks for it is Epic 10's.
          if ('invertPdf' in disp && disp.invertPdf) ctx.filter = 'invert(1)'
          const base = lru.get(key)
          if (base) ctx.drawImage(base.canvas, 0, 0, w, h)
          else enqueue(job(null, BASE_SIDE / Math.max(w, h), key))
          if (scale > (BASE_SIDE / Math.max(w, h)) * 1.1) {
            const tk = `${key}:t`
            const t = lru.get(tk)
            const r = t?.rect
            const covers = !!t && !!r && r.x0 - 0.5 <= visible.x0 && r.y0 - 0.5 <= visible.y0 && r.x1 + 0.5 >= visible.x1 && r.y1 + 0.5 >= visible.y1
            if (covers && t.scale >= Math.min(scale, TILE_SIDE / Math.max(r.x1 - r.x0, r.y1 - r.y0)) * 0.9) clearTimeout(timers.get(tk))
            else {
              const grow = Math.max(visible.x1 - visible.x0, visible.y1 - visible.y0) * 0.25
              const area = { x0: Math.max(0, visible.x0 - grow), y0: Math.max(0, visible.y0 - grow), x1: Math.min(w, visible.x1 + grow), y1: Math.min(h, visible.y1 + grow) }
              const j = job(area, Math.min(scale, TILE_SIDE / Math.max(area.x1 - area.x0, area.y1 - area.y0)), tk)
              clearTimeout(timers.get(tk))
              timers.set(tk, setTimeout(() => (timers.delete(tk), enqueue(j)), STILL_MS))
            }
            if (t && r) ctx.drawImage(t.canvas, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
          }
          return
        }
        ctx.fillStyle = '#e0e0e0'
        ctx.fillRect(0, 0, w, h)
        const text = state === 'failed' ? layer.labels.failed : layer.labels.downloading
        if (text) {
          ctx.fillStyle = '#555555'
          ctx.font = `400 ${Math.max(12, w / 25)}px Pretendard, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(text, w / 2, h / 2, Math.max(1, w - 8))
        }
      } finally {
        ctx.restore()
      }
    },
  }

  return {
    layer,
    dispose() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      queue.clear()
      lru.clear()
      for (const p of docs.values()) void p.then((x) => x?.loadingTask.destroy())
      docs.clear()
    },
  }
}
