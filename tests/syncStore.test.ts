// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { encodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { createNote } from '../src/ops/ops'
import { NOTE_DB_NAME, deleteNoteDatabase } from '../src/storage/noteDb'
import { NoteSaveError, type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { type SyncInfo, emptySync } from '../src/storage/syncInfo'

const mk = (noteId: string, rev = 'r1', title = 't'): Note => {
  const r = createNote({
    title,
    existingTitles: [],
    background: 'plain',
    orientation: 'portrait',
    noteId,
    pageId: 'p1',
    pageRev: rev,
    metaRev: 'm1',
    orderRev: 'o1',
    now: '2026-10-10T04:20:00.000Z',
    editedBy: 'Chrome, Windows',
  })
  if ('error' in r) throw new Error(r.error)
  return r.note
}
const N = 'note-a'
const synced = (id = 'rev1'): SyncInfo => ({ ...emptySync(), fileId: 'f1', baseHeadRevisionId: id, state: 'synced' })

// Direct access to the stores, bypassing NoteStore. The DB must exist already.
function raw<T>(fn: (db: IDBDatabase) => Promise<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOTE_DB_NAME)
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const db = r.result
      Promise.resolve(fn(db)).then(
        (v) => (db.close(), resolve(v)),
        (e) => (db.close(), reject(e)),
      )
    }
  })
}
const rawGet = (store: string, key: string) =>
  raw(
    (db) =>
      new Promise<unknown>((res, rej) => {
        const q = db.transaction(store).objectStore(store).get(key)
        q.onsuccess = () => res(q.result)
        q.onerror = () => rej(q.error)
      }),
  )
const rawPut = (store: string, key: string, value: unknown) =>
  raw(
    (db) =>
      new Promise<void>((res, rej) => {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).put(value, key)
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }),
  )
// Everything the three stores hold for the note.
const snapshot = async () =>
  JSON.stringify([await rawGet('notes', N), await rawGet('base', N), await rawGet('sync', N)].map((v) => (v instanceof Uint8Array ? [...v] : v)))

let store: NoteStore
const reopen = (opts: Parameters<typeof openNoteStore>[1] = {}) => {
  store.close()
  store = openNoteStore(indexedDB, opts)
}
beforeEach(async () => {
  store = openNoteStore()
  await store.loadNote('init') // creates the DB
})
afterEach(async () => {
  store.close()
  await deleteNoteDatabase()
})

describe('db upgrade', () => {
  test('a version-1 DB with a note opens as version 4, the record is identical, the sync, remote and sidecar stores exist', async () => {
    store.close()
    await deleteNoteDatabase()
    const bytes = await encodeKkj(mk(N))
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(NOTE_DB_NAME, 1)
      r.onupgradeneeded = () => r.result.createObjectStore('notes').put(bytes, N)
      r.onsuccess = () => (r.result.close(), resolve())
      r.onerror = () => reject(r.error)
    })
    store = openNoteStore()
    expect((await store.loadNote(N))!.note).toEqual(mk(N))
    const [version, names] = await raw((db) => [db.version, [...db.objectStoreNames].sort()] as const)
    expect(version).toBe(5)
    expect(names).toEqual(['assets', 'base', 'device', 'notes', 'remote', 'sidecars', 'sync'])
    expect([...((await rawGet('notes', N)) as Uint8Array)]).toEqual([...bytes])
  })
})

