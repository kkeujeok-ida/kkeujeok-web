// Answer tape (spec/pen-kinds.md): which tape a press lands on, the tap rule, and the whole-tape erase.
import { describe, expect, test } from 'vitest'
import type { Page } from '../src/model/note'
import { isTapeTap, tapeAt } from '../src/model/tapeHit'
import { EraseScan, erasePieces, erasedElements, eraseTargets } from '../src/ops/ops'

const tape = (id: string, y: number, width = 20) => ({ id, type: 'stroke', tool: 'tape', color: '#FFEB3B', width, usePressure: false, points: [[10, y, 0.5, 0], [100, y, 0.5, 10]] })
const pen = { id: 'p', type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: [[10, 50, 0.5, 0], [100, 50, 0.5, 10]] }
const page = (els: unknown[]) => ({ id: 'pg', width: 200, height: 200, background: 'plain', elements: els }) as unknown as Page

describe('tapeAt', () => {
  test('inside the band; outside; one point is a square; not a tape', () => {
    const els = [tape('a', 50)] as never[]
    expect(tapeAt(els, [50, 55])).toBe('a')
    expect(tapeAt(els, [50, 61])).toBeNull()
    expect(tapeAt([{ ...tape('b', 50), points: [[10, 50, 0.5, 0]] }] as never[], [19, 59])).toBe('b')
    expect(tapeAt([pen] as never[], [50, 50])).toBeNull()
  })
  test('the topmost (later) tape wins', () => {
    expect(tapeAt([tape('low', 50), tape('high', 52)] as never[], [50, 51])).toBe('high')
  })
})

describe('isTapeTap', () => {
  test('under 400 ms and under 6 px', () => {
    expect(isTapeTap(399, 5.9)).toBe(true)
    expect(isTapeTap(400, 0)).toBe(false)
    expect(isTapeTap(100, 6)).toBe(false)
  })
})

describe('eraser and tape', () => {
  const pg = page([tape('a', 50), pen])
  // The path is 8 away from the center line: outside the pen's reach, inside the band (20 / 2 + r).
  const path = [[50, 58]]
  test('touches the band, removes it whole even in partial mode', () => {
    const hits = erasePieces(pg, path, 2)
    expect(hits).toEqual([{ index: 0, pieces: [] }])
    expect(erasedElements(pg, hits, true, () => 'x').map((e) => (e as { id: string }).id)).toEqual(['p'])
  })
  test('preview and scan agree: faded whole, no pieces', () => {
    for (const partial of [false, true]) {
      const t = eraseTargets(pg, path, 2, partial)
      expect([...t.fadeIds]).toEqual(['a'])
      expect(t.elements).toHaveLength(2)
      const sc = new EraseScan(pg, 2, partial)
      sc.push(path[0]!)
      expect(sc.targets()).toEqual(t)
    }
  })
  test('too far from the band touches nothing', () => {
    expect(erasePieces(pg, [[50, 70]], 2)).toEqual([])
  })
})
