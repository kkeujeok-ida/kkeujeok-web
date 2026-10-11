// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { encodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { createNote } from '../src/ops/ops'
import { NOTE_DB_NAME, deleteNoteDatabase } from '../src/storage/noteDb'
import { NoteSaveError, type NoteStore, openNoteStore } from '../src/storage/noteStore'

const mk = (noteId: string, title = 't'): Note => {
  const r = createNote({
    title,
    existingTitles: [],
    background: 'plain',
    orientation: 'portrait',
    noteId,
    pageId: 'p1',
    pageRev: 'r1',
    metaRev: 'm1',
    orderRev: 'o1',
    now: '2026-10-10T04:20:00.000Z',
    editedBy: 'Chrome, Windows',
  })
  if ('error' in r) throw new Error(r.error)
  return r.note
}
const A = mk('note-a', 'A')

// Puts raw bytes under a key, bypassing the store.
function putRaw(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOTE_DB_NAME, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('notes')
    r.onsuccess = () => {
      const db = r.result
      const tx = db.transaction('notes', 'readwrite')
      tx.objectStore('notes').put(value, key)
      tx.oncomplete = () => (db.close(), resolve())
      tx.onerror = () => reject(tx.error)
    }
  })
}

let store: NoteStore
beforeEach(() => {
  store = openNoteStore()
})
afterEach(async () => {
  store.close()
  await deleteNoteDatabase()
})

describe('noteStore', () => {
  test('save then load returns the equal note; missing is null; list has it', async () => {
    await store.writeNote(A)
    const r = await store.loadNote('note-a')
    expect(r).toMatchObject({ result: 'ok', writable: true, note: A })
    expect(await store.loadNote('nope')).toBeNull()
    expect((await store.listNotes()).map((n) => n.noteId)).toEqual(['note-a'])
  })

  test('an aborted write keeps the previous record', async () => {
    await store.writeNote(A)
    store.close()
    store = openNoteStore(indexedDB, { afterPut: (tx) => tx.abort() })
    const next = mk('note-a', 'B')
    await expect(store.writeNote(next)).rejects.toBeInstanceOf(NoteSaveError)
    store.close()
    store = openNoteStore()
    expect((await store.loadNote('note-a'))!.note!.meta.title).toBe('A')
    expect(next.meta.title).toBe('B')
  })

  test('quota failure rejects NoteSaveError with cause, note untouched', async () => {
    const quota = new DOMException('full', 'QuotaExceededError')
    store.close()
    store = openNoteStore(indexedDB, {
      afterPut: () => {
        throw quota
      },
    })
    const before = structuredClone(A)
    const err = (await store.writeNote(A).catch((e) => e)) as NoteSaveError
    expect(err).toBeInstanceOf(NoteSaveError)
    expect(err.cause).toBe(quota)
    expect(A).toEqual(before)
    expect(await store.loadNote('note-a')).toBeNull()
  })

  test('newer version and garbage are reported and never overwritten', async () => {
    const newer = new Uint8Array(await encodeKkj({ ...A, formatVersion: 2 } as Note))
    const garbage = new Uint8Array([1, 2, 3])
    const wrongId = await encodeKkj(mk('other'))
    await putRaw('note-a', newer)
    await putRaw('bad', garbage)
    await putRaw('mismatch', wrongId)
    expect(await store.loadNote('note-a')).toMatchObject({ result: 'unsupportedVersion', writable: false })
    expect(await store.loadNote('bad')).toMatchObject({ result: 'unreadable' })
    expect(await store.loadNote('mismatch')).toMatchObject({ result: 'unreadable' })
    const list = Object.fromEntries((await store.listNotes()).map((n) => [n.noteId, n.result.result]))
    expect(list).toEqual({ 'note-a': 'unsupportedVersion', bad: 'unreadable', mismatch: 'unreadable' })
    await expect(store.writeNote(A)).rejects.toBeInstanceOf(NoteSaveError)
    await expect(store.writeNote(mk('bad'))).rejects.toBeInstanceOf(NoteSaveError)
    expect(await store.loadNote('note-a')).toMatchObject({ result: 'unsupportedVersion' })
  })

  test('a second save over a readable record loads the new content', async () => {
    await store.writeNote(A)
    await store.writeNote(mk('note-a', 'B'))
    expect((await store.loadNote('note-a'))!.note!.meta.title).toBe('B')
  })

  test('a record changed between the check and the transaction rejects', async () => {
    await store.writeNote(A)
    const other = openNoteStore()
    store.close()
    store = openNoteStore(indexedDB, {
      afterCheck: () => other.writeNote(mk('note-a', 'OTHER')),
    })
    const err = (await store.writeNote(mk('note-a', 'MINE')).catch((e) => e)) as NoteSaveError
    expect(err).toBeInstanceOf(NoteSaveError)
    expect(err.message).toBe('record changed while saving')
    expect((await other.loadNote('note-a'))!.note!.meta.title).toBe('OTHER')
    other.close()
  })

  test('an invalid note is rejected and not persisted', async () => {
    const bad = structuredClone(A)
    bad.pages[0]!.width = Number.NaN
    await expect(store.writeNote(bad)).rejects.toBeInstanceOf(NoteSaveError)
    expect(await store.loadNote('note-a')).toBeNull()
  })

  test('versionchange closes the connection; delete completes; store reopens', async () => {
    await store.writeNote(A)
    localStorage.setItem('lang', 'en')
    await deleteNoteDatabase(indexedDB, 500)
    expect((await indexedDB.databases()).some((d) => d.name === NOTE_DB_NAME)).toBe(false)
    expect(localStorage.getItem('lang')).toBe('en')
    expect(await store.loadNote('note-a')).toBeNull()
    await store.writeNote(A)
    expect(await store.loadNote('note-a')).toMatchObject({ result: 'ok' })
  })
})

