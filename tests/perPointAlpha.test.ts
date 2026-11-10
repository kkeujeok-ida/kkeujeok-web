// Story 28.7: pen opacity pressure/tilt curves are drawn per point (spec/brush.md "Drawing per-point alpha").
import { describe, expect, test } from 'vitest'
import type { Stroke } from '../src/model/note'
import { brushAlpha, brushAlphaFactor } from '../src/model/brush'
import { LiveCache, alphaPieces, perPointAlpha } from '../src/render/pagePainter'

class FakePath {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  closePath() {}
  addPath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath

const mk = (points: number[][], brush?: unknown, tool = 'pen'): Stroke =>
  ({ id: 's', type: 'stroke', tool, color: '#000000', width: 8, usePressure: true, points, ...(brush ? { brush } : {}) }) as unknown as Stroke
const ramp = (n = 41) => Array.from({ length: n }, (_, i) => [10 + i * 2, 30, 0.1 + (0.8 * i) / 40, i * 10])
const rise = { opacityPressureCurve: [[0, 0.1], [1, 1]] }

describe('per-point alpha', () => {
  test('rule: only pen/fountain with an opacity curve', () => {
    expect(perPointAlpha(mk(ramp(), rise))).toBe(true)
    expect(perPointAlpha(mk(ramp(), rise, 'fountain'))).toBe(true)
    expect(perPointAlpha(mk(ramp(), { tiltTarget: 'opacity' }))).toBe(true) // old field
    expect(perPointAlpha(mk(ramp(), rise, 'highlighter'))).toBe(false)
    expect(perPointAlpha(mk(ramp(), rise, 'tape'))).toBe(false)
    expect(perPointAlpha(mk(ramp(), rise, 'pencil'))).toBe(false)
    expect(perPointAlpha(mk(ramp(), { ...rise, texture: 'pencil' }))).toBe(false)
    expect(perPointAlpha({ ...mk(ramp(), rise), shape: { kind: 'line' } } as never)).toBe(false)
  })

  test('no curve: old path (no pieces drawn per point)', () => {
    expect(perPointAlpha(mk(ramp()))).toBe(false)
    expect(perPointAlpha(mk(ramp(), { opacity: 0.5 }))).toBe(false)
  })

  test('curvesOff: the curve counts as constant 1, in both paths', () => {
    const off = { ...rise, curvesOff: ['opacityPressure'] }
    expect(perPointAlpha(mk(ramp(), off))).toBe(false)
    expect(brushAlphaFactor('highlighter', off, ramp())).toBe(1)
    expect(brushAlphaFactor('highlighter', rise, ramp())).toBeLessThan(1)
    const tilt = { tiltTarget: 'opacity', curvesOff: ['opacityTilt'] }
    expect(perPointAlpha(mk(ramp(), tilt))).toBe(false)
    const pts = ramp().map((p) => [...p, 80, 0])
    expect(brushAlphaFactor('highlighter', { tiltTarget: 'opacity' }, pts)).toBeLessThan(1)
    expect(brushAlphaFactor('highlighter', tilt, pts)).toBe(1)
  })

  test('pressure ramp: piece alphas rise and equal brush.alpha at the ends', () => {
    const pieces = alphaPieces(mk(ramp(), rise), ramp())
    const a = pieces.map((p) => p.alpha)
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeGreaterThanOrEqual(a[i - 1]! - 1e-9)
    const at = (pr: number) => brushAlpha({ opacity: 1, opacityPressureCurve: rise.opacityPressureCurve, pressure: pr })
    expect(a[0]!).toBeCloseTo(at(0.1), 1)
    expect(a[a.length - 1]!).toBeCloseTo(at(0.9), 1)
    expect(a[a.length - 1]!).toBeGreaterThan(a[0]! + 0.5)
  })

  test('tilt ramp: alpha follows the point tilt', () => {
    const pts = Array.from({ length: 41 }, (_, i) => [10 + i * 2, 30, 0.5, i * 10, (90 * i) / 40, 0])
    const a = alphaPieces(mk(pts, { opacityTiltCurve: [[0, 0.1], [1, 1]] }), pts).map((p) => p.alpha)
    expect(a[0]!).toBeCloseTo(0.1, 1)
    expect(a[a.length - 1]!).toBeCloseTo(1, 1)
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeGreaterThanOrEqual(a[i - 1]! - 1e-9)
  })

  test('constant curve: every piece has the same alpha (seams add nothing)', () => {
    const pts = ramp().map((p) => [p[0]!, p[1]!, 0.5, p[3]!])
    const a = alphaPieces(mk(pts, { opacityPressureCurve: [[0, 0.5], [1, 0.5]] }), pts).map((p) => p.alpha)
    expect(a.length).toBeGreaterThan(10)
    a.forEach((v) => expect(v).toBeCloseTo(0.5, 9))
  })

  test('live: closed pieces keep their alpha when points are appended', () => {
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [10 + i * 3, 30, 0.1 + (0.8 * i) / 60, i * 10])
    const c = new LiveCache()
    c.pathOf(mk(pts(40), rise))
    const before = [...c.frozenAlpha]
    expect(before.length).toBeGreaterThan(0)
    c.pathOf(mk(pts(60), rise))
    expect(c.frozenAlpha.length).toBeGreaterThan(before.length)
    expect(c.frozenAlpha.slice(0, before.length)).toEqual(before)
  })
})
