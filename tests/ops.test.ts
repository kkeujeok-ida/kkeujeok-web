import { describe, expect, test } from 'vitest'
import { validateNote } from '../src/model/note'
import type { Note } from '../src/model/note'
import { History } from '../src/ops/history'
import { type Ctx, type Op, applyOp, createNote } from '../src/ops/ops'

const ctx: Ctx = { rev: 'r2', now: '2026-10-10T04:21:00.000Z', editedBy: 'X', lastSeenRemoteSeq: 0 }
const made = createNote({
  title: 't', existingTitles: [], background: 'plain', orientation: 'portrait',
  noteId: 'n', pageId: 'p', pageRev: 'r1', metaRev: 'm', orderRev: 'o',
  now: '2026-10-10T04:20:00.000Z', editedBy: 'X',
})
const base = ('note' in made ? made.note : null) as Note
const stroke = (id = 's1') => ({
  id, type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false,
  points: [[1, 2, 0.5, 0]],
})
const withEls = (els: unknown[]): Note => {
  const n = structuredClone(base)
  n.pages[0]!.elements = els
  return n
}
const add = (note: Note, op: Partial<Op>) => applyOp(note, { op: 'addStroke', pageId: 'p', stroke: stroke(), ...op }, ctx)

describe('addStroke error order', () => {
  test('pageNotFound beats invalidStroke', () => {
    expect(add(base, { pageId: 'zz', stroke: 1 })).toEqual({ error: 'pageNotFound' })
  })
  test('invalidStroke beats duplicateId', () => {
    const n = withEls([stroke('s1')])
    expect(add(n, { stroke: { ...stroke('s1'), tool: 'brush' } })).toEqual({ error: 'invalidStroke' })
  })
  test('duplicateId beats indexOutOfRange', () => {
    expect(add(withEls([stroke('s1')]), { index: 9 })).toEqual({ error: 'duplicateId' })
  })
  test('indexOutOfRange', () => {
    expect(add(base, { index: 2 })).toEqual({ error: 'indexOutOfRange' })
    expect(add(base, { index: 0.5 })).toEqual({ error: 'indexOutOfRange' })
  })
  test('non-finite numbers are invalidStroke', () => {
    expect(add(base, { stroke: { ...stroke(), width: Number.NaN } })).toEqual({ error: 'invalidStroke' })
    expect(add(base, { stroke: { ...stroke(), points: [[1, 2, Infinity, 0]] } })).toEqual({
      error: 'invalidStroke',
    })
  })
})

describe('other ops', () => {
  test('unknownOp', () => {
    expect(applyOp(base, { op: 'deleteNote', noteId: 'n' }, ctx)).toEqual({ error: 'unknownOp' })
  })
  test('removeStroke ignores non-stroke elements', () => {
    const n = withEls([{ id: 'x', type: 'image' }])
    expect(applyOp(n, { op: 'removeStroke', pageId: 'p', strokeId: 'x' }, ctx)).toEqual({
      error: 'strokeNotFound',
    })
  })
  test('non-finite page size or seq is unreadable', () => {
    for (const k of ['width', 'height', 'seq'] as const) {
      const n = structuredClone(base)
      n.pages[0]![k] = Number.POSITIVE_INFINITY
      expect(validateNote(n).result).toBe('unreadable')
    }
  })
})

describe('History', () => {
  test('a failed replay leaves note and stacks unchanged', () => {
    const h = new History(base)
    expect(h.doOp({ op: 'addStroke', pageId: 'p', stroke: stroke() }, ctx)).toBeNull()
    expect(h.undoDepth).toBe(1)
    // The note changed outside the history: the stroke is gone, undo cannot find it.
    h.note = withEls([])
    const before = h.note
    expect(h.undo(ctx)).toBe('strokeNotFound')
    expect(h.note).toBe(before)
    expect([h.undoDepth, h.redoDepth]).toEqual([1, 0])
  })
  test('a failed do is not recorded', () => {
    const h = new History(base)
    expect(h.doOp({ op: 'nope' }, ctx)).toBe('unknownOp')
    expect([h.undoDepth, h.redoDepth]).toEqual([0, 0])
  })
})
