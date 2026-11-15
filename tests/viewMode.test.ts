import { describe, expect, test } from 'vitest'
import { PEN_DETECTED_KEY, createPenDetected } from '../src/storage/penDetected'
import { PAGE_VIEW_KEY, VIEW_MODE_KEY, VIEW_PRESETS, createViewMode, effectiveView } from '../src/storage/viewMode'

const mem = (key: string, initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[key, initial]])
  return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
}
const blocked = {
  getItem: (): string | null => {
    throw new Error('blocked')
  },
  setItem: (): void => {
    throw new Error('blocked')
  },
}

describe('view mode store', () => {
  test('old key migrates; a write persists under pageView and survives a new store; old key untouched', () => {
    const { m, storage } = mem(VIEW_MODE_KEY, '{"mode":"twoPage"}')
    const s = createViewMode(storage)
    expect(s.read()).toEqual({ pagination: 'scroll', direction: 'horizontal', pages: 2 })
    s.write({ pagination: 'turn', direction: 'vertical', pages: 2 })
    expect(JSON.parse(m.get(PAGE_VIEW_KEY)!)).toEqual({ pagination: 'turn', direction: 'vertical', pages: 2 })
    expect(m.get(VIEW_MODE_KEY)).toBe('{"mode":"twoPage"}')
    expect(createViewMode(storage).read()).toEqual({ pagination: 'turn', direction: 'vertical', pages: 2 })
    expect(createViewMode(mem(VIEW_MODE_KEY).storage).read()).toEqual(VIEW_PRESETS.vertical)
  })

  test.each(['not json', '{"mode":"grid"}', '{}', '[]', 'null', '{"mode":3}'])('stored old %s gives vertical', (raw) => {
    expect(createViewMode(mem(VIEW_MODE_KEY, raw).storage).read()).toEqual(VIEW_PRESETS.vertical)
  })

  test('a phone shows 1 page, the stored value is kept', () => {
    const m = { pagination: 'turn', direction: 'horizontal', pages: 2 } as const
    expect(effectiveView(m, { w: 599, h: 900 }).pages).toBe(1)
    expect(effectiveView(m, { w: 800, h: 600 })).toBe(m)
  })

  test('blocked storage: the session value wins; the stale stored one loses', () => {
    const b = createViewMode(blocked)
    expect(b.read()).toEqual(VIEW_PRESETS.vertical)
    b.write(VIEW_PRESETS.horizontal)
    expect(b.read()).toEqual(VIEW_PRESETS.horizontal)
    const { m, storage } = mem(VIEW_MODE_KEY, '{"mode":"vertical"}')
    const s = createViewMode(storage)
    s.write(VIEW_PRESETS.horizontal)
    m.set(PAGE_VIEW_KEY, JSON.stringify(VIEW_PRESETS.vertical))
    expect(s.read()).toEqual(VIEW_PRESETS.horizontal)
  })
})

describe('pen detected store', () => {
  test('false until marked; the mark persists as {"detected":true}', () => {
    const { m, storage } = mem(PEN_DETECTED_KEY)
    const s = createPenDetected(storage)
    expect(s.read()).toBe(false)
    s.mark()
    expect(s.read()).toBe(true)
    expect(JSON.parse(m.get('kkeujeok.penDetected')!)).toEqual({ detected: true })
    expect(createPenDetected(storage).read()).toBe(true)
  })

  test.each(['not json', '{"detected":false}', '{"detected":"yes"}', '{}', 'null'])('stored %s is false', (raw) => {
    expect(createPenDetected(mem(PEN_DETECTED_KEY, raw).storage).read()).toBe(false)
  })

  test('blocked storage: marked for this session', () => {
    const s = createPenDetected(blocked)
    expect(s.read()).toBe(false)
    s.mark()
    expect(s.read()).toBe(true)
  })
})
