import { describe, expect, it } from 'vitest'
import { brushAlphaFactor, tiltSizeFactor } from '../src/model/brush'
import { strokeOutlineFor } from '../src/render/strokeOutline'

const pts = [[0, 0, 0.5, 0, 45, 0], [10, 0, 0.5, 5, 45, 0], [20, 0, 0.5, 10, 45, 0]]
const height = (poly: number[][]) => Math.max(...poly.map((p) => p[1]!)) - Math.min(...poly.map((p) => p[1]!))

describe('brush engine (spec/brush.md)', () => {
  it('no sizeOf = same outline as before', () => {
    expect(strokeOutlineFor('pen', 4, true, pts, 'normal', undefined)).toEqual(strokeOutlineFor('pen', 4, true, pts, 'normal'))
  })
  it('tilt size narrows an upright pen, unknown tilt keeps width', () => {
    const lin = [1 / 3, 1 / 3, 2 / 3, 2 / 3]
    const up = pts.map((p) => [p[0]!, p[1]!, p[2]!, p[3]!, 0, 0])
    const narrow = strokeOutlineFor('pen', 4, true, up, 'normal', (p) => tiltSizeFactor(p, lin))
    const plain = strokeOutlineFor('pen', 4, true, up, 'normal')
    expect(height(narrow)).toBeCloseTo(height(plain) * 0.5, 0)
    const none = strokeOutlineFor('pen', 4, true, pts.map((p) => p.slice(0, 4)), 'normal', (p) => tiltSizeFactor(p, lin))
    expect(height(none)).toBeCloseTo(height(plain), 5)
  })
  it('alpha factor', () => {
    expect(brushAlphaFactor('pen', undefined, pts)).toBe(1)
    expect(brushAlphaFactor('pen', { opacity: 0.5 }, pts)).toBe(0.5)
    expect(brushAlphaFactor('highlighter', { opacity: 0.2 }, pts)).toBeCloseTo(0.5)
    expect(brushAlphaFactor('tape', { opacity: 0.2 }, pts)).toBe(1)
    expect(brushAlphaFactor('pen', { tiltTarget: 'opacity' }, pts)).toBeCloseTo(0.5, 5)
  })
})
