import { describe, expect, test } from 'vitest'
import type { Page, Stroke } from '../src/model/note'
import { highlighterOutline, windAlike } from '../src/render/highlighterOutline'
import { StrokePathCache, paintPage } from '../src/render/pagePainter'

class FakePath {
  subpaths: number[][][] = []
  moveTo(x: number, y: number) {
    this.subpaths.push([[x, y]])
  }
  lineTo(x: number, y: number) {
    this.subpaths[this.subpaths.length - 1]!.push([x, y])
  }
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath

const signed = (r: readonly (readonly number[])[]) => r.reduce((a, p, i) => a + p[0]! * r[(i + 1) % r.length]![1]! - r[(i + 1) % r.length]![0]! * p[1]!, 0)

const stroke = (id: string, tool: 'pen' | 'highlighter', points: number[][]): Stroke => ({
  id, type: 'stroke', tool, color: '#ffe066', width: 14, usePressure: false, points,
})
const page = (...elements: Stroke[]): Page => ({ id: 'p', width: 200, height: 200, background: 'plain', rev: 'r', seq: 0, editedAt: '', editedBy: '', elements })

// Records the calls that matter to the compositing rules.
function recorder() {
  const log: string[] = []
  const state = { alpha: 1, op: 'source-over' }
  const ctx = new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' ? (...a: unknown[]) => {
      if (k === 'restore') Object.assign(state, { alpha: 1, op: 'source-over' }) // only the highlighter nests a save
      log.push(k === 'fill' ? `fill:${state.alpha}:${state.op}:${(a[0] as FakePath).subpaths.length}` : k)
    } : undefined),
    set: (_t, k, v) => {
      if (k === 'globalAlpha') { state.alpha = v; log.push(`alpha=${v}`) }
      if (k === 'globalCompositeOperation') { state.op = v; log.push(`op=${v}`) }
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log }
}
const vp = { scale: 1, offsetX: 0, offsetY: 0 }

describe('highlighter painting', () => {
  test('one stroke = one fill with 0.4 multiply, set between save and restore', () => {
    const { ctx, log } = recorder()
    const pts = [[10, 10, 0.5, 0], [60, 10, 0.5, 1], [60, 60, 0.5, 2], [10, 10, 0.5, 3]]
    paintPage(ctx, page(stroke('h', 'highlighter', pts)), vp, new StrokePathCache())
    const fills = log.filter((l) => l.startsWith('fill:'))
    expect(fills).toEqual(['fill:0.4:multiply:3']) // 3 rectangles, one fill
    const i = log.indexOf('fill:0.4:multiply:3')
    expect(log.lastIndexOf('save', i)).toBeGreaterThan(log.lastIndexOf('restore', i))
    expect(log.indexOf('restore', i)).toBeGreaterThan(i)
  })

  test('a pen stroke is drawn opaque and normal; two highlighter strokes are two layers', () => {
    const { ctx, log } = recorder()
    const pts = [[10, 10, 0.5, 0], [60, 10, 0.5, 1]]
    paintPage(ctx, page(stroke('a', 'highlighter', pts), stroke('b', 'highlighter', pts), stroke('c', 'pen', pts)), vp, new StrokePathCache())
    const fills = log.filter((l) => l.startsWith('fill:'))
    expect(fills.slice(0, 2)).toEqual(['fill:0.4:multiply:1', 'fill:0.4:multiply:1'])
    expect(fills[2]).toMatch(/^fill:1:source-over:/)
  })

  test('a stroke without points draws nothing; the cache key includes the tool', () => {
    expect(highlighterOutline(14, [])).toEqual([])
    const cache = new StrokePathCache()
    const pts = [[10, 10, 0.5, 0], [60, 10, 0.5, 1]]
    const a = cache.pathOf(stroke('same', 'pen', pts))
    const b = cache.pathOf(stroke('same', 'highlighter', pts))
    expect(b).not.toBe(a)
    expect((b as unknown as FakePath).subpaths).toHaveLength(1) // 1 rectangle
  })

  test('rectangles are wound alike, also on an L and a line doubling back', () => {
    for (const pts of [[[10, 10], [60, 10], [60, 60]], [[10, 10], [60, 10], [10, 10]], [[60, 60], [10, 60], [10, 10], [60, 10]]]) {
      const rects = highlighterOutline(14, pts)
      const wound = windAlike(rects)
      expect(wound).toHaveLength(rects.length)
      for (const r of wound) expect(signed(r)).toBeGreaterThan(0)
    }
    // the same rectangle set, only reordered corners
    const rects = highlighterOutline(14, [[10, 10], [60, 10], [10, 10]])
    expect(windAlike(rects).map((r) => [...r].sort())).toEqual(rects.map((r) => [...r].sort()))
  })
})
