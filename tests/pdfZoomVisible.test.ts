import { expect, test } from 'vitest'
import type { Page } from '../src/model/note'
import { StrokePathCache, paintPage } from '../src/render/pagePainter'

// Epic 9 device check: zoomed in, the sharp PDF tile must be asked for the part of the page on screen at the device
// scale. The painter's transform already holds the page scale, so it must not be read as the device ratio.
test('a zoomed PDF page asks for the visible part at scale x devicePixelRatio', () => {
  const asset = 'a'.repeat(64)
  const page = { id: 'p', width: 600, height: 800, background: { type: 'pdf', asset, page: 0, box: [0, 0, 600, 800], rotate: 0, userUnit: 1 }, rev: 'r', seq: 0, editedAt: '', editedBy: '', elements: [] } as unknown as Page
  const dpr = 2, scale = 3
  let m = [1, 0, 0, 1, 0, 0] // a, d, e, f of the current transform; save/restore is not needed here
  const ctx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'getTransform') return () => ({ a: m[0] })
      if (k === 'canvas') return { width: 1000 * dpr, height: 800 * dpr }
      return () => undefined
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D
  m = [dpr * scale, 0, 0, 0, 0, 0]
  const seen: { vis: { x0: number; y0: number; x1: number; y1: number }; scale: number }[] = []
  const images = {
    bitmap: () => null, state: () => 'ready', pending: () => false, labels: { downloading: '', failed: '', broken: '' },
    pdf: { labels: { downloading: '', failed: '' }, state: () => 'ready', retry() {}, paint: (_c: unknown, _p: unknown, vis: never, s: number) => void seen.push({ vis, scale: s }) },
  }
  paintPage(ctx, page, { scale, offsetX: -300, offsetY: 0 }, new StrokePathCache(), null, null, images as never)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.scale).toBe(scale * dpr)
  expect(seen[0]!.vis.x0).toBeCloseTo(100)
  expect(seen[0]!.vis.x1).toBeCloseTo(100 + 1000 / scale)
})
