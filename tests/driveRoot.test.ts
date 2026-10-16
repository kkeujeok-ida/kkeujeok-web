// @vitest-environment jsdom
// RootFolderService against the in-memory Drive (Story 3.10): every row of the
// spec's I/O matrix, plus the guards from the Epic 2/3 reviews.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { createRootFolderService } from '../src/drive/rootFolder'
import { createNote } from '../src/ops/ops'
import { deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { createSyncDeviceStore } from '../src/storage/syncDevice'
import { SYNC_LOG_DB, createSyncLog } from '../src/sync/syncLog'
import { createFakeDrive } from './fakeDrive'

type Acct = { sub: string; email: string } | null
let readNdb: ReturnType<typeof openNoteDb>
let logs: ReturnType<typeof createSyncLog>

beforeEach(() => {
  readNdb = openNoteDb()
  logs = createSyncLog()
})
afterEach(async () => {
  readNdb.close()
  logs.close()
  await deleteNoteDatabase()
  await new Promise<void>((r) => {
    const q = indexedDB.deleteDatabase(SYNC_LOG_DB)
    q.onsuccess = q.onerror = () => r()
  })
})

function setup(o: { pageSize?: number; maxPages?: number; account?: Acct } = {}) {
  const drive = createFakeDrive({ pageSize: o.pageSize })
  const state = { account: (o.account === undefined ? { sub: 's1', email: 'a@x.com' } : o.account) as Acct, opens: 0, closes: 0 }
  const svc = createRootFolderService({
    client: drive,
    open: () => {
      state.opens++
      const ndb = openNoteDb()
      const notes = openNoteStore()
      return {
        device: createSyncDeviceStore(ndb),
        notes,
        close: () => {
          state.closes++
          ndb.close()
          notes.close()
        },
      }
    },
    log: logs,
    account: () => state.account,
    maxPages: o.maxPages,
  })
  return { drive, svc, state, device: () => createSyncDeviceStore(readNdb).read() }
}

const net = new DriveError('network')
const events = async () => (await logs.entries()) as Record<string, unknown>[]

describe('first login and other devices', () => {
  test('no root: intent, list, create under My Drive, re-list, id cached, intent cleared', async () => {
    const { drive, svc, device } = setup()
    const r = await svc.ensureRoot()
    expect(r.status).toBe('ready')
    expect(drive.roots()).toHaveLength(1)
    const root = drive.roots()[0]!
    expect(root).toMatchObject({ name: 'Kkeujeok', parents: ['root'], appProperties: { kkeujeokId: 'root' } })
    expect(r.folderId).toBe(root.id)
    expect(drive.calls.map((c) => c.split(' ')[0])).toEqual(['list', 'create', 'list'])
    const d = await device()
    expect(d.rootFolderId).toBe(root.id)
    expect(d.createIntents).toEqual([])
    expect(d.sub).toBe('s1')
  })

  test('the intent is saved before create', async () => {
    const { drive, svc, device } = setup()
    drive.failAt('create', 1, net)
    const r = await svc.ensureRoot()
    expect(r).toEqual({ status: 'failed', errorClass: 'backoff' })
    expect((await device()).createIntents).toEqual([{ kkeujeokId: 'root', kind: 'root', parentId: 'root' }])
    expect((await device()).rootFolderId).toBeNull()
  })

  test("another device's root is used, nothing is created", async () => {
    const { drive, svc } = setup()
    const other = drive.addRoot()
    const r = await svc.ensureRoot()
    expect(r).toEqual({ status: 'ready', folderId: other.id })
    expect(drive.count('create')).toBe(0)
  })

  test('a user folder named Kkeujeok is invisible; a new root is made', async () => {
    const { drive, svc } = setup()
    const mine = drive.foreign('Kkeujeok')
    const r = await svc.ensureRoot()
    expect(r.status).toBe('ready')
    expect(r.folderId).not.toBe(mine.id)
    expect(drive.roots()).toHaveLength(1)
  })

  test('a lagging list: the id of the create response is used, and the next run finds the one root', async () => {
    const { drive, svc } = setup()
    drive.lagOn()
    const r = await svc.ensureRoot()
    expect(r.status).toBe('ready')
    expect(r.folderId).toBe(drive.roots()[0]!.id)
    drive.settle()
    expect(await svc.ensureRoot()).toEqual(r)
    expect(drive.roots()).toHaveLength(1)
    expect(drive.count('create')).toBe(1)
  })

  test('a crash after create: the next run lists first and creates no second root', async () => {
    const { drive, svc, device } = setup()
    drive.failAt('list', 2, net) // the re-query after create never answers
    expect((await svc.ensureRoot()).status).toBe('failed')
    expect(drive.roots()).toHaveLength(1)
    expect((await device()).rootFolderId).toBeNull()
    const r = await svc.ensureRoot()
    expect(r).toEqual({ status: 'ready', folderId: drive.roots()[0]!.id })
    expect(drive.count('create')).toBe(1)
  })

  test('a root that only moved is used silently', async () => {
    const { drive, svc } = setup()
    const r1 = await svc.ensureRoot()
    drive.items.get(r1.folderId!)!.parents = ['someFolder']
    expect(await svc.checkRoot()).toEqual(r1)
    expect(drive.count('create')).toBe(1)
  })
})

describe('duplicate roots', () => {
  test('the earliest stays, children move first, the other is trashed last, event logged', async () => {
    const { drive, svc } = setup()
    const a = drive.addRoot()
    const b = drive.addRoot()
    const kid = drive.addChild(b.id)
    const r = await svc.ensureRoot()
    expect(r.folderId).toBe(a.id)
    expect(drive.items.get(kid.id)!.parents).toEqual([a.id])
    expect(drive.items.get(b.id)!.trashed).toBe(true)
    expect(drive.items.get(a.id)!.trashed).toBe(false)
    const ups = drive.calls.filter((c) => c.startsWith('update'))
    expect(ups).toHaveLength(2)
    expect(ups[0]).toContain(kid.id) // move
    expect(ups[1]).toContain('"trashed":true') // trash is last
    const ev = (await events()).filter((e) => e.event === 'duplicatesCleaned')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ count: 1 })
  })

  test('a failed move leaves the duplicate; the next run finishes it', async () => {
    const { drive, svc } = setup()
    drive.addRoot()
    const b = drive.addRoot()
    drive.addChild(b.id)
    drive.failAt('update', 1, new DriveError('http', 500))
    expect((await svc.ensureRoot()).status).toBe('ready')
    expect(drive.items.get(b.id)!.trashed).toBe(false)
    expect((await events()).some((e) => e.event === 'error' && e.class === 'backoff' && e.status === 500)).toBe(true)
    await svc.ensureRoot()
    expect(drive.items.get(b.id)!.trashed).toBe(true)
  })

  test('a truncated children listing never trashes the duplicate', async () => {
    const { drive, svc } = setup({ pageSize: 1, maxPages: 2 })
    drive.addRoot()
    const b = drive.addRoot()
    for (let i = 0; i < 3; i++) drive.addChild(b.id)
    expect((await svc.ensureRoot()).status).toBe('ready')
    expect(drive.items.get(b.id)!.trashed).toBe(false)
    expect((await events()).some((e) => e.event === 'error' && e.reason === 'listTruncated')).toBe(true)
    expect((await events()).some((e) => e.event === 'duplicatesCleaned')).toBe(false)
  })

  test('a truncated root listing never trashes anything', async () => {
    const { drive, svc } = setup({ pageSize: 1, maxPages: 1 })
    drive.addRoot()
    const b = drive.addRoot()
    expect((await svc.ensureRoot()).status).toBe('ready')
    expect(drive.items.get(b.id)!.trashed).toBe(false)
  })
})

