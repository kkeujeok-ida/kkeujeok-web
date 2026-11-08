import { describe, expect, test } from 'vitest'
import { BRUSH_PRESETS_KEY, MAX_PRESETS, createBrushPresets, parsePresets } from '../src/storage/brushPresets'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[BRUSH_PRESETS_KEY, initial]])
  return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
}
const pen = { tool: 'pen', color: '#000000', width: 2, usePressure: true, brush: { opacity: 0.5 } } as const

describe('brush presets (device setting)', () => {
  test('save, read back, remove', () => {
    const { m, storage } = mem()
    const s = createBrushPresets(storage)
    expect(s.save('  soft  ', pen, 'a')).toEqual([{ id: 'a', name: 'soft', tool: 'pen', width: 2, usePressure: true, brush: { opacity: 0.5 } }])
    expect(createBrushPresets(storage).read()[0]!.brush).toEqual({ opacity: 0.5 })
    expect(JSON.parse(m.get(BRUSH_PRESETS_KEY)!)[0].name).toBe('soft')
    expect(s.remove('a')).toEqual([])
  })
  test('empty name and a full list save nothing', () => {
    const s = createBrushPresets(mem().storage)
    expect(s.save('  ', pen, 'a')).toBeNull()
    for (let i = 0; i < MAX_PRESETS; i++) s.save(`p${i}`, pen, `id${i}`)
    expect(s.save('one more', pen, 'z')).toBeNull()
  })
  test('a bad entry is skipped, the rest stay', () => {
    const raw = JSON.stringify([{ id: 'a', name: 'ok', tool: 'pen', width: 2, usePressure: true }, { id: 'b', name: '', tool: 'pen', width: 2, usePressure: true }, { id: 'c', name: 'x', tool: 'nope', width: 2, usePressure: true }, 7])
    expect(parsePresets(raw).map((p) => p.id)).toEqual(['a'])
    expect(parsePresets('not json')).toEqual([])
  })
})
