import { describe, expect, test } from 'vitest'
import { ERASER_KEY, ERASER_WIDTH, createEraserSettings } from '../src/storage/eraserSettings'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[ERASER_KEY, initial]])
  return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
}
const blockedStorage = {
  getItem: (): string | null => {
    throw new Error('blocked')
  },
  setItem: (): void => {
    throw new Error('blocked')
  },
}

describe('eraser settings', () => {
  test('defaults: stroke, no return, width 12', () => {
    expect(createEraserSettings(mem().storage).read()).toEqual({ mode: 'stroke', returnToPen: false })
    expect(ERASER_WIDTH).toBe(12)
  })

  test('write merges a patch, keeps the other field and persists under kkeujeok.eraser', () => {
    const { m, storage } = mem()
    const s = createEraserSettings(storage)
    s.write({ mode: 'partial' })
    s.write({ returnToPen: true })
    expect(s.read()).toEqual({ mode: 'partial', returnToPen: true })
    expect(createEraserSettings(storage).read()).toEqual({ mode: 'partial', returnToPen: true })
    expect(JSON.parse(m.get('kkeujeok.eraser')!)).toEqual({ mode: 'partial', returnToPen: true })
  })

  test.each(['not json', '{"mode":"wide","returnToPen":true}', '{"mode":"partial"}', '{"mode":"partial","returnToPen":"yes"}', '[]', 'null'])(
    'invalid stored value %s gives the defaults',
    (raw) => {
      expect(createEraserSettings(mem(raw).storage).read()).toEqual({ mode: 'stroke', returnToPen: false })
    },
  )

  test('blocked storage: the session value wins; no storage at all works too', () => {
    const blocked = createEraserSettings(blockedStorage)
    expect(blocked.read()).toEqual({ mode: 'stroke', returnToPen: false })
    blocked.write({ mode: 'partial' })
    expect(blocked.read().mode).toBe('partial')
    const none = createEraserSettings(undefined)
    none.write({ returnToPen: true })
    expect(none.read().returnToPen).toBe(true)
  })

  test('the session value beats a stale stored one', () => {
    const { m, storage } = mem('{"mode":"stroke","returnToPen":false}')
    const s = createEraserSettings(storage)
    s.write({ mode: 'partial' })
    m.set(ERASER_KEY, '{"mode":"stroke","returnToPen":false}')
    expect(s.read().mode).toBe('partial')
  })
})
