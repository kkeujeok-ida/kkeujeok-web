import { describe, expect, test } from 'vitest'
import { hexToHsv, hsvToHex } from '../src/model/colorModel'

describe('color model (story 15.6)', () => {
  test.each([
    ['#ff0000', 0, 1, 1],
    ['#00ff00', 120, 1, 1],
    ['#0000ff', 240, 1, 1],
    ['#000000', 0, 0, 0],
    ['#ffffff', 0, 0, 1],
  ])('%s <-> hsv', (hex, h, s, v) => {
    expect(hsvToHex({ h, s, v })).toBe(hex)
    expect(hexToHsv(hex)).toEqual({ h, s, v })
  })
  test('every 8-bit gray and many colors round-trip', () => {
    for (let i = 0; i < 256; i++) {
      const x = i.toString(16).padStart(2, '0')
      expect(hsvToHex(hexToHsv(`#${x}${x}${x}`)!)).toBe(`#${x}${x}${x}`)
    }
    for (const hex of ['#e03131', '#1971c2', '#0c8599', '#12ab34'])
      expect(hsvToHex(hexToHsv(hex)!)).toBe(hex)
  })
  test('upper case accepted, bad input rejected, ranges clamped', () => {
    expect(hexToHsv('#1971C2')).toEqual(hexToHsv('#1971c2'))
    for (const bad of ['1971c2', '#fff', '#gggggg', '']) expect(hexToHsv(bad)).toBeNull()
    expect(hsvToHex({ h: 360, s: 2, v: -1 })).toBe('#000000')
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000')
  })
})

import { onRingBand, withHash } from '../src/ui/library/ColorWheelPicker'
describe('ring hit-test / hex input', () => {
  test('ignores the hole and the outside', () => {
    expect(onRingBand(0, 0, 200, 28)).toBe(false)
    expect(onRingBand(90, 0, 200, 28)).toBe(true)
    expect(onRingBand(150, 0, 200, 28)).toBe(false)
  })
  test('accepts hex without #', () => {
    expect(withHash('ff0000')).toBe('#ff0000')
    expect(withHash('#ff0000')).toBe('#ff0000')
  })
})
