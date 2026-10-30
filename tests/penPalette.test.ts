import { describe, expect, test } from 'vitest'
import { PALETTE_KEY, PALETTE_MAX, createPenPalette } from '../src/storage/penPalette'
import { PEN_PALETTE } from '../src/model/pen'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[PALETTE_KEY, initial]])
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('pen palette store', () => {
  test('default; a write persists per tool and survives a new store', () => {
    const storage = mem()
    const s = createPenPalette(storage)
    expect(s.read('pen')).toEqual(PEN_PALETTE.pen.colors)
    s.write('pen', ['#112233', '#000000'])
    expect(createPenPalette(storage).read('pen')).toEqual(['#112233', '#000000'])
    expect(createPenPalette(storage).read('highlighter')).toEqual(PEN_PALETTE.highlighter.colors)
  })
  test.each(['not json', '{"pen":5}', '{"pen":[]}', '{"pen":["red"]}', '{"pen":["#000000","#000000"]}', 'null', `{"pen":${JSON.stringify(Array(19).fill(0).map((_, i) => `#0000${(i + 16).toString(16)}`))}}`])('stored %s gives default', (raw) => {
    expect(createPenPalette(mem(raw)).read('pen')).toEqual(PEN_PALETTE.pen.colors)
  })
  test('max 18, min 1, reset', () => {
    const s = createPenPalette(mem())
    const eighteen = Array.from({ length: PALETTE_MAX }, (_, i) => `#0000${(i + 16).toString(16)}`)
    expect(s.write('pen', eighteen)).toEqual(eighteen)
    expect(s.write('pen', [...eighteen, '#ffffff'])).toEqual(eighteen) // too many: ignored
    expect(s.write('pen', [])).toEqual(eighteen) // empty: ignored
    expect(s.reset('pen')).toEqual(PEN_PALETTE.pen.colors)
  })
  test('failed save keeps the session value', () => {
    const s = createPenPalette({ getItem: () => null, setItem: () => { throw new Error('full') } })
    s.write('highlighter', ['#abcdef'])
    expect(s.read('highlighter')).toEqual(['#abcdef'])
  })
})
