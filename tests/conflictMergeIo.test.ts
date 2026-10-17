// Story 3.20: how a merge that raised conflicts reaches the working copy. A closed note: one guarded
// transaction. An open note: sidecars + sync.json first, then the editor applies exactly what was recorded.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { sessionHistory } from '../src/ops/sessionHistories'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { NoteSaveError, openNoteStore } from '../src/storage/noteStore'
import { createMergeIo } from '../src/sync/mergeIo'
import type { OpenNote } from '../src/sync/openNotes'
import { NID, PA, PB, foreignEdit, mkNote, withStroke } from './uploadHarness'

afterEach(async () => {
  clearSessionHistories()
  await deleteNoteDatabase()
})

const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const remote = () => foreignEdit(foreignEdit(two(), PA, 'a3'), PB, 'b3')
const mk = (store: ReturnType<typeof openNoteStore>, open?: (id: string) => OpenNote | undefined) =>
  createMergeIo({ store, editedBy: () => 'Chrome', now: () => '2026-10-12T04:20:00.000Z', newId: () => '01926f3a-0000-7000-8000-000000000001', ...(open && { open }) })

describe('closed note', () => {
  test('one transaction: the merged note, the sidecar record and the entry; the session history follows', async () => {
    const store = openNoteStore()
    await store.writeNote(withStroke(two(), PA, 'a2'))
    const h = sessionHistory((await store.loadNote(NID))!.note!)
    const commit = vi.spyOn(store, 'commitMerge')
    const r = await mk(store).merge({ noteId: NID, base: two(), remote: remote() })
    expect(r).toEqual({ result: 'merged', conflicts: ['a2'] })
    expect(commit).toHaveBeenCalledTimes(1)
    const w = (await store.loadNote(NID))!.note!
    expect(w.pages.map((p) => p.rev)).toEqual(['a3', 'b3'])
    expect(h.note).toEqual(w)
    expect((await store.sidecars.get(NID, PA, 'a2'))!.page.rev).toBe('a2')
    expect((await store.readSync(NID)).info.conflicts).toHaveLength(1)
    store.close()
  })

  test('the working copy moved under the merge: it is read and merged again, never overwritten from the old snapshot', async () => {
    const store = openNoteStore()
    await store.writeNote(withStroke(two(), PA, 'a2'))
    const spy = vi.spyOn(store, 'commitMerge').mockImplementationOnce(async () => {
      await store.writeNote(withStroke(two(), PA, 'a5')) // another writer got in first
      return false
    })
    const r = await mk(store).merge({ noteId: NID, base: two(), remote: remote() })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ result: 'merged', conflicts: ['a5'] }) // the second try merged from the NEW working copy
    expect((await store.sidecars.get(NID, PA, 'a5'))).not.toBeNull()
    expect((await store.sidecars.get(NID, PA, 'a2'))).toBeNull()
    store.close()
  })

  test('a working copy that keeps moving: an error after three tries, nothing written', async () => {
    const store = openNoteStore()
    await store.writeNote(withStroke(two(), PA, 'a2'))
    const spy = vi.spyOn(store, 'commitMerge').mockResolvedValue(false)
    expect(await mk(store).merge({ noteId: NID, base: two(), remote: remote() })).toEqual({ result: 'error', reason: 'workingMoved' })
    expect(spy).toHaveBeenCalledTimes(3)
    expect((await store.readSync(NID)).info.conflicts).toEqual([])
    expect((await store.loadNote(NID))!.note!.pages[0]!.rev).toBe('a2')
    store.close()
  })

  test('a failing write is not swallowed', async () => {
    const store = openNoteStore()
    await store.writeNote(withStroke(two(), PA, 'a2'))
    vi.spyOn(store, 'commitMerge').mockRejectedValue(new NoteSaveError('quota'))
    await expect(mk(store).merge({ noteId: NID, base: two(), remote: remote() })).rejects.toBeInstanceOf(NoteSaveError)
    store.close()
  })

  test('no conflict: the merged note is written through the same guarded transaction', async () => {
    const store = openNoteStore()
    await store.writeNote(withStroke(two(), PA, 'a2'))
    const commit = vi.spyOn(store, 'commitMerge')
    expect(await mk(store).merge({ noteId: NID, base: two(), remote: foreignEdit(two(), PB, 'b3') })).toEqual({ result: 'merged' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect((await store.readSync(NID)).info.conflicts).toEqual([])
    store.close()
  })
})

