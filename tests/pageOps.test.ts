// @vitest-environment jsdom
// Story 6.5: the writer's page edits (one undo step each, locked pages refused) and the scroll-past-end pull.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { History } from '../src/ops/history'
import { dropIndex, stepIndex } from '../src/model/pageMove'
import { PULL_PX, Writer } from '../src/ui/library/writer'
import { PA, PB, mkNote } from './uploadHarness'

const mk = (readOnly = false) => {
  const h = new History(mkNote({ title: 'x', pages: { [PA]: 'a1', [PB]: 'b1' } }))
  const w = new Writer(h, { writeNote: async () => {}, close: () => {} } as never, () => ({}) as never, () => {}, () => 'C')
  w.readOnly = readOnly
  return { h, w }
}
const ids = (h: History) => h.note.pages.map((p) => p.id)

describe('page edits', () => {
  test('add, duplicate and delete are one undo step each; redo repeats them', () => {
    const { h, w } = mk()
    expect(w.pageEdit({ op: 'addPage', index: 1 })).toBeNull()
    expect(h.note.pages).toHaveLength(3)
    expect(w.pageEdit({ op: 'duplicatePage', pageIds: [PA] })).toBeNull()
    expect(h.note.pages).toHaveLength(4)
    expect(w.pageEdit({ op: 'deletePage', pageIds: [PB] })).toBeNull()
    expect(ids(h)).not.toContain(PB)
    expect(w.undo()).toBe(true)
    expect(ids(h)).toContain(PB)
    expect(h.note.pages).toHaveLength(4)
    expect(w.undo()).toBe(true)
    expect(w.undo()).toBe(true)
    expect(ids(h)).toEqual([PA, PB])
    expect(w.redo()).toBe(true)
    expect(h.note.pages).toHaveLength(3)
  })

  test('the last page cannot be deleted; a read-only writer and a locked page refuse', () => {
    const { h, w } = mk()
    expect(w.pageEdit({ op: 'deletePage', pageIds: [PA, PB] })).toBe('lastPage')
    h.setLocked([PA])
    expect(w.pageEdit({ op: 'deletePage', pageIds: [PA] })).toBe('pageReadOnly')
    expect(ids(h)).toEqual([PA, PB])
    expect(mk(true).w.pageEdit({ op: 'addPage', index: 0 })).toBe('notApplied')
  })
})

describe('moving pages (Story 6.7)', () => {
  test('a block move keeps relative order and is one undo step', () => {
    const { h, w } = mk()
    w.pageEdit({ op: 'addPage', index: 2 })
    const [a, b, c] = ids(h) as [string, string, string]
    expect(w.pageEdit({ op: 'movePages', pageIds: [c, a], index: 1 })).toBeNull() // the rest is [b]
    expect(ids(h)).toEqual([b, a, c])
    expect(w.undo()).toBe(true)
    expect(ids(h)).toEqual([a, b, c])
  })

  test('drop and step indexes count the pages that stay', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(dropIndex(order, new Set(['a']), 3)).toBe(2)
    expect(dropIndex(order, new Set(['c', 'd']), 0)).toBe(0)
    expect(stepIndex(order, new Set(['b']), -1)).toBe(0)
    expect(stepIndex(order, new Set(['a']), -1)).toBeNull()
    expect(stepIndex(order, new Set(['c', 'd']), 1)).toBeNull()
    expect(stepIndex(order, new Set(['b', 'c']), 1)).toBe(2)
  })
})

describe('background, orientation, out of bounds (Story 6.9)', () => {
  test('several backgrounds are one undo step; orientation swaps the size; the selection takes the elements outside', () => {
    const { h, w } = mk()
    expect(w.pageEdit({ op: 'setPageBackground', items: [{ pageId: PA, background: 'grid' }, { pageId: PB, background: 'dot' }] })).toBeNull()
    expect(h.note.pages.map((p) => p.background)).toEqual(['grid', 'dot'])
    expect(w.pageEdit({ op: 'setPageOrientation', pageId: PA, orientation: 'landscape' })).toBeNull()
    expect(h.note.pages[0]!.width).toBeGreaterThan(h.note.pages[0]!.height)
    w.undo()
    expect(h.note.pages[0]!.width).toBeLessThan(h.note.pages[0]!.height)
    w.undo()
    expect(h.note.pages[0]!.background).not.toBe('grid')
    expect(h.note.pages[1]!.background).not.toBe('dot')
    h.doOp({ op: 'addStroke', pageId: PA, stroke: { id: 's9', type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: [[-90, 5, 0.5, 0], [10, 10, 0.5, 5]] } }, { rev: 'r', now: 'n', editedBy: 'C', lastSeenRemoteSeq: 0 })
    expect(w.selectOutOfBounds(PA)).toBe(1)
    expect(w.selectedCount).toBe(1)
    expect(w.selectOutOfBounds(PB)).toBe(0)
  })
})

describe('scroll past the end', () => {
  const pulls = (w: Writer) => {
    const out: string[] = []
    w.onPullAdd = (e) => out.push(e)
    const vp = (w as unknown as { viewport: unknown }).viewport
    const step = (amount: number, gap = 0) => {
      if (gap) (w as unknown as { pull: { last: number } }).pull.last -= gap
      ;(w as unknown as { pullCheck(b: unknown, a: number): void }).pullCheck(vp, amount)
    }
    return { out, step }
  }

  test('a run that starts at the edge adds a page at PULL_PX, once', () => {
    const { w } = mk()
    const { out, step } = pulls(w)
    for (let i = 0; i < 10; i++) step(PULL_PX / 8)
    expect(out).toEqual(['end'])
  })

  test('inertia rolling into the edge adds nothing; a pause resets the amount', () => {
    const { w } = mk()
    const { out, step } = pulls(w)
    const view = (w as unknown as { viewport: object }).viewport
    // the first event of the run moves the view (not at the edge yet)
    ;(w as unknown as { pullCheck(b: unknown, a: number): void }).pullCheck({ ...view, offsetY: 99 }, 100)
    for (let i = 0; i < 10; i++) step(100)
    expect(out).toEqual([])
    step(100, 1000) // a new run at the edge...
    step(PULL_PX / 2)
    step(1, 1000) // ...paused: back to zero
    step(PULL_PX / 2)
    expect(out).toEqual([])
    step(-PULL_PX, 1000)
    expect(out).toEqual(['start'])
  })
})
