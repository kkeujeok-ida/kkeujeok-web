// Story 28.3: while the pen is down, the kept part of a stroke does not change between frames (stroke.liveFreeze).
import { describe, expect, test } from 'vitest'
import type { Stroke } from '../src/model/note'
import { LiveCache } from '../src/render/pagePainter'
import { pencilStampsV2 } from '../src/render/pencilTexture'
import { getSmooth, setSmooth } from '../src/storage/smooth'
import { strokeOutlineFor } from '../src/render/strokeOutline'
import { highlighterOutline } from '../src/render/highlighterOutline'
import { smoothPoints } from '../src/model/smooth'

class FakePath {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  closePath() {}
  addPath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath

const pts = (n: number) => Array.from({ length: n }, (_, i) => [10 + i * 4.1, 10 + (i % 2 ? 1.3 : 0), 0.5, i * 20])
const curvy = () => Array.from({ length: 70 }, (_, i) => [10 + i * 3, 40 + 15 * Math.sin(i / 6), 0.3 + (0.5 * (i % 7)) / 7, i * 10])
const mk = (tool: string, points: number[][], brush?: unknown): Stroke =>
  ({ id: 'live-1', type: 'stroke', tool, color: '#000000', width: tool === 'pencil' ? 3 : 2, usePressure: true, points, ...(brush ? { brush } : {}) }) as unknown as Stroke

describe('live freeze', () => {
  test('stamps: the list for n points is the front of the list for n + m; resuming a walk matches', () => {
    const o = { id: 'live-1', width: 3, usePressure: true, live: true }
    const a = pencilStampsV2({ ...o, points: pts(20) })
    const b = pencilStampsV2({ ...o, points: pts(30) })
    expect(b.length).toBeGreaterThan(a.length)
    expect(b.slice(0, a.length)).toEqual(a)
    const c = new LiveCache()
    const first = [...c.stampsOf(mk('pencil', pts(20)))]
    expect(first).toEqual(a)
    expect(c.stampsOf(mk('pencil', pts(30)))).toEqual(b)
  })

  test('pen outline: closed pieces do not change when points are appended', () => {
    for (const tool of ['pen', 'fountain', 'highlighter', 'tape']) {
      const c = new LiveCache()
      c.pathOf(mk(tool, pts(40)))
      const before = [...c.polygons]
      expect(before.length, tool).toBeGreaterThan(0)
      c.pathOf(mk(tool, pts(41)))
      c.pathOf(mk(tool, pts(60)))
      expect(c.polygons.slice(0, before.length), tool).toEqual(before)
      expect(c.polygons.length, tool).toBeGreaterThan(before.length)
    }
  })

  test('density changes the steps only, opacity the alpha only', () => {
    const o = { id: 'live-1', width: 3, usePressure: true, points: pts(20) }
    const base = pencilStampsV2(o)
    const dense = pencilStampsV2({ ...o, density: 0.2 })
    expect(dense.length).toBeLessThan(base.length)
    expect(dense[0]!.alpha).toBe(base[0]!.alpha)
    const half = pencilStampsV2({ ...o, opacityFactor: 0.5 })
    expect(half).toHaveLength(base.length)
    half.forEach((h, i) => {
      expect(h.x).toBe(base[i]!.x)
      expect(Math.abs(h.alpha - base[i]!.alpha / 2)).toBeLessThan(1e-3)
    })
  })

  // Nonzero winding of (x, y) in any of the polygons.
  const inside = (polys: number[][][], x: number, y: number) =>
    polys.some((poly) => {
      let w = 0
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length]!
        if (a[1]! <= y ? b[1]! > y && (b[0]! - a[0]!) * (y - a[1]!) - (x - a[0]!) * (b[1]! - a[1]!) > 0 : b[1]! <= y && (b[0]! - a[0]!) * (y - a[1]!) - (x - a[0]!) * (b[1]! - a[1]!) < 0) w += a[1]! <= y ? 1 : -1
      })
      return w !== 0
    })
  const edgeDist = (polys: number[][][], x: number, y: number) => {
    let best = Infinity
    for (const poly of polys)
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length]!
        const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, l2 = dx * dx + dy * dy
        const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - a[0]!) * dx + (y - a[1]!) * dy) / l2))
        best = Math.min(best, Math.hypot(x - a[0]! - t * dx, y - a[1]! - t * dy))
      })
    return best
  }

  test('live shape (kept pieces + open piece) equals the pen-up shape within 0.5 px', () => {
    for (const level of [0, 4]) {
      setSmooth(level)
      for (const tool of ['pen', 'fountain', 'highlighter']) {
        const s = mk(tool, curvy())
        const c = new LiveCache()
        c.pathOf(s)
        expect(c.polygons.length).toBeGreaterThan(0)
        const live = [...c.polygons, ...c.openPolygons]
        const sm = smoothPoints(s.points, getSmooth())
        const done = tool === 'highlighter' ? highlighterOutline(s.width, sm) : [strokeOutlineFor(tool, s.width, true, sm)]
        let worst = 0
        for (let x = 0; x < 240; x += 0.5) {
          for (let y = 15; y < 70; y += 0.5) {
            if (inside(live, x, y) !== inside(done, x, y)) worst = Math.max(worst, edgeDist(done, x, y))
          }
        }
        expect(worst, `${tool} smooth ${level}`).toBeLessThanOrEqual(0.5)
      }
    }
    setSmooth(0)
  })

  test('clear forgets the stroke', () => {
    const c = new LiveCache()
    c.pathOf(mk('pen', pts(40)))
    c.clear()
    expect(c.polygons).toHaveLength(0)
  })
})
