// Merge engine behavior beyond the shared fixtures (Story 3.4): no input
// mutation, own-property writes, the change-queue integration (AD-16), the
// undo drop, the unsupported-version result and the uploader's mergeStep.
import { createHash } from 'node:crypto'
import { v5 } from 'uuid'
import { describe, expect, test } from 'vitest'
import type { Note, Page } from '../src/model/note'
import { History } from '../src/ops/history'
import { applyMergeToSession, clearSessionHistories, sessionHistory } from '../src/ops/sessionHistories'
import { PAGE_ID_NAMESPACE, resolveConflict } from '../src/ops/resolveConflict'
import { commitMerge } from '../src/sync/commitMerge'
import { type MergeCtx, merge } from '../src/sync/merge'
import { mergeStep } from '../src/sync/mergeStep'
import { Writer } from '../src/ui/library/writer'

const page = (id: string, rev: string, seq = 1, elements: unknown[] = []): Page => ({
  id, width: 595, height: 842, background: 'plain', rev, seq, editedAt: '2026-10-10T04:10:00.000Z', editedBy: 'X', elements,
})
const note = (pages: Page[], extra: Record<string, unknown> = {}): Note => ({
  formatVersion: 1, noteId: 'n', meta: { title: 't' }, metaRev: 'm1', metaSeq: 1, orderRev: 'o1', orderSeq: 1, pages, ...extra,
})
const ctx: MergeCtx = { now: '2026-10-16T09:00:00.000Z', orderRev: 'o9', rev: 'r9', editedBy: 'Chrome, Windows', lastSeenRemoteSeq: 0 }
const opCtx = (rev: string) => ({ rev, now: ctx.now, editedBy: 'X', lastSeenRemoteSeq: 0 })
const stroke = (id: string) => ({ id, type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: [[1, 2, 0.5, 0]] })
let n = 0
const edit = (h: History, pageId: string, sid: string) =>
  expect(h.doOp({ op: 'addStroke', pageId, stroke: stroke(sid) }, opCtx(`e${++n}`))).toBeNull()
const pageOf = (x: Note, id: string) => x.pages.find((p) => p.id === id)!

describe('merge purity', () => {
  test('inputs are not mutated and the result shares no object with them', () => {
    const base = note([page('a', 'a1')])
    const local = note([page('a', 'a2', 2), page('b', 'b1')])
    const remote = note([page('a', 'a1')], { futureX: { k: [1] } })
    const snap = structuredClone([base, local, remote, ctx])
    const r = merge(base, local, remote, ctx)
    expect(r.result).toBe('merged')
    expect(structuredClone([base, local, remote, ctx])).toEqual(snap)
    if (r.result !== 'merged') return
    expect(r.note.pages[0]).not.toBe(local.pages[0])
    expect((r.note as Record<string, unknown>).futureX).not.toBe((remote as Record<string, unknown>).futureX)
    expect(local.pages[0]!.lineage).toBeUndefined() // the new lineage is on the copy only
  })

  test('an unknown key named __proto__ is an own property, not the prototype', () => {
    const local = note([page('a', 'a1')])
    const remote = JSON.parse(
      '{"formatVersion":1,"noteId":"n","meta":{"title":"t","__proto__":{"x":1}},"metaRev":"m1","metaSeq":1,"orderRev":"o1","orderSeq":1,"pages":[],"__proto__":{"y":2}}',
    ) as Note
    const r = merge(null, local, remote, ctx)
    if (r.result !== 'merged') throw new Error('merged expected')
    expect(Object.getPrototypeOf(r.note)).toBe(Object.prototype)
    expect(Object.hasOwn(r.note, '__proto__')).toBe(true)
    expect(Object.hasOwn(r.note.meta, '__proto__')).toBe(true)
  })

  test('same input, same output', () => {
    const l = note([page('a', 'a2', 2)])
    const r = note([page('a', 'a3', 2)])
    const b = note([page('a', 'a1')])
    expect(merge(b, l, r, ctx)).toEqual(merge(b, l, r, ctx))
  })
})

