import { describe, expect, test, vi } from 'vitest'
import { neighbours, setPendingJump, takeJump, type OrderItem } from '../src/ui/library/noteOrder'

const L: OrderItem[] = [{ noteId: 'A', title: 'A' }, { noteId: 'B', title: 'B' }, { noteId: 'C', title: 'C' }]
const o = { offline: false }

describe('neighbours', () => {
  test('middle, ends, single', () => {
    expect(neighbours(L, 'B', o)).toEqual({ prev: 'A', next: 'C', n: 2, total: 3 })
    expect(neighbours(L, 'A', o)).toMatchObject({ prev: null, next: 'B', n: 1 })
    expect(neighbours(L, 'C', o)).toMatchObject({ prev: 'B', next: null, n: 3 })
    expect(neighbours([L[0]!], 'A', o)).toEqual({ prev: null, next: null, n: 1, total: 1 })
  })
  test('skips untitled, blocked, offline remote and skipped notes', () => {
    const l: OrderItem[] = [L[0]!, { noteId: 'B', title: null }, { noteId: 'D', title: 'D', blocked: true }, { noteId: 'E', title: 'E', remote: true }, { noteId: 'F', title: 'F' }, L[2]!]
    expect(neighbours(l, 'A', o)).toMatchObject({ next: 'E', total: 4 })
    expect(neighbours(l, 'A', { offline: true })).toMatchObject({ next: 'F', total: 3 })
    expect(neighbours(l, 'A', { offline: true, skip: (i) => i.noteId === 'F' })).toMatchObject({ next: 'C', total: 2 })
  })
  test('current note missing from the list', () => {
    expect(neighbours(L, 'Z', o)).toEqual({ prev: null, next: null, n: 0, total: 3 })
  })
})

describe('takeJump', () => {
  test('once, and only for its target', () => {
    setPendingJump({ fromId: 'A', fromTitle: 'A', toId: 'B' })
    expect(takeJump('B')?.fromId).toBe('A')
    expect(takeJump('B')).toBeNull()
    setPendingJump({ fromId: 'A', fromTitle: 'A', toId: 'B' })
    expect(takeJump('C')).toBeNull()
    expect(takeJump('B')).toBeNull()
  })
  test('a jump that never arrived expires', () => {
    vi.useFakeTimers()
    setPendingJump({ fromId: 'A', fromTitle: 'A', toId: 'B' })
    vi.advanceTimersByTime(16000)
    expect(takeJump('B')).toBeNull()
    vi.useRealTimers()
  })
})
