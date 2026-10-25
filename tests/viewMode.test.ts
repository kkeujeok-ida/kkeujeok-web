import { describe, expect, test } from 'vitest'
import { PEN_DETECTED_KEY, createPenDetected } from '../src/storage/penDetected'
import { VIEW_MODE_KEY, createViewMode } from '../src/storage/viewMode'

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
  test('default vertical; a write persists as {"mode":...} and survives a new store', () => {
    const { m, storage } = mem(VIEW_MODE_KEY)
    const s = createViewMode(storage)
    expect(s.read()).toBe('vertical')
    s.write('twoPage')
    expect(JSON.parse(m.get('kkeujeok.viewMode')!)).toEqual({ mode: 'twoPage' })
    expect(createViewMode(storage).read()).toBe('twoPage')
  })

  test.each(['not json', '{"mode":"grid"}', '{}', '[]', 'null', '{"mode":3}'])('stored %s gives vertical', (raw) => {
    expect(createViewMode(mem(VIEW_MODE_KEY, raw).storage).read()).toBe('vertical')
  })

  test('blocked storage: the session value wins; the stale stored one loses', () => {
    const b = createViewMode(blocked)
    expect(b.read()).toBe('vertical')
    b.write('horizontal')
    expect(b.read()).toBe('horizontal')
    const { m, storage } = mem(VIEW_MODE_KEY, '{"mode":"vertical"}')
    const s = createViewMode(storage)
    s.write('horizontal')
    m.set(VIEW_MODE_KEY, '{"mode":"vertical"}')
    expect(s.read()).toBe('horizontal')
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