describe('change queue (AD-16)', () => {
  test('strokes drawn while the download ran stay (remote changed another page)', () => {
    const base = note([page('a', 'a1'), page('b', 'b1')])
    const h = new History(base)
    const start = structuredClone(h.note)
    for (const s of ['s1', 's2', 's3']) edit(h, 'a', s) // during the network wait
    const remote = note([page('a', 'a1'), page('b', 'b2', 2)])
    const r = commitMerge(h, { base, localAtStart: start, remote, ctx })
    expect(r.result).toBe('merged')
    expect(pageOf(h.note, 'a').elements).toHaveLength(3)
    expect(pageOf(h.note, 'b').rev).toBe('b2')
    if (r.result === 'merged') expect(r.requeue.pages).toEqual(['a'])
  })

  test('strokes drawn while the download ran land in the sidecar when the remote changed the same page', () => {
    const base = note([page('a', 'a1')])
    const h = new History(base)
    const start = structuredClone(h.note)
    for (const s of ['s1', 's2', 's3']) edit(h, 'a', s)
    const remote = note([page('a', 'a9', 2, [stroke('theirs')])])
    const r = commitMerge(h, { base, localAtStart: start, remote, ctx })
    if (r.result !== 'merged') throw new Error('merged expected')
    expect(r.sidecars).toHaveLength(1)
    expect((r.sidecars[0]!.page.elements as { id: string }[]).map((e) => e.id)).toEqual(['s1', 's2', 's3'])
    expect(h.note.pages[0]!.rev).toBe('a9')
  })

  test('merging against the start state instead of the commit state would lose the strokes', () => {
    const base = note([page('a', 'a1')])
    const h = new History(base)
    const start = structuredClone(h.note)
    edit(h, 'a', 's1')
    const remote = note([page('a', 'a1'), page('c', 'c1')])
    const viaCommit = commitMerge(h, { base, localAtStart: start, remote, ctx })
    expect(viaCommit.result === 'merged' && pageOf(viaCommit.note, 'a').elements.length).toBe(1)
    const wrong = merge(base, start, remote, ctx)
    expect(wrong.result === 'merged' && pageOf(wrong.note, 'a').elements.length).toBe(0)
  })

  test('undo records of a page replaced by the remote are dropped; other pages still undo', () => {
    const base = note([page('a', 'a1'), page('b', 'b1')])
    const h = new History(base)
    const start = structuredClone(h.note)
    edit(h, 'a', 'sa')
    edit(h, 'b', 'sb')
    h.undo(opCtx('u1')) // sb undone: a redo record for b
    edit(h, 'a', 'sa2') // a fresh edit clears redo, so redo again below
    h.undo(opCtx('u1b'))
    const remote = note([page('a', 'a7', 5, [stroke('theirs')]), page('b', 'b1')])
    const r = commitMerge(h, { base: structuredClone(base), localAtStart: start, remote, ctx })
    expect(r.result).toBe('merged')
    expect(h.undoDepth).toBe(0) // every undo record was page a's
    expect(h.redoDepth).toBe(0) // and the redo record was page a's too
    expect(h.undo(opCtx('u2'))).toBeNull() // nothing to undo: a no-op
    expect(pageOf(h.note, 'a').elements).toHaveLength(1) // the other device's stroke was not undone
    edit(h, 'b', 'sb2') // another page keeps working
    expect(h.undoDepth).toBe(1)
    expect(h.undo(opCtx('u3'))).toBeNull()
    expect(pageOf(h.note, 'b').elements).toHaveLength(0)
  })

  test('records of a page the merge did not replace survive', () => {
    const base = note([page('a', 'a1'), page('b', 'b1')])
    const h = new History(base)
    const start = structuredClone(h.note)
    edit(h, 'a', 'sa')
    edit(h, 'b', 'sb')
    const remote = note([page('a', 'a1'), page('b', 'b1'), page('c', 'c1')])
    commitMerge(h, { base, localAtStart: start, remote, ctx })
    expect(h.undoDepth).toBe(2)
    const remote2 = note([page('a', 'a1'), page('b', 'b5', 4)])
    const r2 = commitMerge(h, { base, localAtStart: structuredClone(h.note), remote: remote2, ctx })
    expect(r2.result).toBe('merged')
    expect(h.undoDepth).toBe(1) // only page a's record is left
  })

  test('unsupportedVersion and errors leave the note and the history alone', () => {
    const base = note([page('a', 'a1')])
    const h = new History(base)
    edit(h, 'a', 's1')
    const before = structuredClone(h.note)
    const start = structuredClone(base)
    const bad = commitMerge(h, { base, localAtStart: start, remote: note([page('a', 'a1')], { formatVersion: 2 }), ctx })
    expect(bad).toEqual({ result: 'unsupportedVersion' })
    const mism = commitMerge(h, { base, localAtStart: start, remote: { ...note([]), noteId: 'other' }, ctx })
    expect(mism).toEqual({ error: 'noteIdMismatch' })
    expect(h.note).toEqual(before)
    expect(h.undoDepth).toBe(1)
  })

  test('Writer.applyMerge saves the merged note and refreshes undo availability', async () => {
    const base = note([page('a', 'a1')])
    const h = new History(base)
    const saved: Note[] = []
    const store = { writeNote: async (x: Note) => void saved.push(x), close: () => {} }
    let changes = 0
    const w = new Writer(h, store as never, () => ({ color: '#000000', width: 2, usePressure: false }) as never, () => {}, () => 'X', () => changes++)
    edit(h, 'a', 's1')
    expect(w.canUndo).toBe(true)
    const r = w.applyMerge({ base, localAtStart: base, remote: note([page('a', 'a7', 5)]), ctx })
    expect(r.result).toBe('merged')
    expect(w.canUndo).toBe(false) // aria-disabled follows
    expect(changes).toBe(1)
    await w.finalize()
    expect(saved.at(-1)!.pages[0]!.rev).toBe('a7')
  })

  test('Writer.applyMerge with an unsupported version changes and saves nothing', async () => {
    const base = note([page('a', 'a1')])
    const h = new History(base)
    const saved: Note[] = []
    const store = { writeNote: async (x: Note) => void saved.push(x), close: () => {} }
    let changes = 0
    const w = new Writer(h, store as never, () => ({}) as never, () => {}, () => 'X', () => changes++)
    edit(h, 'a', 's1')
    const r = w.applyMerge({ base, localAtStart: base, remote: note([], { formatVersion: 3 }), ctx })
    expect(r).toEqual({ result: 'unsupportedVersion' })
    expect(changes).toBe(0)
    expect(w.canUndo).toBe(true)
    await w.finalize()
    expect(saved).toHaveLength(0)
  })

  test('a closed editor keeps its session history in step', () => {
    clearSessionHistories()
    const base = note([page('a', 'a1')])
    const h = sessionHistory(base)
    edit(h, 'a', 's1')
    const merged = merge(base, h.note, note([page('a', 'a8', 3)]), ctx)
    if (merged.result !== 'merged') throw new Error('merged expected')
    applyMergeToSession('n', merged.note, merged.undoDrop)
    expect(sessionHistory(merged.note)).toBe(h)
    expect(h.undoDepth).toBe(0)
    clearSessionHistories()
  })
})

