// @vitest-environment jsdom
// Story 3.20: the store side of a conflict: sidecars -> sync.json -> working copy in ONE transaction,
// guarded on the stored working copy; the sidecar leaves the device only with its list entry.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { NOTE_DB_NAME, SIDECAR_STORE, deleteNoteDatabase } from '../src/storage/noteDb'
import { NoteSaveError, SYNC_UNREADABLE, type NoteStore, openNoteStore } from '../src/storage/noteStore'
import type { Conflict, Sidecar } from '../src/sync/merge'
import { NID, PA, PB, mkNote, withStroke } from './uploadHarness'

const conf = (pageId: string, rev: string, o: Partial<Conflict> = {}): Conflict => ({
  pageId, kind: 'bothEdited', rev, theirsRev: 't1', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null, ...o,
})
const side = (pageId: string, rev: string): Sidecar => ({
  noteId: NID, pageId, rev, seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'Chrome, Windows', kind: 'bothEdited', page: mkNote().pages[0]!,
})
const rec = (pageId = PA, rev = 'a2') => ({ conflicts: [conf(pageId, rev)], sidecars: [side(pageId, rev)] })
const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })

function raw<T>(store: string, key: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOTE_DB_NAME)
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const q = r.result.transaction(store).objectStore(store).get(key)
      q.onsuccess = () => (r.result.close(), resolve(q.result as T))
      q.onerror = () => reject(q.error)
    }
  })
}
function rawPut(store: string, key: string, value: unknown): Promise<void> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(NOTE_DB_NAME)
    r.onsuccess = () => {
      const tx = r.result.transaction(store, 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => (r.result.close(), res())
      tx.onerror = () => rej(tx.error)
    }
  })
}
const skey = (pageId: string, rev: string) => JSON.stringify([NID, pageId, rev])

let store: NoteStore
let puts: string[]
beforeEach(async () => {
  puts = []
  store = openNoteStore(indexedDB, { afterPut: (_tx, s) => void puts.push(s) })
  await store.writeNote(two())
  puts.length = 0
})
afterEach(async () => {
  store.close()
  await deleteNoteDatabase()
})

