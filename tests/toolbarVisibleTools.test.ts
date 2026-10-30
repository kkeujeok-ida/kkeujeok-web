import { describe, expect, test } from 'vitest'
import { VISIBLE_TOOLS_KEY, clampVisibleTools, createVisibleTools } from '../src/storage/toolbarVisibleTools'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[VISIBLE_TOOLS_KEY, initial]])
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('visible tools store', () => {
  test('default 7; a write persists and survives a new store', () => {
    const storage = mem()
    const s = createVisibleTools(storage)
    expect(s.read()).toBe(7)
    s.write(10)
    expect(createVisibleTools(storage).read()).toBe(10)
  })
  test.each(['not json', '{}', '{"n":"5"}', 'null', '{"n":null}'])('stored %s gives 7', (raw) => {
    expect(createVisibleTools(mem(raw)).read()).toBe(7)
  })
  test('clamps to 3..12', () => {
    expect(clampVisibleTools(1)).toBe(3)
    expect(clampVisibleTools(99)).toBe(12)
    expect(clampVisibleTools(NaN)).toBe(7)
    expect(createVisibleTools(mem('{"n":50}')).read()).toBe(12)
  })
})
