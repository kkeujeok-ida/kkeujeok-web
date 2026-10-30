import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { SNAP_RADIUS, applyDock, centerOf, dockRect, dockAtPointer, ratioOf, revealShift } from '../src/ui/library/toolbarDock'

const win = { w: 1000, h: 800 }
const size = { w: 400, h: 40 }

describe('toolbar dock geometry', () => {
  test('outlines: left/right use the vertical shape', () => {
    expect(dockRect('top', size, win)).toEqual({ left: 300, top: 12, right: 700, bottom: 52 })
    expect(dockRect('left', size, win)).toEqual({ left: 12, top: 200, right: 52, bottom: 600 })
    expect(dockRect('right', size, win)).toEqual({ left: 948, top: 200, right: 988, bottom: 600 })
    expect(dockRect('bottom', size, win)).toEqual({ left: 300, top: 748, right: 700, bottom: 788 })
  })

  test('the snap boundary is 48 from the outline rect', () => {
    const at = (d: number) => dockAtPointer({ x: 500, y: 52 + d }, size, win)
    expect(SNAP_RADIUS).toBe(48)
    expect(at(47.9)).toBe('top')
    expect(at(48)).toBe('top')
    expect(at(48.1)).toBeNull()
  })

  test('shared cases test/toolbar.snap.json', () => {
    const { cases } = JSON.parse(readFileSync(new URL('../../test/toolbar.snap.json', import.meta.url), 'utf8'))
    for (const c of cases) expect(dockAtPointer(c.input.pointer, c.input.bar, c.input.win), c.name).toBe(c.expected)
  })

  test('applyDock decides vertical', () => {
    const p = { dock: 'float' as const, x: 0.3, y: 0.3, vertical: false }
    expect(applyDock(p, 'left').vertical).toBe(true)
    expect(applyDock(p, 'right').vertical).toBe(true)
    expect(applyDock(p, 'top').vertical).toBe(false)
    expect(applyDock(p, 'bottom').vertical).toBe(false)
  })

  test('float centre is pulled into the window for display; the stored ratio is untouched', () => {
    const pos = { dock: 'float' as const, x: 0.95, y: 0.5, vertical: false }
    expect(centerOf(pos, size, win)).toEqual({ x: 800, y: 400 })
    expect(centerOf(pos, size, { w: 600, h: 800 })).toEqual({ x: 400, y: 400 })
    expect(pos.x).toBe(0.95)
    expect(ratioOf({ x: 250, y: 200 }, win)).toEqual({ x: 0.25, y: 0.25 })
  })

  test('revealShift is the smallest move that clears the bar inside the area', () => {
    const bar = { left: 300, top: 12, right: 700, bottom: 52 }
    const area = { left: 0, top: 0, right: 1000, bottom: 800 }
    expect(revealShift({ left: 400, top: 100, right: 500, bottom: 140 }, bar, area)).toBeNull()
    expect(revealShift({ left: 400, top: 30, right: 500, bottom: 70 }, bar, area)).toEqual({ x: 0, y: 22 })
    expect(revealShift({ left: 290, top: 30, right: 500, bottom: 70 }, bar, { ...area, bottom: 70 })).toEqual({ x: -200, y: 0 })
  })
})