describe('missing root', () => {
  test.each(['trash', 'remove'] as const)('%s: missing, not an error and not created again', async (how) => {
    const { drive, svc, device } = setup()
    const r = await svc.ensureRoot()
    drive[how](r.folderId!)
    expect(await svc.checkRoot()).toEqual({ status: 'missing' })
    expect(drive.count('create')).toBe(1)
    expect((await device()).rootFolderId).toBe(r.folderId) // the cache is kept until the person decides
  })

  test('a failed call is never missing', async () => {
    const { drive, svc } = setup()
    await svc.ensureRoot()
    drive.failAt('list', 3, net)
    expect(await svc.checkRoot()).toEqual({ status: 'failed', errorClass: 'backoff' })
  })

  test('the cached id still alive while the list lags: ready', async () => {
    const { drive, svc } = setup()
    const r = await svc.ensureRoot()
    drive.items.get(r.folderId!)!.hidden = true
    expect(await svc.checkRoot()).toEqual({ status: 'ready', folderId: r.folderId })
  })

  test('recreate: new root, every note forgets its Drive file, working copies untouched', async () => {
    const { drive, svc, device } = setup()
    const first = await svc.ensureRoot()
    const store = openNoteStore()
    const made = createNote({
      title: 'n', existingTitles: [], background: 'plain', orientation: 'portrait',
      noteId: 'n1', pageId: 'p1', pageRev: 'r', metaRev: 'm', orderRev: 'o',
      now: '2026-10-10T04:20:00.000Z', editedBy: 'Chrome',
    })
    if ('error' in made) throw new Error(made.error)
    await store.writeNote(made.note)
    await store.updateSync('n1', (c) => ({ ...c, fileId: 'old', state: 'synced', lastError: { class: 'fatal' } }))
    const d = await device()
    await createSyncDeviceStore(readNdb).write({ ...d, conflictsFolderId: 'oldConflicts' })
    const before = await store.loadNote('n1')
    drive.trash(first.folderId!)
    expect(await svc.checkRoot()).toEqual({ status: 'missing' })

    const r = await svc.recreate()
    expect(r.status).toBe('ready')
    expect(r.folderId).not.toBe(first.folderId)
    expect(drive.roots().filter((x) => !x.trashed)).toHaveLength(1)
    const sync = await store.readSync('n1')
    expect(sync.info).toMatchObject({ fileId: null, state: 'pending', lastError: null })
    expect(await store.loadNote('n1')).toEqual(before) // never rewritten
    const after = await device()
    expect(after).toMatchObject({ rootFolderId: r.folderId, conflictsFolderId: null, createIntents: [] })
    store.close()
  })

  test("another device's new root: this device's note ids are stale and are reset", async () => {
    const { drive, svc } = setup()
    const first = await svc.ensureRoot()
    const store = openNoteStore()
    const made = createNote({
      title: 'n', existingTitles: [], background: 'plain', orientation: 'portrait',
      noteId: 'n1', pageId: 'p1', pageRev: 'r', metaRev: 'm', orderRev: 'o',
      now: '2026-10-10T04:20:00.000Z', editedBy: 'Chrome',
    })
    if ('error' in made) throw new Error(made.error)
    await store.writeNote(made.note)
    await store.updateSync('n1', (c) => ({ ...c, fileId: 'old', state: 'synced' }))
    drive.remove(first.folderId!)
    const other = drive.addRoot()
    expect(await svc.checkRoot()).toEqual({ status: 'ready', folderId: other.id })
    expect((await store.readSync('n1')).info.fileId).toBeNull()
    store.close()
  })
})

