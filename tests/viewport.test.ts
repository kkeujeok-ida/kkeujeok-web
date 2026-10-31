import { describe, expect, test } from 'vitest'
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampViewport,
  fitPageViewport,
  fitWidthViewport,
  scrollMetrics,
  toPage,
  zoomAbout,
} from '../src/render/pagePainter'

const ins = { gap: 12, extraBottom: 60 }
// An 800 x 600 area and a 595 x 842 page.
const W = 800
const H = 600
const PW = 595
const PH = 842

describe('viewport math', () => {
  test('width fit: full width (no side margin), top aligned, clamped into 50-400%', () => {
    const v = fitWidthViewport(W, H, PW, PH, ins)
    expect(v.scale).toBeCloseTo(800 / 595, 6)
    expect(v.offsetX).toBeCloseTo(0, 6)
    expect(v.offsetY).toBe(12)
    expect(fitWidthViewport(100, H, 1000, 1000, ins).scale).toBe(ZOOM_MIN)
    expect(fitWidthViewport(5000, H, 100, 100, ins).scale).toBe(ZOOM_MAX)
  })

  test('page fit: whole page, centered in the area above the toolbar room', () => {
    const v = fitPageViewport(W, H, PW, PH, ins)
    const s = Math.min(800 / PW, (600 - 24 - 60) / PH)
    expect(v.scale).toBeCloseTo(s, 6)
    expect(v.offsetX).toBeCloseTo((800 - PW * s) / 2, 6)
    expect(v.offsetY).toBeCloseTo(12 + (516 - PH * s) / 2, 6)
  })

  test('clamp: small axes center, large axes stop at the gap and above the toolbar room', () => {
    const c = clampViewport({ scale: 2, offsetX: 500, offsetY: 500 }, W, H, PW, PH, ins)
    expect(c.offsetX).toBe(0) // 1190 wide > 800: the left edge is at most at the view edge
    expect(c.offsetY).toBe(12)
    const far = clampViewport({ scale: 2, offsetX: -9999, offsetY: -9999 }, W, H, PW, PH, ins)
    expect(far.offsetX).toBe(800 - PW * 2)
    expect(far.offsetY).toBe(12 + 516 - PH * 2)
    const small = clampViewport({ scale: 0.5, offsetX: 0, offsetY: 0 }, W, H, PW, PH, ins)
    expect(small.offsetX).toBeCloseTo((800 - PW * 0.5) / 2, 6)
    expect(small.offsetY).toBeCloseTo(12 + (516 - PH * 0.5) / 2, 6)
  })

  test('an unusable area changes nothing', () => {
    const v = { scale: 1, offsetX: 3, offsetY: 4 }
    expect(clampViewport(v, 0, 0, PW, PH, ins)).toBe(v)
    expect(fitWidthViewport(0, 0, PW, PH, ins)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 })
  })

  test('zoomAbout keeps the page point under the focus and cuts the scale', () => {
    const v = { scale: 1.2, offsetX: 30, offsetY: -20 }
    const [px, py] = toPage(v, 300, 200)
    const [qx, qy] = toPage(zoomAbout(v, 300, 200, 2.4), 300, 200)
    expect(qx).toBeCloseTo(px, 9)
    expect(qy).toBeCloseTo(py, 9)
    expect(zoomAbout(v, 0, 0, 99).scale).toBe(ZOOM_MAX)
    expect(zoomAbout(v, 0, 0, 0.01).scale).toBe(ZOOM_MIN)
  })

  test('scroll metrics: none when the page fits, thumbs reach the track ends', () => {
    const fit = fitPageViewport(W, H, PW, PH, ins)
    expect(scrollMetrics(fit, W, H, PW, PH, ins)).toEqual({ x: null, y: null })
    const top = scrollMetrics({ scale: 2, offsetX: 0, offsetY: 12 }, W, H, PW, PH, ins)
    expect(top.y!.start).toBe(0)
    expect(top.x!.start).toBe(0)
    const end = scrollMetrics({ scale: 2, offsetX: 800 - PW * 2, offsetY: 12 + 516 - PH * 2 }, W, H, PW, PH, ins)
    expect(end.y!.start + end.y!.size).toBeCloseTo(1, 9)
    expect(end.x!.start + end.x!.size).toBeCloseTo(1, 9)
  })
})