describe('commitMerge', () => {
  test('writes sidecars, then sync.json, then the working copy, in one transaction', async () => {
    const merged = withStroke(two(), PB, 'b2')
    expect(await store.commitMerge(NID, two(), merged, rec())).toBe(true)
    expect(puts).toEqual([SIDECAR_STORE, 'sync', 'notes'])
    expect((await store.loadNote(NID))!.note).toEqual(merged)
    const s = await store.readSync(NID)
    expect(s.info.conflicts).toEqual([conf(PA, 'a2')])
    expect(s.info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a2' }])
    expect(await store.sidecars.get(NID, PA, 'a2')).toEqual(side(PA, 'a2'))
  })

  test('all or nothing: a failing working-copy write leaves the sidecar, the list and the note as they were', async () => {
    store.close()
    store = openNoteStore(indexedDB, {
      afterPut: (_tx, s) => {
        if (s === 'notes') throw new Error('quota')
      },
    })
    await expect(store.commitMerge(NID, two(), withStroke(two(), PB, 'b2'), rec())).rejects.toBeInstanceOf(NoteSaveError)
    expect(await raw(SIDECAR_STORE, skey(PA, 'a2'))).toBeUndefined()
    expect(await raw('sync', NID)).toBeUndefined()
    expect((await store.loadNote(NID))!.note).toEqual(two())
  })

  test('only while the stored working copy is the one merged from; otherwise false and nothing is written', async () => {
    await store.writeNote(withStroke(two(), PA, 'a5')) // the working copy moved after the merge read it
    puts.length = 0
    expect(await store.commitMerge(NID, two(), withStroke(two(), PB, 'b2'), rec())).toBe(false)
    expect(puts).toEqual([])
    expect(await store.sidecars.get(NID, PA, 'a2')).toBeNull()
    expect((await store.readSync(NID)).info.conflicts).toEqual([])
    expect((await store.loadNote(NID))!.note!.pages[0]!.rev).toBe('a5')
  })

  test('a note that is not here is false', async () => {
    const other = mkNote({ noteId: '01926f3a-0000-7000-8000-0000000000ff' })
    expect(await store.commitMerge(other.noteId, other, other, rec())).toBe(false)
    expect(puts).toEqual([])
  })

  test('a merged note of another id is refused', async () => {
    const other = mkNote({ noteId: '01926f3a-0000-7000-8000-0000000000ff' })
    await expect(store.commitMerge(NID, two(), other, rec())).rejects.toBeInstanceOf(NoteSaveError)
  })

  test('without conflicts only the working copy is written (no sync record is invented)', async () => {
    expect(await store.commitMerge(NID, two(), withStroke(two(), PB, 'b2'), { conflicts: [], sidecars: [] })).toBe(true)
    expect(puts).toEqual(['notes'])
    expect(await raw('sync', NID)).toBeUndefined()
  })

  test('an unreadable sync record is never overwritten: rejected, nothing written', async () => {
    await rawPut('sync', NID, { state: 'bogus' })
    await expect(store.commitMerge(NID, two(), withStroke(two(), PB, 'b2'), rec())).rejects.toThrow(SYNC_UNREADABLE)
    expect(await raw('sync', NID)).toEqual({ state: 'bogus' })
    expect((await store.loadNote(NID))!.note).toEqual(two())
  })

  test('a second conflict of the same page keeps the first entry (one unresolved entry per page)', async () => {
    await store.commitMerge(NID, two(), two(), rec(PA, 'a2'))
    await store.commitMerge(NID, two(), two(), { conflicts: [conf(PA, 'a9', { theirsRev: 't2' })], sidecars: [side(PA, 'a9')] })
    const s = await store.readSync(NID)
    expect(s.info.conflicts).toEqual([conf(PA, 'a2', { theirsRev: 't2' })])
    expect(await store.sidecars.get(NID, PA, 'a9')).toBeNull()
  })
})

describe('recordConflicts', () => {
  test('sidecars and the sync record in one transaction, the working copy untouched; returns what it added', async () => {
    const added = await store.recordConflicts(NID, rec())
    expect(puts).toEqual([SIDECAR_STORE, 'sync'])
    expect(added.sidecars).toEqual([{ pageId: PA, rev: 'a2' }])
    expect((await store.loadNote(NID))!.note).toEqual(two())
    expect((await store.readSync(NID)).info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a2' }])
  })

  test('supersedes removes the record and the entry of the earlier try', async () => {
    const first = await store.recordConflicts(NID, rec(PA, 'a2'))
    await store.recordConflicts(NID, { ...rec(PA, 'a3'), supersedes: first })
    expect(await store.sidecars.get(NID, PA, 'a2')).toBeNull()
    expect(await store.sidecars.get(NID, PA, 'a3')).not.toBeNull()
    const info = (await store.readSync(NID)).info
    expect(info.conflicts.map((c) => c.rev)).toEqual(['a3'])
    expect(info.unsentSidecars.map((u) => u.rev)).toEqual(['a3'])
  })

  test('a note without a record is an error and nothing is written', async () => {
    await expect(store.recordConflicts('01926f3a-0000-7000-8000-0000000000ff', rec())).rejects.toBeInstanceOf(NoteSaveError)
  })
})

describe('sidecarSent', () => {
  test('the list entry and the record leave together; the conflict entry stays until it is resolved', async () => {
    await store.recordConflicts(NID, rec())
    await store.sidecarSent(NID, PA, 'a2')
    expect((await store.readSync(NID)).info.unsentSidecars).toEqual([])
    expect(await store.sidecars.get(NID, PA, 'a2')).toBeNull()
    expect((await store.readSync(NID)).info.conflicts).toHaveLength(1)
  })

  test('a failing write keeps both', async () => {
    await store.recordConflicts(NID, rec())
    store.close()
    store = openNoteStore(indexedDB, {
      afterPut: (_tx, s) => {
        if (s === 'sync') throw new Error('quota')
      },
    })
    await expect(store.sidecarSent(NID, PA, 'a2')).rejects.toBeInstanceOf(NoteSaveError)
    expect(await store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
    expect((await store.readSync(NID)).info.unsentSidecars).toHaveLength(1)
  })

  test('the record of another note or a garbage record is not returned', async () => {
    await store.recordConflicts(NID, rec())
    expect(await store.sidecars.get('other', PA, 'a2')).toBeNull()
    await rawPut(SIDECAR_STORE, skey(PA, 'bad'), { junk: true })
    expect(await store.sidecars.get(NID, PA, 'bad')).toBeNull()
  })
})

describe('removeNote', () => {
  test('takes every sidecar record of the note along, not those of another note', async () => {
    await store.recordConflicts(NID, rec())
    await rawPut(SIDECAR_STORE, JSON.stringify(['other-note', PA, 'a2']), side(PA, 'a2'))
    expect(await store.removeNote(NID, two())).toBe(true)
    expect(await store.sidecars.get(NID, PA, 'a2')).toBeNull()
    expect(await raw(SIDECAR_STORE, JSON.stringify(['other-note', PA, 'a2']))).toBeTruthy()
  })
})
