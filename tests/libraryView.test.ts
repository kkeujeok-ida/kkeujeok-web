import { describe, expect, test } from 'vitest'
import { LIBRARY_VIEW_DEFAULT, LIBRARY_VIEW_KEY, createLibraryView } from '../src/storage/libraryView'

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[LIBRARY_VIEW_KEY, initial]])
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('library view store', () => {
  test('default is a large list; a write persists and survives a new store', () => {
    const storage = mem()
    expect(createLibraryView(storage).read()).toEqual(LIBRARY_VIEW_DEFAULT)
    createLibraryView(storage).write({ layout: 'grid', size: 'small' })
    expect(createLibraryView(storage).read()).toEqual({ layout: 'grid', size: 'small' })
  })
  test.each(['not json', '{}', 'null', '{"layout":"grid"}', '{"layout":"x","size":"small"}', '{"layout":"grid","size":5}'])('stored %s gives the default', (raw) => {
    expect(createLibraryView(mem(raw)).read()).toEqual(LIBRARY_VIEW_DEFAULT)
  })
  test('a failing storage keeps the session choice', () => {
    const boom = () => {
      throw new Error('x')
    }
    const s = createLibraryView({ getItem: boom, setItem: boom })
    expect(s.read()).toEqual(LIBRARY_VIEW_DEFAULT)
    s.write({ layout: 'list', size: 'small' })
    expect(s.read()).toEqual({ layout: 'list', size: 'small' })
  })
})