describe('readSync', () => {
  test('Epic 2 note (working only): pending, unsent, no base', async () => {
    await store.writeNote(mk(N))
    const r = await store.readSync(N)
    expect(r).toMatchObject({ state: 'pending', hasUnsent: true, base: null })
    expect(r.info).toEqual(emptySync())
  })

  test('writeNote only touches notes: base and sync unchanged', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    const before = [await rawGet('base', N), await rawGet('sync', N)]
    await store.writeNote(mk(N, 'r2'))
    expect([await rawGet('base', N), await rawGet('sync', N)]).toEqual(before)
    const r = await store.readSync(N)
    expect(r.hasUnsent).toBe(true) // page rev differs from the base
    expect(r.state).toBe('pending') // stored synced, but unsent
  })

  test('commitSync of equal working and base reads synced and not unsent; survives a reload', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    reopen()
    const r = await store.readSync(N)
    expect(r).toMatchObject({ state: 'synced', hasUnsent: false })
    expect(r.base).toEqual(mk(N))
    expect(r.info.baseHeadRevisionId).toBe('rev1')
  })

  test('unfinished pendingVerify or an unsent sidecar is unsent', async () => {
    const pv = { ...synced(), pendingVerify: { parentRevisionId: 'a', oursRevisionId: null, round: 1 } }
    await store.commitSync(mk(N), mk(N), pv)
    expect((await store.readSync(N)).hasUnsent).toBe(true)
    await store.commitSync(mk(N), mk(N), { ...synced('rev2'), unsentSidecars: [{ pageId: 'p1', rev: 'x' }] })
    expect((await store.readSync(N)).hasUnsent).toBe(true)
  })

  test('corrupt sync records read as absent and are not deleted', async () => {
    await store.writeNote(mk(N))
    const bad: unknown[] = [
      'text',
      [],
      { state: 'dirty' },
      { state: 'pending', pendingVerify: { parentRevisionId: null, oursRevisionId: null, round: 4 } },
      { state: 'pending', lastError: { class: 'fatal', status: 99 } },
      { state: 'pending', lastError: { class: 'fatal', status: 600 } },
      { state: 'pending', conflicts: 'x' },
      { state: 'pending', baseHeadRevisionId: 'has space' },
    ]
    for (const b of bad) {
      await rawPut('sync', N, b)
      const r = await store.readSync(N)
      expect(r).toMatchObject({ state: 'pending', hasUnsent: true, base: null })
      expect(r.info).toEqual(emptySync())
      expect(await rawGet('sync', N)).toEqual(b)
    }
  })

  test('an unreadable working copy is unsent and pending, whatever sync says', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    const newer = new Uint8Array(await encodeKkj({ ...mk(N), formatVersion: 2 } as Note))
    const other = new Uint8Array(await encodeKkj(mk('other')))
    for (const bytes of [new Uint8Array([1, 2, 3]), newer, other, undefined]) {
      if (bytes) await rawPut('notes', N, bytes)
      else await raw((db) => void db.transaction('notes', 'readwrite').objectStore('notes').delete(N))
      await new Promise((r) => setTimeout(r, 5))
      expect(await store.readSync(N)).toMatchObject({ state: 'pending', hasUnsent: true })
    }
  })

  test('base is read only when baseHeadRevisionId is set; an unreadable base counts as none; reading writes nothing', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    expect((await store.readSync(N)).base).not.toBeNull()
    await rawPut('base', N, new Uint8Array([9, 9]))
    const before = await snapshot()
    const r = await store.readSync(N)
    expect(r.base).toBeNull()
    expect(r.hasUnsent).toBe(true)
    expect(await snapshot()).toBe(before)
    // no id: a stored base is ignored
    await rawPut('sync', N, { ...synced(), baseHeadRevisionId: null })
    expect((await store.readSync(N)).base).toBeNull()
  })

  test('never throws, even when the DB cannot be opened', async () => {
    const broken = { open: () => { throw new Error('no idb') } } as unknown as IDBFactory
    const s = openNoteStore(broken)
    expect(await s.readSync(N)).toMatchObject({ state: 'pending', hasUnsent: true, base: null })
  })
})