describe('failures are classified, logged and never thrown', () => {
  test.each([
    [new DriveError('network'), 'backoff'],
    [new DriveError('http', 503), 'backoff'],
    [new DriveError('http', 401), 'reauth'],
    [new DriveError('http', 403, 'storageQuotaExceeded'), 'quota'],
    [new DriveError('http', 403, 'forbidden'), 'fatal'],
    [new DriveError('parse'), 'unreadable'],
  ])('%s', async (err, cls) => {
    const { drive, svc } = setup()
    drive.failAt('list', 1, err)
    expect(await svc.ensureRoot()).toEqual({ status: 'failed', errorClass: cls })
    const e = (await events()).find((x) => x.event === 'error')!
    expect(e).toMatchObject({ class: cls })
    expect(JSON.stringify(e)).not.toMatch(/Kkeujeok|d\d/)
  })

  test('an unreadable device record: failed before any Drive call', async () => {
    const { drive, svc } = setup()
    await readNdb.withDb((db) => db.put('device', { sub: 5 }, 'device'))
    expect(await svc.ensureRoot()).toEqual({ status: 'failed', errorClass: 'fatal' })
    expect(drive.calls).toEqual([])
  })
})

describe('account', () => {
  test('another account than the device tag: idle, no Drive call', async () => {
    const { drive, svc, state } = setup()
    await createSyncDeviceStore(readNdb).adoptAccount('s2', 'b@x.com')
    expect(await svc.ensureRoot()).toEqual({ status: 'idle' })
    state.account = null
    expect(await svc.ensureRoot()).toEqual({ status: 'idle' })
    expect(drive.calls).toEqual([])
  })

  test('signed out during the first list: nothing is created, nothing cached', async () => {
    const { drive, svc, state, device } = setup()
    const list = drive.list.bind(drive)
    drive.list = async (q, p) => {
      const r = await list(q, p)
      state.account = null
      return r
    }
    expect(await svc.ensureRoot()).toEqual({ status: 'idle' })
    expect(drive.count('create')).toBe(0)
    expect((await device()).rootFolderId).toBeNull()
  })

  test('another account signs in during the run: the result is dropped', async () => {
    const { drive, svc, state, device } = setup()
    drive.addRoot()
    const list = drive.list.bind(drive)
    drive.list = async (q, p) => {
      const r = await list(q, p)
      state.account = { sub: 's9', email: 'z@x.com' }
      return r
    }
    expect(await svc.ensureRoot()).toEqual({ status: 'idle' })
    expect((await device()).rootFolderId).toBeNull()
  })
})

describe('single flight', () => {
  test('concurrent callers share one run; recreate waits and never overlaps', async () => {
    const { drive, svc, state } = setup()
    const [a, b] = await Promise.all([svc.ensureRoot(), svc.checkRoot()])
    expect(a).toEqual(b)
    expect(drive.count('create')).toBe(1)
    expect(state.opens).toBe(1)
    const [c, d] = await Promise.all([svc.checkRoot(), svc.recreate()])
    expect(c.status).toBe('ready')
    expect(d.status).toBe('ready')
    expect(state.opens).toBe(3) // check, then recreate: never overlapping
    expect(state.closes).toBe(state.opens)
  })
})