describe('mergeStep (for the uploader)', () => {
  const base = note([page('a', 'a1')])
  const local = note([page('a', 'a2', 2)])
  test('head equal to base still writes the lineage', () => {
    const r = mergeStep({ base, local, remote: { result: 'ok', writable: true, note: base }, ctx })
    if (r.result !== 'merged') throw new Error('merged expected')
    expect(r.note.pages[0]!.lineage).toEqual(['a1'])
    expect(r.conflicts).toEqual([])
  })
  test('unsupported head: no merge', () => {
    expect(mergeStep({ base, local, remote: { result: 'unsupportedVersion', writable: false }, ctx })).toEqual({ result: 'unsupportedVersion' })
  })
  test('unreadable head is a parse error', () => {
    expect(mergeStep({ base, local, remote: { result: 'unreadable', writable: false }, ctx })).toEqual({ error: 'parse' })
  })
  test('with localAtStart it reports the requeue', () => {
    const r = mergeStep({ base, local, localAtStart: base, remote: { result: 'ok', writable: true, note: base }, ctx })
    expect(r.result === 'merged' && r.requeue?.pages).toEqual(['a'])
  })
})

describe('resolve helpers', () => {
  test('page id namespace is the spec one and v5 matches node:crypto', () => {
    expect(PAGE_ID_NAMESPACE).toBe('b3a1f1a0-6f0e-4d57-9a53-5c1d2e7f9a10')
    expect(v5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d')
    const name = '페이지:한글'
    const h = createHash('sha1')
      .update(Buffer.from(PAGE_ID_NAMESPACE.replaceAll('-', ''), 'hex'))
      .update(name, 'utf8')
      .digest()
    h[6] = (h[6]! & 0x0f) | 0x50
    h[8] = (h[8]! & 0x3f) | 0x80
    const x = h.subarray(0, 16).toString('hex')
    expect(v5(name, PAGE_ID_NAMESPACE)).toBe(`${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`)
  })
  test('does not mutate its inputs', () => {
    const cur = note([page('a', 'a9', 3)])
    const side = page('a', 'a2', 2)
    const conflict = { pageId: 'a', kind: 'bothEdited' as const, rev: 'a2', theirsRev: 'a9', detectedAt: ctx.now, originalIndex: 0, resolvedAt: null }
    const sidecar = { noteId: 'n', pageId: 'a', rev: 'a2', seq: 2, editedAt: side.editedAt, editedBy: 'X', kind: 'bothEdited' as const, page: side }
    const snap = structuredClone([cur, conflict, sidecar])
    const r = resolveConflict(cur, conflict, sidecar, 'both', ctx)
    expect(r.result).toBe('resolved')
    expect(structuredClone([cur, conflict, sidecar])).toEqual(snap)
  })
})
