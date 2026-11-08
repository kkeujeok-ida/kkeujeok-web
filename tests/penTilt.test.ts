import { describe, expect, it } from 'vitest'
import { penLean } from '../src/ui/library/writer'
import { smoothPoints } from '../src/model/smooth'

const ev = (o: object) => ({ tiltX: 0, tiltY: 0, altitudeAngle: NaN, azimuthAngle: NaN, ...o }) as never

describe('penLean (spec/brush.md)', () => {
  it('altitude/azimuth to tilt/azimuth degrees', () => {
    const [t, a] = penLean(ev({ altitudeAngle: Math.PI / 4, azimuthAngle: Math.PI / 2 }))!
    expect(t).toBeCloseTo(45)
    expect(a).toBeCloseTo(90)
  })
  it('upright is null', () => expect(penLean(ev({ altitudeAngle: Math.PI / 2, azimuthAngle: 0 }))).toBeNull())
  it('falls back to tiltX/tiltY', () => {
    const [t, a] = penLean(ev({ tiltX: 0, tiltY: 45 }))!
    expect(t).toBeCloseTo(45)
    expect(a).toBeCloseTo(90)
  })
})

describe('smoothPoints keeps tilt', () => {
  it('6-number rows stay 6, azimuth uses the shorter arc, mixed rows do not NaN', () => {
    const six = smoothPoints([[0, 0, 1, 0, 10, 350], [1, 0, 1, 1, 20, 10], [2, 0, 1, 2, 30, 20]], 2)
    for (const p of six) expect(p.length).toBe(6)
    expect(six[1]![5]).toBeCloseTo(0, 5)
    const mixed = smoothPoints([[0, 0, 1, 0], [1, 0, 1, 1, 20, 10], [2, 0, 1, 2]], 2)
    for (const p of mixed) expect(p.every(Number.isFinite)).toBe(true)
  })
})
