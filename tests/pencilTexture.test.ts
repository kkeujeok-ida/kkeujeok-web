import { describe, expect, test } from 'vitest'
import { PencilTextures, buildPencilCells, pencilDensity, pencilGrain, pencilSeed, type Samples } from '../src/render/pencilTexture'
import { strokeOutlineFor, strokeSamples } from '../src/render/strokeOutline'

const curve = { type: 'normal' } as never
const line = (q: number): number[][] => Array.from({ length: 41 }, (_, k) => [10 + k * 2, 20, q, k])
const cells = (id: string, pts: number[][], w = 6) => {
  const outline = strokeOutlineFor('pencil', w, true, pts, curve)
  return buildPencilCells(outline, strokeSamples(true, pts, curve), pencilSeed(id))!
}
const ratio = (c: ReturnType<typeof cells>) => c.alpha.reduce((a, v) => a + (v ? 1 : 0), 0) / c.alpha.length

describe('pencil cells', () => {
  test('full pressure inks more than light pressure (about 95% vs 35% of the inside)', () => {
    // The box has empty corners only at the round caps, so the ratio sits a little under the density.
    const hi = ratio(cells('a', line(1))), lo = ratio(cells('a', line(0)))
    expect(hi).toBeGreaterThan(0.8)
    expect(hi).toBeLessThan(0.98)
    expect(lo).toBeGreaterThan(0.2)
    expect(lo).toBeLessThan(0.4)
  })

  test('q comes from the nearest sample: a pressure change along the stroke changes the ink', () => {
    const pts = line(0).map((p, k) => (k > 20 ? [p[0]!, p[1]!, 1, p[3]!] : p))
    const c = cells('b', pts, 3)
    const half = (from: number, to: number) => {
      let n = 0, t = 0
      for (let v = 0; v < c.h; v++) for (let u = from; u < to; u++) (t++, c.alpha[v * c.w + u] && n++)
      return n / t
    }
    expect(half(Math.floor(c.w * 0.8), c.w - 2)).toBeGreaterThan(half(2, Math.floor(c.w * 0.2)) + 0.3)
  })

  test('the same id and points give the same cells; a big box returns null', () => {
    expect(cells('c', line(0.5)).alpha).toEqual(cells('c', line(0.5)).alpha)
    const s: Samples = { x: [0], y: [0], q: [1] }
    expect(buildPencilCells([[0, 0], [100, 0], [100, 100]], s, 1, 10)).toBeNull()
  })

  test('fixed values shared with Android', () => {
    expect(pencilSeed('01926f3a-0000-7000-8000-000000000010')).toBe(3567887231)
    expect(pencilGrain(3567887231, 0, 0)).toBe(62345)
    expect(pencilDensity(1).threshold).toBe(Math.floor(0.95 * 65536 + 1e-6))
  })
})

describe('PencilTextures', () => {
  const stroke = (id: string, dx = 0, s = 1) => ({ id, width: 4, usePressure: true, points: line(0.5).map((p) => [p[0]! * s + dx, p[1]! * s + dx, p[2]!, p[3]!]) })
  const make = () => {
    const made: number[] = []
    const t = new PencilTextures(() => (made.push(1), {} as never))
    let ready = 0
    t.onReady = () => ready++
    return { t, made, ready: () => ready }
  }

  test('builds off the call, then a rigid move reuses the image; a big scale rebuilds', async () => {
    const { t, made } = make()
    expect(t.lookup(stroke('m'))).toBeNull()
    await t.settled()
    const d = t.lookup(stroke('m'))!
    expect(d.m).toBeNull()
    expect(t.lookup(stroke('m', 30))!.m).not.toBeNull()
    expect(made).toHaveLength(1)
    expect(t.lookup(stroke('m', 0, 3))).toBeNull() // scale 3 is outside 0.5..2: dropped
    expect(t.lookup(stroke('m', 0, 3))).toBeNull() // the next frame queues the rebuild
    await t.settled()
    expect(made).toHaveLength(2)
    t.dispose()
  })

  test('no onReady (a one-off painter) builds nothing', async () => {
    const t = new PencilTextures(() => ({}) as never)
    expect(t.lookup(stroke('o'))).toBeNull()
    await t.settled()
    expect(t.lookup(stroke('o'))).toBeNull()
  })

  test('eviction does not loop: the evicted stroke is not requeued', async () => {
    const { t, made } = make()
    const old = PencilTextures.maxTotalCells
    PencilTextures.maxTotalCells = 1
    try {
      t.lookup(stroke('e1')); await t.settled()
      t.lookup(stroke('e2')); await t.settled()
      expect(made).toHaveLength(2)
      for (let k = 0; k < 3; k++) { t.lookup(stroke('e1')); await t.settled() }
      expect(made).toHaveLength(2) // e1 was evicted for room, and stays on the polygon until room is freed
    } finally { PencilTextures.maxTotalCells = old; t.dispose() }
  })
})
