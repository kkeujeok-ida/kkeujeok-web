// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAuth, fetchUserinfo } from '../src/drive/auth'
import { createNote } from '../src/ops/ops'
import { NOTE_DB_NAME, deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { type SyncDeviceStore, createSyncDeviceStore, emptyDevice } from '../src/storage/syncDevice'

function rawDevice(op: (s: IDBObjectStore) => IDBRequest | void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOTE_DB_NAME)
    r.onsuccess = () => {
      const db = r.result
      const tx = db.transaction('device', 'readwrite')
      const q = op(tx.objectStore('device'))
      tx.oncomplete = () => (db.close(), resolve(q ? q.result : undefined))
      tx.onerror = () => reject(tx.error)
    }
  })
}
const rawGet = () => rawDevice((s) => s.get('device'))
const rawPut = (v: unknown) => rawDevice((s) => void s.put(v, 'device'))

let ndb: ReturnType<typeof openNoteDb>
let dev: SyncDeviceStore
beforeEach(async () => {
  ndb = openNoteDb()
  dev = createSyncDeviceStore(ndb)
  await dev.read() // creates the DB
})
afterEach(async () => {
  ndb.close()
  await deleteNoteDatabase()
})

describe('device record', () => {
  test('no record: tag written, true; no token key', async () => {
    expect(await dev.adoptAccount('s1', 'a@x.com')).toBe(true)
    const stored = (await rawGet()) as Record<string, unknown>
    expect(stored).toMatchObject({ sub: 's1', email: 'a@x.com' })
    expect(Object.keys(stored).some((k) => /token$/i.test(k) && k !== 'pageToken')).toBe(false)
    expect(Object.keys(stored)).not.toContain('accessToken')
    expect((await dev.read()).sub).toBe('s1')
  })

  test('same sub refreshes the e-mail, true', async () => {
    await dev.adoptAccount('s1', 'old@x.com')
    expect(await dev.adoptAccount('s1', 'new@x.com')).toBe(true)
    expect((await dev.read()).email).toBe('new@x.com')
  })

  test('other sub is left untouched, false', async () => {
    await dev.adoptAccount('s1', 'a@x.com')
    expect(await dev.adoptAccount('s2', 'b@x.com')).toBe(false)
    expect(await dev.read()).toMatchObject({ sub: 's1', email: 'a@x.com' })
  })

  test('empty sub is refused', async () => {
    expect(await dev.adoptAccount('', 'a@x.com')).toBe(false)
    expect(await rawGet()).toBeUndefined()
  })

  test('absent differs from unreadable: unreadable is not tagged, write rejects, clear removes', async () => {
    for (const bad of ['text', { sub: 5 }, { createIntents: 'x' }, { createIntents: [{ kkeujeokId: 'a' }] }]) {
      await rawPut(bad)
      expect(await dev.adoptAccount('s1', 'a@x.com')).toBe(false)
      await expect(dev.write(emptyDevice())).rejects.toThrow()
      expect(await rawGet()).toEqual(bad) // never overwritten
      expect(await dev.read()).toEqual(emptyDevice())
      await dev.clear()
      expect(await rawGet()).toBeUndefined()
    }
    // absent: both work
    await dev.write({ ...emptyDevice(), pageToken: 'p' })
    expect((await dev.read()).pageToken).toBe('p')
  })

  test('unknown keys are kept and written back', async () => {
    await rawPut({ sub: 's1', email: 'a', future: { x: 1 } })
    await dev.adoptAccount('s1', 'b')
    expect(await rawGet()).toMatchObject({ future: { x: 1 }, email: 'b' })
    const d = await dev.read()
    await dev.write({ ...d, rootFolderId: 'root' })
    expect(await rawGet()).toMatchObject({ future: { x: 1 }, rootFolderId: 'root', sub: 's1' })
  })

  test('readState tells absent, unreadable and ok apart', async () => {
    expect(await dev.readState()).toEqual({ kind: 'absent' })
    await rawPut('garbage')
    expect(await dev.readState()).toEqual({ kind: 'unreadable' })
    await rawPut({ sub: 's1', email: 'a@x.com' })
    expect(await dev.readState()).toMatchObject({ kind: 'ok', device: { sub: 's1', email: 'a@x.com' } })
  })

  test('clear on a missing record is fine', async () => {
    await expect(dev.clear()).resolves.toBeUndefined()
  })

  test('the note store tags the device after a write; another sub stays; a failed tag does not fail the write', async () => {
    let account: { sub: string; email: string } | null = { sub: 's1', email: 'a@x.com' }
    const store = openNoteStore(indexedDB, { getAccount: () => account })
    const note = (id: string) => {
      const r = createNote({ title: 't', existingTitles: [], background: 'plain', orientation: 'portrait', noteId: id, pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-10T04:20:00.000Z', editedBy: 'x' })
      if ('error' in r) throw new Error(r.error)
      return r.note
    }
    await store.writeNote(note('n1'))
    expect(await rawGet()).toMatchObject({ sub: 's1', email: 'a@x.com' })
    account = { sub: 's2', email: 'b@x.com' }
    await store.writeNote(note('n1'))
    expect(await rawGet()).toMatchObject({ sub: 's1' })
    account = null // not signed in or unknown: skipped
    await store.writeNote(note('n1'))
    await rawPut('garbage')
    account = { sub: 's1', email: 'a@x.com' }
    await expect(store.writeNote(note('n1'))).resolves.toBeUndefined()
    store.close()
  })
})

describe('account in auth', () => {
  const gis = (granted = true) => {
    ;(globalThis as { google?: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: { callback: (r: object) => void }) => ({
            requestAccessToken: () => cfg.callback({ access_token: 'tok' }),
          }),
          hasGrantedAllScopes: () => granted,
          revoke: (_t: string, done: (r: object) => void) => done({ successful: true }),
        },
      },
    }
  }
  const mkAuth = (fetchAccount?: (t: string) => Promise<{ sub: string; email: string } | null>) =>
    createAuth({ clientId: 'cid', loadScript: async () => {}, fetchAccount })

  test('a granted sign-in fetches the account with the token; sign-out and disconnect clear it', async () => {
    gis()
    let asked = ''
    const auth = mkAuth(async (t) => ((asked = t), { sub: 's1', email: 'a@x.com' }))
    expect(await auth.signIn()).toBe('granted')
    expect(asked).toBe('tok')
    expect(auth.getState().account).toEqual({ sub: 's1', email: 'a@x.com' })
    expect(await auth.disconnect()).toBe('revoked')
    expect(auth.getState().account).toBeNull()
    await auth.signIn()
    auth.signOut()
    expect(auth.getState()).toMatchObject({ token: null, account: null })
  })

  test('a failing or throwing lookup leaves the account null and does not fail sign-in', async () => {
    gis()
    for (const f of [async () => null, async () => { throw new Error('x') }]) {
      const auth = mkAuth(f)
      expect(await auth.signIn()).toBe('granted')
      expect(auth.getState()).toMatchObject({ token: 'tok', account: null })
    }
  })

  test('no lookup when the grant is denied; no account after sign-out during the lookup', async () => {
    gis(false)
    let called = false
    const denied = mkAuth(async () => ((called = true), null))
    expect(await denied.signIn()).toBe('denied')
    expect(called).toBe(false)
    gis()
    let release!: () => void
    const auth = mkAuth(() => new Promise((res) => (release = () => res({ sub: 's', email: 'e' }))))
    const p = auth.signIn()
    await new Promise((r) => setTimeout(r))
    auth.signOut()
    release()
    await p
    expect(auth.getState().account).toBeNull()
  })

  test('fetchUserinfo reads sub and email, and is null on errors', async () => {
    const real = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ sub: 's1', email: 'a@x.com' }))) as typeof fetch
      expect(await fetchUserinfo('t')).toEqual({ sub: 's1', email: 'a@x.com' })
      globalThis.fetch = (async () => new Response('{}')) as typeof fetch
      expect(await fetchUserinfo('t')).toBeNull()
      globalThis.fetch = (async () => new Response('x', { status: 401 })) as typeof fetch
      expect(await fetchUserinfo('t')).toBeNull()
      globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
      expect(await fetchUserinfo('t')).toBeNull()
    } finally {
      globalThis.fetch = real
    }
  })
})
