import { expect, test } from 'vitest'
import { hintSeen, markHint } from '../src/storage/hints'

test('a hint is unseen until marked, and blocked storage never throws', () => {
  const m = new Map<string, string>()
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  expect(hintSeen('penEdit', s)).toBe(false)
  markHint('penEdit', s)
  expect(hintSeen('penEdit', s)).toBe(true)
  expect(hintSeen('firstNote', s)).toBe(false)
  const bad = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  expect(hintSeen('penEdit', bad)).toBe(false)
  expect(() => markHint('penEdit', bad)).not.toThrow()
})