describe('commitSync', () => {
  test('one transaction over notes, base, sync, in that order', async () => {
    const seen: { tx: unknown; store: string }[] = []
    reopen({ afterPut: (tx, s) => void seen.push({ tx, store: s }) })
    await store.commitSync(mk(N), mk(N), synced())
    expect(seen.map((s) => s.store)).toEqual(['notes', 'base', 'sync'])
    expect(new Set(seen.map((s) => s.tx)).size).toBe(1)
  })

  test.each(['notes', 'base', 'sync'])('an abort after the %s put leaves all three as before', async (step) => {
    await store.commitSync(mk(N), mk(N), synced('rev1'))
    const before = await snapshot()
    reopen({ afterPut: (tx, s) => void (s === step && tx.abort()) })
    const next = mk(N, 'r2', 'changed')
    await expect(store.commitSync(next, mk(N, 'r2', 'changed'), synced('rev2'))).rejects.toBeInstanceOf(NoteSaveError)
    expect(await snapshot()).toBe(before)
  })

  test('first commit that aborts leaves no orphan in any store', async () => {
    reopen({ afterPut: (tx, s) => void (s === 'sync' && tx.abort()) })
    await expect(store.commitSync(mk(N), mk(N), synced())).rejects.toBeInstanceOf(NoteSaveError)
    expect(await snapshot()).toBe(JSON.stringify([null, null, null].map(() => undefined)))
  })

  test('invalid group input writes nothing and rejects NoteSaveError', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    const before = await snapshot()
    const w = mk(N, 'r2')
    const cases: [string, () => Promise<void>][] = [
      ['bad id', () => store.commitSync(w, mk(N), synced('has space'))],
      ['id too long', () => store.commitSync(w, mk(N), synced('a'.repeat(201)))],
      ['base without id', () => store.commitSync(w, mk(N), { ...emptySync() })],
      ['base of another note', () => store.commitSync(w, mk('other'), synced('rev2'))],
      ['invalid sync info', () => store.commitSync(w, mk(N), { ...synced('rev2'), state: 'dirty' as never })],
    ]
    for (const [name, run] of cases) {
      await expect(run(), name).rejects.toBeInstanceOf(NoteSaveError)
      expect(await snapshot(), name).toBe(before)
    }
  })

  test('an id with no base given and none stored rejects; with a stored base it keeps it', async () => {
    await expect(store.commitSync(mk(N), null, synced())).rejects.toBeInstanceOf(NoteSaveError)
    expect(await rawGet('sync', N)).toBeUndefined()
    await store.commitSync(mk(N), mk(N), synced('rev1'))
    await store.commitSync(mk(N, 'r2'), null, synced('rev1'))
    expect((await store.readSync(N)).base).toEqual(mk(N))
  })

  test('an unreadable existing working copy is never overwritten', async () => {
    await rawPut('notes', 'bad', new Uint8Array([1, 2, 3]))
    await expect(store.commitSync(mk('bad'), mk('bad'), synced())).rejects.toBeInstanceOf(NoteSaveError)
    expect(await rawGet('sync', 'bad')).toBeUndefined()
    expect([...((await rawGet('notes', 'bad')) as Uint8Array)]).toEqual([1, 2, 3])
  })

  test('a record changed between the check and the transaction rejects', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    const other = openNoteStore()
    reopen({ afterCheck: () => other.writeNote(mk(N, 'rX')) })
    await expect(store.commitSync(mk(N, 'r2'), mk(N), synced('rev2'))).rejects.toThrow('record changed while saving')
    other.close()
  })

  test('onWrite runs after a success; its failure is swallowed; not after a failure', async () => {
    const onWrite = vi.fn(() => {
      throw new Error('boom')
    })
    reopen({ onWrite })
    await store.commitSync(mk(N), mk(N), synced())
    await store.writeNote(mk(N, 'r2'))
    expect(onWrite).toHaveBeenCalledTimes(2)
    await expect(store.commitSync(mk(N), mk(N), synced('bad id'))).rejects.toBeInstanceOf(NoteSaveError)
    expect(onWrite).toHaveBeenCalledTimes(2)
  })
})

