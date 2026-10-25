import { describe, expect, test } from 'vitest'
import { DEFAULT_POS, TOOLBAR_KEY, createToolbarPosition } from '../src/storage/toolbarPosition'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[TOOLBAR_KEY, initial]])
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

describe('toolbar position', () => {
  test('default is top, horizontal', () => {
    expect(createToolbarPosition(mem().storage).read()).toEqual({ dock: 'top', x: 0.5, y: 0, vertical: false })
    expect(DEFAULT_POS.dock).toBe('top')
  })

  test.each([
    ['unknown dock', { dock: 'middle', x: 0.5, y: 0.5, vertical: false }],
    ['x out of range', { dock: 'float', x: 1.2, y: 0.5, vertical: false }],
    ['y negative', { dock: 'float', x: 0.5, y: -0.1, vertical: false }],
    ['x not a number', { dock: 'float', x: '0.5', y: 0.5, vertical: false }],
    ['vertical not boolean', { dock: 'left', x: 0.5, y: 0, vertical: 1 }],
  ])('invalid value (%s) reads as the default', (_n, v) => {
    expect(createToolbarPosition(mem(JSON.stringify(v)).storage).read()).toEqual(DEFAULT_POS)
  })

  test('a docked position takes its orientation from the dock', () => {
    const read = (v: object) => createToolbarPosition(mem(JSON.stringify(v)).storage).read()
    expect(read({ dock: 'left', x: 0.5, y: 0, vertical: false }).vertical).toBe(true)
    expect(read({ dock: 'top', x: 0.5, y: 0, vertical: true }).vertical).toBe(false)
    expect(read({ dock: 'float', x: 0.5, y: 0.5, vertical: true }).vertical).toBe(true)
  })

  test('write rounds ratios to 4 places and persists under kkeujeok.toolbar', () => {
    const { m, storage } = mem()
    const s = createToolbarPosition(storage)
    s.write({ dock: 'float', x: 0.123456, y: 0.98765, vertical: true })
    expect(JSON.parse(m.get('kkeujeok.toolbar')!)).toEqual({ dock: 'float', x: 0.1235, y: 0.9877, vertical: true })
    expect(createToolbarPosition(storage).read()).toEqual({ dock: 'float', x: 0.1235, y: 0.9877, vertical: true })
  })

  test('blocked storage: the session value wins, reads fall back to the default', () => {
    const s = createToolbarPosition(blocked)
    expect(s.read()).toEqual(DEFAULT_POS)
    s.write({ dock: 'left', x: 0.5, y: 0, vertical: true })
    expect(s.read().dock).toBe('left')
  })
})
