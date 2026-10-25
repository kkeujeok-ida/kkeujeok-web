import { describe, expect, test } from 'vitest'
import { defaultPen, defaultPenSlots } from '../src/model/pen'
import { PEN_SLOTS_KEY, createPenSlots } from '../src/storage/penSlots'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[PEN_SLOTS_KEY, initial]])
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

const slot = (o: object = {}) => ({ tool: 'pen', color: '#000000', width: 2, usePressure: true, ...o })

describe('pen slots store', () => {
  test('nothing stored: the three default slots, and a copy', () => {
    const s = createPenSlots(mem())
    expect(s.read()).toEqual(defaultPenSlots)
    s.read()[0]!.usePressure = false
    expect(s.read()[0]!.usePressure).toBe(true)
  })

  test('write round-trips through a new store (restart), in order, with the tool', () => {
    const st = mem()
    const list = [defaultPenSlots[2]!, { ...defaultPen, usePressure: false }, defaultPenSlots[1]!]
    createPenSlots(st).write(list)
    expect(JSON.parse(st.m.get(PEN_SLOTS_KEY)!)).toEqual(list)
    expect(createPenSlots(st).read()).toEqual(list)
  })

  test('an older value without tool is a pen', () => {
    const raw = JSON.stringify([{ color: '#1971c2', width: 3, usePressure: false }])
    expect(createPenSlots(mem(raw)).read()).toEqual([{ tool: 'pen', color: '#1971c2', width: 3, usePressure: false }])
  })

  test('12 slots are fine, 13 are not', () => {
    expect(createPenSlots(mem(JSON.stringify(Array(12).fill(slot())))).read()).toHaveLength(12)
    expect(createPenSlots(mem(JSON.stringify(Array(13).fill(slot())))).read()).toEqual(defaultPenSlots)
  })

  test.each([
    'not json',
    '{}',
    '[]',
    '[1]',
    '[null]',
    JSON.stringify([slot({ color: 'red' })]),
    JSON.stringify([slot({ width: 99 })]),
    JSON.stringify([slot({ width: 0.4 })]),
    JSON.stringify([slot({ tool: 'highlighter', width: 3.9 })]), // below the highlighter range
    JSON.stringify([slot({ tool: 'pen', width: 14 })]), // above the pen range
    JSON.stringify([slot({ tool: 'eraser' })]),
    JSON.stringify([slot({ usePressure: 'yes' })]),
    JSON.stringify([slot(), slot({ color: 'x' })]), // one bad slot spoils the list
  ])('corrupt value %s falls back to the defaults', (raw) => {
    expect(createPenSlots(mem(raw)).read()).toEqual(defaultPenSlots)
  })

  test('highlighter width is judged by the highlighter range', () => {
    const raw = JSON.stringify([slot({ tool: 'highlighter', color: '#ffe066', width: 30, usePressure: false })])
    expect(createPenSlots(mem(raw)).read()[0]!.width).toBe(30)
  })

  test('unreadable storage falls back; the session value wins when saving fails', () => {
    const s = createPenSlots({
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(s.read()).toEqual(defaultPenSlots)
    s.write([{ ...defaultPen, usePressure: false }])
    expect(s.read()[0]!.usePressure).toBe(false)
  })
})