describe('updateSync and resetSync', () => {
  test('keeps unknown keys of sync, writes them back', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    await rawPut('sync', N, { ...(await rawGet('sync', N) as object), futureKey: { a: 1 } })
    const r = await store.updateSync(N, (c) => ({ ...c, state: 'syncing' }))
    expect(r.extra).toEqual({ futureKey: { a: 1 } })
    expect(await rawGet('sync', N)).toMatchObject({ futureKey: { a: 1 }, state: 'syncing' })
  })

  test('works from the record read under the lock: concurrent updates all land', async () => {
    await store.commitSync(mk(N), mk(N), synced())
    await Promise.all(
      [1, 2, 3].map((i) =>
        store.updateSync(N, (c) => ({ ...c, conflicts: [...c.conflicts, { pageId: `p${i}`, rev: 'x', resolvedAt: null }] })),
      ),
    )
    expect((await store.readSync(N)).info.conflicts).toHaveLength(3)
  })

  test('an unreadable sync record is never replaced by an empty one', async () => {
    await store.writeNote(mk(N))
    await rawPut('sync', N, 'garbage')
    await expect(store.updateSync(N, (c) => c)).rejects.toBeInstanceOf(NoteSaveError)
    expect(await rawGet('sync', N)).toBe('garbage')
  })

  test('resetSync on an unreadable sync record throws and keeps it', async () => {
    await store.writeNote(mk(N))
    await rawPut('sync', N, 'garbage')
    await expect(store.resetSync(N)).rejects.toThrow('the sync record is unreadable')
    expect(await rawGet('sync', N)).toBe('garbage')
  })

  test('a new base is written with its id; abort after the base put leaves both as before', async () => {
    await store.commitSync(mk(N), mk(N), synced('rev1'))
    const before = await snapshot()
    reopen({ afterPut: (tx, s) => void (s === 'base' && tx.abort()) })
    await expect(
      store.updateSync(N, (c) => ({ ...c, baseHeadRevisionId: 'rev2' }), { base: mk(N, 'r2') }),
    ).rejects.toBeInstanceOf(NoteSaveError)
    expect(await snapshot()).toBe(before)
    reopen()
    await store.updateSync(N, (c) => ({ ...c, baseHeadRevisionId: 'rev2' }), { base: mk(N, 'r2') })
    expect((await store.readSync(N)).base).toEqual(mk(N, 'r2'))
  })

  test('validation: bad id, base without id, base of another note, id without a stored base', async () => {
    await store.writeNote(mk(N))
    const before = await snapshot()
    const bad = [
      () => store.updateSync(N, (c) => ({ ...c, baseHeadRevisionId: 'a b' }), { base: mk(N) }),
      () => store.updateSync(N, (c) => c, { base: mk(N) }),
      () => store.updateSync(N, (c) => ({ ...c, baseHeadRevisionId: 'rev9' }), { base: mk('other') }),
      () => store.updateSync(N, (c) => ({ ...c, baseHeadRevisionId: 'rev9' })),
      () => store.updateSync('missing', (c) => c),
    ]
    for (const run of bad) await expect(run()).rejects.toBeInstanceOf(NoteSaveError)
    expect(await snapshot()).toBe(before)
  })

  test('resetSync forgets the Drive file but keeps conflicts, sidecars, unknown keys; the working copy is untouched', async () => {
    const info: SyncInfo = {
      ...synced(),
      pendingVerify: { parentRevisionId: null, oursRevisionId: null, round: 1 },
      conflicts: [{ pageId: 'p1', rev: 'x', resolvedAt: null }],
      unsentSidecars: [{ pageId: 'p1', rev: 'y' }],
      extra: { k: 1 },
    }
    await store.commitSync(mk(N), mk(N), info)
    const working = await rawGet('notes', N)
    await store.resetSync(N)
    const r = await store.readSync(N)
    expect(r.info).toEqual({ ...emptySync(), conflicts: info.conflicts, unsentSidecars: info.unsentSidecars, extra: { k: 1 } })
    expect(r.base).toBeNull()
    expect(await rawGet('base', N)).toBeUndefined()
    expect(await rawGet('notes', N)).toEqual(working)
    await store.resetSync('nobody') // no note: skipped
    expect(await rawGet('sync', 'nobody')).toBeUndefined()
  })
})