describe('open note', () => {
  /** An editor stand-in that logs the order of the calls MergeIo makes. */
  function editor(store: ReturnType<typeof openNoteStore>, o: { local?: () => ReturnType<typeof two>; stale?: number; ended?: string | null } = {}) {
    const log: string[] = []
    let stale = o.stale ?? 0
    const applyArgs: { expect?: readonly string[]; held?: string | null }[] = []
    const entry: OpenNote = {
      flush: vi.fn(async () => (log.push('flush'), true)),
      current: vi.fn(() => (log.push('current'), (o.local ?? (() => withStroke(two(), PA, 'a2')))())),
      strokeEnd: vi.fn(async () => (log.push('strokeEnd'), o.ended ?? null)),
      applyMerge: vi.fn((a) => {
        log.push('apply')
        applyArgs.push({ expect: a.expect, held: a.held })
        return stale-- > 0 ? { result: 'stale' as const } : ({ result: 'merged' } as never)
      }),
    }
    const rec = store.recordConflicts.bind(store)
    vi.spyOn(store, 'recordConflicts').mockImplementation(async (id, r) => {
      const added = await rec(id, r)
      log.push('recorded')
      return added
    })
    return { entry, log, applyArgs }
  }

  test('the sidecar and the entry are durable BEFORE the editor applies the merge; it applies exactly what was recorded', async () => {
    const store = openNoteStore()
    await store.writeNote(withStroke(two(), PA, 'a2'))
    const e = editor(store, { ended: PA })
    const r = await mk(store, () => e.entry).merge({ noteId: NID, base: two(), remote: remote() })
    expect(r).toEqual({ result: 'merged', conflicts: ['a2'] })
    expect(e.log).toEqual(['current', 'strokeEnd', 'current', 'recorded', 'apply', 'flush'])
    expect(e.applyArgs).toEqual([{ expect: [`${PA}:a2`], held: PA }])
    expect((await store.readSync(NID)).info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a2' }])
    expect(await store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
    // the working copy is the editor's to save, not written here
    expect((await store.loadNote(NID))!.note!.pages[0]!.rev).toBe('a2')
    store.close()
  })

  test('a stroke in progress is awaited first: the version that is kept is read AFTER it, so the stroke is in the sidecar', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    let local = withStroke(two(), PA, 'a2')
    const e = editor(store, { local: () => local })
    e.entry.strokeEnd = vi.fn(async () => {
      e.log.push('strokeEnd')
      local = withStroke(two(), PA, 'a2-with-stroke') // the pointer went up
      return PA
    })
    await mk(store, () => e.entry).merge({ noteId: NID, base: two(), remote: remote() })
    expect(e.log.indexOf('strokeEnd')).toBeLessThan(e.log.lastIndexOf('current'))
    expect(e.log.at(-3)).toBe('recorded') // after the wait the merge is recorded with the stroke in
    const sc = await store.sidecars.get(NID, PA, 'a2-with-stroke')
    expect(sc!.page.elements).toHaveLength(1)
    store.close()
  })

  test('the editor moved (stale): what was recorded is replaced by the next try; no leftover sidecar', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    let n = 0
    const e = editor(store, { local: () => withStroke(two(), PA, ++n === 1 ? 'a2' : 'a5'), stale: 1 })
    const r = await mk(store, () => e.entry).merge({ noteId: NID, base: two(), remote: remote() })
    expect(r).toEqual({ result: 'merged', conflicts: ['a5'] })
    expect(e.log.filter((x) => x === 'apply')).toHaveLength(2)
    expect(await store.sidecars.get(NID, PA, 'a2')).toBeNull()
    expect(await store.sidecars.get(NID, PA, 'a5')).not.toBeNull()
    const info = (await store.readSync(NID)).info
    expect(info.conflicts.map((c) => c.rev)).toEqual(['a5'])
    expect(info.unsentSidecars.map((u) => u.rev)).toEqual(['a5'])
    store.close()
  })

  test('always stale: an error after three tries; the recorded sidecar stays (nothing is lost)', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    const e = editor(store, { stale: 99 })
    expect(await mk(store, () => e.entry).merge({ noteId: NID, base: two(), remote: remote() })).toEqual({ result: 'error', reason: 'applyFailed' })
    expect(e.entry.applyMerge).toHaveBeenCalledTimes(3)
    expect(await store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
    expect(e.entry.flush).not.toHaveBeenCalled()
    store.close()
  })

  test('when the sidecar cannot be made durable the editor never applies the merge', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    const e = editor(store)
    vi.spyOn(store, 'recordConflicts').mockRejectedValue(new NoteSaveError('quota'))
    await expect(mk(store, () => e.entry).merge({ noteId: NID, base: two(), remote: remote() })).rejects.toBeInstanceOf(NoteSaveError)
    expect(e.entry.applyMerge).not.toHaveBeenCalled()
    store.close()
  })

  test('no conflict: the merge does not wait for a stroke, no record is written and the editor gets no `expect`', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    const e = editor(store)
    const rec = vi.spyOn(store, 'recordConflicts')
    expect(await mk(store, () => e.entry).merge({ noteId: NID, base: two(), remote: foreignEdit(two(), PB, 'b3') })).toEqual({ result: 'merged' })
    expect(rec).not.toHaveBeenCalled()
    expect(e.entry.strokeEnd).not.toHaveBeenCalled()
    expect(e.applyArgs).toEqual([{ expect: undefined, held: undefined }])
    store.close()
  })

  test('an editor without strokeEnd (older stand-in) still merges', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    const e = editor(store)
    delete e.entry.strokeEnd
    expect(await mk(store, () => e.entry).merge({ noteId: NID, base: two(), remote: remote() })).toEqual({ result: 'merged', conflicts: ['a2'] })
    store.close()
  })
})
