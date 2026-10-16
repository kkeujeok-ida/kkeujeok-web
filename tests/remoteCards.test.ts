// The `remote` store: cards of notes not downloaded yet (Story 3.14).
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { REMOTE_STORE, deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { createRemoteCardStore } from '../src/storage/remoteCards'

const card = { noteId: 'n1', fileId: 'f1', headRevisionId: 'r1', title: '수학', folderId: null, coverId: 'c', modifiedAt: '2026-10-10T04:20:00.000Z' }
const ndb = openNoteDb()
const store = createRemoteCardStore(ndb)
afterEach(async () => {
  ndb.close()
  await deleteNoteDatabase()
})

describe('remote cards', () => {
  test('put, get, list, delete', async () => {
    expect(await store.list()).toEqual([])
    await store.put(card)
    await store.put({ ...card, noteId: 'n2', title: 'b', coverId: null })
    expect(await store.get('n1')).toEqual(card)
    expect((await store.list()).map((c) => c.noteId).sort()).toEqual(['n1', 'n2'])
    await store.delete('n1')
    expect(await store.get('n1')).toBeNull()
    expect(await store.list()).toHaveLength(1)
  })

  test('a malformed row is skipped, never deleted', async () => {
    await ndb.withDb((db) => db.put(REMOTE_STORE, { fileId: 5 }, 'bad'))
    await store.put(card)
    expect((await store.list()).map((c) => c.noteId)).toEqual(['n1'])
    expect(await store.get('bad')).toBeNull()
    expect(await ndb.withDb((db) => db.get(REMOTE_STORE, 'bad'))).toEqual({ fileId: 5 })
  })
})
