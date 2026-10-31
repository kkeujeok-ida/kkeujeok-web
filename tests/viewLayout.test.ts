import { describe, expect, test } from 'vitest'
import { fitHeightViewport } from '../src/render/pagePainter'
import { PAGE_GAP, layoutSlots } from '../src/render/viewLayout'

const P = { width: 100, height: 200 } // portrait
const L = { width: 200, height: 100 } // landscape
const units = (pages: { width: number; height: number }[]) => layoutSlots(pages, 'twoPage').units.map((u) => (u.first === u.last ? [u.first] : [u.first, u.last]))

describe('layoutSlots', () => {
  test('vertical: stacked, centered across, PAGE_GAP apart', () => {
    const d = layoutSlots([P, L, P], 'vertical')
    expect(d.list.map((s) => [s.x, s.y])).toEqual([
      [50, 0],
      [0, 200 + PAGE_GAP],
      [50, 300 + 2 * PAGE_GAP],
    ])
    expect([d.w, d.h]).toEqual([200, 500 + 2 * PAGE_GAP])
    expect(d.units.map((u) => [u.first, u.last])).toEqual([[0, 0], [1, 1], [2, 2]])
  })

  test('horizontal: left to right, PAGE_GAP apart, centered in the tallest height', () => {
    const d = layoutSlots([P, L, P], 'horizontal')
    expect(d.list.map((s) => [s.x, s.y])).toEqual([
      [0, 0],
      [100 + PAGE_GAP, 50],
      [300 + 2 * PAGE_GAP, 0],
    ])
    expect([d.w, d.h]).toEqual([400 + 2 * PAGE_GAP, 200])
  })

  test('two pages: portrait pairs, 3 gaps between pairs, one gap inside', () => {
    const d = layoutSlots([P, P, P, P, P, P], 'twoPage')
    expect(units([P, P, P, P, P, P])).toEqual([[0, 1], [2, 3], [4, 5]])
    expect(d.list[1]).toMatchObject({ x: 100 + PAGE_GAP, y: 0, unit: 0 })
    expect(d.list[2]!.x).toBe(200 + PAGE_GAP + 3 * PAGE_GAP)
    expect(d.units[0]).toEqual({ first: 0, last: 1, x: 0, y: 0, w: 200 + PAGE_GAP, h: 200 })
    expect(d.w).toBe(3 * (200 + PAGE_GAP) + 2 * 3 * PAGE_GAP)
  })

  test('an odd last page is alone; a landscape page is always alone, and so is the portrait before it', () => {
    expect(units([P, P, P])).toEqual([[0, 1], [2]])
    expect(units([P, P, L, P, P])).toEqual([[0, 1], [2], [3, 4]])
    expect(units([P, L])).toEqual([[0], [1]])
    expect(units([L, L, P, P])).toEqual([[0], [1], [2, 3]])
  })

  test('mixed sizes keep their own size and are centered vertically inside a unit', () => {
    const small = { width: 100, height: 100 }
    const d = layoutSlots([P, small], 'twoPage')
    expect(d.list.map((s) => [s.x, s.y])).toEqual([
      [0, 0],
      [100 + PAGE_GAP, 50],
    ])
  })

  test('one page, and none', () => {
    expect(layoutSlots([P], 'twoPage')).toMatchObject({ w: 100, h: 200, units: [{ first: 0, last: 0 }] })
    expect(layoutSlots([P], 'horizontal').list).toEqual([{ index: 0, unit: 0, x: 0, y: 0 }])
    expect(layoutSlots([], 'vertical')).toEqual({ list: [], units: [], w: 0, h: 0 })
  })
})

describe('fitHeightViewport', () => {
  test('the height of the padded area, starting at the left edge', () => {
    const v = fitHeightViewport(800, 600, 400, 200, { gap: 10, extraBottom: 20 })
    expect(v.scale).toBeCloseTo(560 / 200)
    expect(v.offsetX).toBe(0)
  })
})
