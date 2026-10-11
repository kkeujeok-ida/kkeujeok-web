import { describe, expect, test } from 'vitest'
import { defaultPen } from '../src/model/pen'
import { PEN_SLOTS_KEY, createPenSlots } from '../src/storage/penSlots'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[PEN_SLOTS_KEY, initial]])
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('pen slots store', () => {
  test('nothing stored: the default slot, and a copy', () => {
    const s = createPenSlots(mem())
    expect(s.read()).toEqual([defaultPen])
    s.read()[0]!.usePressure = false
    expect(s.read()[0]!.usePressure).toBe(true)
  })

  test('write round-trips through a new store (restart)', () => {
    const st = mem()
    createPenSlots(st).write([{ ...defaultPen, usePressure: false }])
    expect(JSON.parse(st.m.get(PEN_SLOTS_KEY)!)).toEqual([{ color: '#000000', width: 2, usePressure: false }])
    expect(createPenSlots(st).read()).toEqual([{ ...defaultPen, usePressure: false }])
  })

  test.each([
    'not json',
    '{}',
    '[]',
    '[1]',
    '[null]',
    '[{"color":"red","width":2,"usePressure":true}]',
    '[{"color":"#000000","width":99,"usePressure":true}]',
    '[{"color":"#000000","width":2,"usePressure":"yes"}]',
  ])('corrupt value %s falls back to the default', (raw) => {
    expect(createPenSlots(mem(raw)).read()).toEqual([defaultPen])
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
    expect(s.read()).toEqual([defaultPen])
    s.write([{ ...defaultPen, usePressure: false }])
    expect(s.read()[0]!.usePressure).toBe(false)
  })
})
