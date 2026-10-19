import { describe, expect, test } from 'vitest'
import { createdMs, sortBy, type LibraryItem } from '../src/ui/library/useLibrary'

const it = (noteId: string, title: string | null, editedMs: number | null): LibraryItem => ({ noteId, title, editedMs })
// UUIDv7: the first 48 bits are the creation time in ms.
const id = (ms: number, tail = '7000-8000-000000000000') => `${ms.toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2')}-${tail}`

describe('library sort', () => {
  const a = it(id(3000), 'banana', 10)
  const b = it(id(1000), 'Apple', 30)
  const c = it(id(2000), '가나', null)
  const bad = it(id(500), null, null)
  const names = (l: LibraryItem[]) => l.map((i) => i.title)

  test('createdMs reads the UUIDv7 time', () => {
    expect(createdMs(id(1234567890123))).toBe(1234567890123)
    expect(createdMs('zz')).toBeNull()
  })
  test('by name, either way; unreadable stays last', () => {
    expect(names(sortBy([bad, a, b, c], 'nameAsc'))).toEqual(['Apple', 'banana', '가나', null])
    expect(names(sortBy([bad, a, b, c], 'nameDesc'))).toEqual(['가나', 'banana', 'Apple', null])
  })
  test('by created and by edited; a missing date goes after the dated ones', () => {
    expect(names(sortBy([a, b, c, bad], 'createdDesc'))).toEqual(['banana', '가나', 'Apple', null])
    expect(names(sortBy([a, b, c, bad], 'createdAsc'))).toEqual(['Apple', '가나', 'banana', null])
    expect(names(sortBy([a, b, c], 'editedDesc'))).toEqual(['Apple', 'banana', '가나'])
    expect(names(sortBy([a, b, c], 'editedAsc'))).toEqual(['banana', 'Apple', '가나'])
  })
})
