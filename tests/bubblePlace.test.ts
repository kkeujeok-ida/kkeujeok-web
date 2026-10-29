import { describe, expect, test } from 'vitest'
import { placeBubble } from '../src/ui/library/bubblePlace'

const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h })
const win = { w: 400, h: 800 }
const size = { w: 320, h: 400 }

describe('placeBubble', () => {
  test('bar in the upper half: below it, tail under the tool', () => {
    const p = placeBubble(box(20, 12, 360, 48), box(100, 12, 48, 48), size, win)
    expect(p.side).toBe('down')
    expect(p.top).toBe(72)
    expect(p.left + p.tail!).toBe(124)
  })
  test('bar in the lower half: above it', () => {
    const p = placeBubble(box(20, 740, 360, 48), box(180, 740, 48, 48), size, win)
    expect(p.side).toBe('up')
    expect(p.top + size.h + 12).toBe(740)
  })
  test('vertical bar: left dock opens right, right dock opens left', () => {
    const wide = { w: 1000, h: 800 }
    const l = placeBubble(box(12, 100, 48, 500), box(12, 300, 48, 48), size, wide)
    expect([l.side, l.left]).toEqual(['right', 72])
    const r = placeBubble(box(940, 100, 48, 500), box(940, 300, 48, 48), size, wide)
    expect([r.side, r.left + size.w + 12]).toEqual(['left', 940])
  })
  test('tool at the edge: the bubble stays inside, the tail still points at the tool', () => {
    const h = placeBubble(box(20, 12, 380, 48), box(352, 12, 48, 48), size, win)
    expect(h.left + size.w).toBeLessThanOrEqual(win.w - 12)
    expect(h.left + h.tail!).toBe(372) // kept 16 off the corner
    const v = placeBubble(box(12, 300, 48, 500), box(12, 760, 48, 48), size, win)
    expect(v.top + size.h).toBeLessThanOrEqual(win.h - 12)
    expect(v.top + v.tail!).toBe(772)
  })
  test('bubble pulled over the bar: no tail', () => {
    const p = placeBubble(box(20, 12, 360, 48), box(100, 12, 48, 48), { w: 320, h: 760 }, win)
    expect(p.tail).toBeNull()
  })
})
