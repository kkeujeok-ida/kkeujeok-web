// How a merge reaches the working copy (open editor or store), the thumbnail renderer
// and the registry of open notes.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { renderThumbnail } from '../src/drive/thumbnail'
import { createMergeIo } from '../src/sync/mergeIo'
import { getOpenNote, openNoteIds, registerOpenNote } from '../src/sync/openNotes'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { NID, PA, PB, foreignEdit, mkNote, withStroke } from './uploadHarness'

afterEach(async () => {
  vi.unstubAllGlobals()
  await deleteNoteDatabase()
})

const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const mk = (store: ReturnType<typeof openNoteStore>, open?: Parameters<typeof createMergeIo>[0]['open']) =>
  createMergeIo({ store, editedBy: () => 'Chrome', now: () => '2026-10-12T04:20:00.000Z', newId: () => '01926f3a-0000-7000-8000-000000000001', ...(open && { open }) })

describe('mergeIo', () => {
  test('a closed note: the merged note is written to the store', async () => {
    const store = openNoteStore()
    await store.writeNote(withStroke(two(), PA, 'a2'))
    const r = await mk(store).merge({ noteId: NID, base: two(), remote: foreignEdit(two(), PB, 'b2') })
    expect(r).toEqual({ result: 'merged' })
    const n = (await store.loadNote(NID))!.note!
    expect(n.pages.map((p) => p.rev)).toEqual(['a2', 'b2'])
    store.close()
  })

  test('an open note: the editor applies the merge from its own note, then saves; the store is not written here', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    const local = withStroke(two(), PA, 'a2')
    const entry = {
      current: () => local,
      flush: vi.fn(async () => true),
      applyMerge: vi.fn((_a: { localAtStart: unknown }) => ({ result: 'merged' }) as never),
    }
    const write = vi.spyOn(store, 'writeNote')
    const r = await mk(store, () => entry).merge({ noteId: NID, base: two(), remote: foreignEdit(two(), PB, 'b2') })
    expect(r).toEqual({ result: 'merged' })
    expect(entry.applyMerge).toHaveBeenCalledTimes(1)
    expect(entry.applyMerge.mock.calls[0]![0].localAtStart).toBe(local)
    expect(entry.flush).toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    store.close()
  })

  test('a newer remote format and a missing working copy are reported, not applied', async () => {
    const store = openNoteStore()
    expect(await mk(store).merge({ noteId: NID, base: null, remote: two() })).toEqual({ result: 'error', reason: 'workingMissing' })
    await store.writeNote(two())
    const newer = { ...two(), formatVersion: 2 }
    expect(await mk(store).merge({ noteId: NID, base: two(), remote: newer })).toEqual({ result: 'unsupportedVersion' })
    store.close()
  })

  test('nothing changes: nothing is written', async () => {
    const store = openNoteStore()
    await store.writeNote(two())
    const write = vi.spyOn(store, 'writeNote')
    expect(await mk(store).merge({ noteId: NID, base: two(), remote: two() })).toEqual({ result: 'merged' })
    expect(write).not.toHaveBeenCalled()
    store.close()
  })
})

describe('open note registry', () => {
  test('register, look up, unregister; an old unregister does not remove a newer entry', () => {
    const a = { flush: async () => true, current: () => two(), applyMerge: vi.fn() }
    const b = { ...a }
    const offA = registerOpenNote('x', a as never)
    expect(getOpenNote('x')).toBe(a)
    const offB = registerOpenNote('x', b as never)
    offA()
    expect(getOpenNote('x')).toBe(b)
    expect(openNoteIds()).toContain('x')
    offB()
    expect(getOpenNote('x')).toBeUndefined()
  })
})

describe('renderThumbnail', () => {
  const page = () => mkNote().pages[0]!

  test('no canvas at all: null', async () => {
    expect(await renderThumbnail(page(), 300, 425)).toBeNull()
  })

  test('OffscreenCanvas: the page is drawn scaled to the width and the PNG bytes come back', async () => {
    const draws: unknown[] = []
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'scale' ? (x: number) => draws.push(x) : () => {}), set: () => true })
    class Off {
      constructor(public w: number, public h: number) {}
      getContext() {
        return ctx
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
      }
    }
    vi.stubGlobal('OffscreenCanvas', Off)
    const png = await renderThumbnail(page(), 300, 425)
    expect([...png!]).toEqual([137, 80, 78, 71])
    expect(draws[0]).toBeCloseTo(300 / 595)
  })

  test('a context or an encode that fails: null, never a throw', async () => {
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return null } })
    expect(await renderThumbnail(page(), 300, 425)).toBeNull()
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }) } async convertToBlob() { throw new Error('x') } })
    expect(await renderThumbnail(page(), 300, 425)).toBeNull()
  })
})
