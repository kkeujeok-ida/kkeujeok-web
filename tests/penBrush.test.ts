import { describe, expect, test } from 'vitest'
import { patchBrush } from '../src/model/brush'
import { switchKind } from '../src/model/pen'
import { createPenSlots, PEN_SLOTS_KEY } from '../src/storage/penSlots'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[PEN_SLOTS_KEY, initial]])
  return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
}
const pen = { tool: 'pen', color: '#000000', width: 2, usePressure: true } as const

describe('patchBrush keeps only what differs from the tool default', () => {
  test('default values are dropped, empty brush is undefined', () => {
    expect(patchBrush('pen', undefined, { opacity: 0.5 })).toEqual({ opacity: 0.5 })
    expect(patchBrush('pen', { opacity: 0.5 }, { opacity: 1 })).toBeUndefined()
    expect(patchBrush('highlighter', undefined, { opacity: 0.4 })).toBeUndefined()
    expect(patchBrush('pencil', undefined, { texture: 'pencil' })).toBeUndefined()
    expect(patchBrush('pen', undefined, { texture: 'pencil' })).toEqual({ texture: 'pencil' })
    expect(patchBrush('pen', { pressureCurve: [0.3, 0.3, 0.6, 0.6] }, { pressureCurve: null })).toBeUndefined()
  })
  test('unknown parameters survive', () => {
    expect(patchBrush('pen', { flow: 0.5 }, { opacity: 0.5 })).toEqual({ flow: 0.5, opacity: 0.5 })
  })
})

describe('pen slots keep brush', () => {
  test('write then read keeps brush; a pen without brush gets no key', () => {
    const { m, storage } = mem()
    const s = createPenSlots(storage)
    s.write([{ ...pen, brush: { opacity: 0.5 } }, pen])
    const stored = JSON.parse(m.get(PEN_SLOTS_KEY)!)
    expect(stored[0].brush).toEqual({ opacity: 0.5 })
    expect('brush' in stored[1]).toBe(false)
    expect(createPenSlots(storage).read()[0]!.brush).toEqual({ opacity: 0.5 })
  })
  test('a bad brush is dropped, the list stays', () => {
    const raw = JSON.stringify([{ ...pen, brush: 'x' }, { ...pen, brush: [1] }, { ...pen, brush: {} }])
    const list = createPenSlots(mem(raw).storage).read()
    expect(list.length).toBe(3)
    expect(list.every((p) => p.brush === undefined)).toBe(true)
  })
  test('switching kind drops brush; same kind keeps it', () => {
    const p = { ...pen, brush: { opacity: 0.5 } }
    expect(switchKind(p, 'fountain').brush).toBeUndefined()
    expect(switchKind(p, 'pen').brush).toEqual({ opacity: 0.5 })
  })
})

describe('texture picker (28.5)', () => {
  test('stamp on pen is stored, density 1 and pencil+none follow the default rule', () => {
    expect(patchBrush('fountain', undefined, { texture: 'pencil' })).toEqual({ texture: 'pencil' })
    expect(patchBrush('pen', { texture: 'pencil' }, { texture: 'none' })).toBeUndefined()
    expect(patchBrush('pencil', undefined, { texture: 'none' })).toEqual({ texture: 'none' })
    expect(patchBrush('pen', { texture: 'pencil' }, { density: 0.5 })).toEqual({ texture: 'pencil', density: 0.5 })
    expect(patchBrush('pen', { texture: 'pencil', density: 0.5 }, { density: 1 })).toEqual({ texture: 'pencil' })
  })
})
