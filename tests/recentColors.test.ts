import { describe, expect, test } from 'vitest'
import { RECENT_COLORS_KEY, createRecentColors } from '../src/storage/recentColors'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[RECENT_COLORS_KEY, initial]])
  return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
}

describe('recent colors', () => {
  test('newest first, an existing color moves to the front, lower case, six at most', () => {
    const { m, storage } = mem()
    const r = createRecentColors(storage)
    for (const c of ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006']) r.push(c)
    expect(r.push('#000007')).toEqual(['#000007', '#000006', '#000005', '#000004', '#000003', '#000002'])
    expect(r.push('#000004')).toEqual(['#000004', '#000007', '#000006', '#000005', '#000003', '#000002'])
    expect(r.push('#ABCDEF')[0]).toBe('#abcdef')
    expect(JSON.parse(m.get(RECENT_COLORS_KEY)!)).toHaveLength(6)
    expect(createRecentColors(storage).read()[0]).toBe('#abcdef')
  })

  test('invalid entries are dropped; a corrupt or missing value is empty; a bad push is ignored', () => {
    expect(createRecentColors(mem('["#112233","red",5,"#11223"]').storage).read()).toEqual(['#112233'])
    expect(createRecentColors(mem('{"x":1}').storage).read()).toEqual([])
    expect(createRecentColors(mem('not json').storage).read()).toEqual([])
    expect(createRecentColors(mem().storage).read()).toEqual([])
    const r = createRecentColors(mem().storage)
    expect(r.push('nope')).toEqual([])
  })

  test('a storage that throws keeps the session value', () => {
    const r = createRecentColors({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(r.read()).toEqual([])
    expect(r.push('#112233')).toEqual(['#112233'])
    expect(r.read()).toEqual(['#112233'])
  })
})
