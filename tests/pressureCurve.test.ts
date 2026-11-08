import { describe, expect, test } from 'vitest'
import fx from '../../test/pen.pressureCurve.json'
import { drawPressure, pressureCurve, radiusFactor } from '../src/model/pressureCurve'
import { PRESSURE_CURVE_KEY, parseCurve, setPressureCurve } from '../src/storage/pressureCurve'
import { strokeOutline } from '../src/render/strokeOutline'

describe('pen.pressureCurve fixture', () => {
  for (const c of fx.cases) {
    test(c.name, () => {
      const q = drawPressure(c.input.curve, c.input.usePressure, c.input.pressure)
      expect(Math.abs(q - c.expected.q)).toBeLessThan(fx.tolerance)
      expect(Math.abs(radiusFactor(q) - c.expected.factor)).toBeLessThan(fx.tolerance)
    })
  }
})

describe('curve setting', () => {
  test('invalid stored values are normal', () => {
    expect(parseCurve('[0.8,0.1,0.2,0.5]')).toBe('normal')
    expect(parseCurve('[0.3,0.6,0.6]')).toBe('normal')
    expect(parseCurve('[2,0,0,0]')).toBe('normal')
    expect(parseCurve('"bogus"')).toBe('normal')
    expect(parseCurve('{')).toBe('normal')
    expect(parseCurve(null)).toBe('normal')
    expect(parseCurve('"soft"')).toBe('soft')
    expect(parseCurve('[0.2,0.4,0.5,0.8]')).toEqual([0.2, 0.4, 0.5, 0.8])
  })
  test('set rejects an invalid curve, stores a valid one', () => {
    const m = new Map<string, string>()
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
    expect(setPressureCurve([0.8, 0.1, 0.2, 0.5], st)).toBe(false)
    expect(setPressureCurve([0.3, 0.6, 0.6], st)).toBe(false)
    expect(m.size).toBe(0)
    expect(setPressureCurve('firm', st)).toBe(true)
    expect(m.get(PRESSURE_CURVE_KEY)).toBe('"firm"')
    setPressureCurve('normal', st)
  })
})

describe('outline', () => {
  const pts = (p: number) => [0, 1, 2, 3, 4].map((i) => [i * 5, 0, p, i])
  test('curve changes width with pressure; usePressure off and mouse (all 0.5) do not', () => {
    const a = strokeOutline(4, true, pts(0.3875), 'normal')
    expect(strokeOutline(4, true, pts(0.3875), 'soft')).not.toEqual(a)
    expect(strokeOutline(4, false, pts(0.3875), 'soft')).toEqual(strokeOutline(4, false, pts(0.3875), 'firm'))
    expect(strokeOutline(4, true, pts(0.5), 'soft')).toEqual(strokeOutline(4, true, pts(0.5), 'firm'))
    expect(pressureCurve('soft', 0)).toBe(0)
  })
})
