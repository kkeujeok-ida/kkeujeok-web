// The upload triggers: who uploads which note when, the Web Locks between tabs,
// and the retry policy for notes in `error`.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { noteLockName, createUploadCoordinator, SYNC_LOCK_NAME } from '../src/sync/uploadCoordinator'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { fakeLocks } from './helpers'
import { type Env, NID, PA, makeEnv, mkNote, withStroke } from './uploadHarness'

let env: Env | undefined
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const OTHER = '01926f3a-0000-7000-8000-0000000000a2'

async function setup(o: { open?: string[]; locks?: LockManager | undefined; flush?: () => Promise<void>; tokenOk?: () => boolean; merge?: Env['deps']['merge'] } = {}) {
  const e = (env = await makeEnv(o.merge ? { merge: o.merge } : {}))
  const coordinator = (locks = o.locks) =>
    createUploadCoordinator({
      store: e.store,
      uploader: e.uploader,
      log: e.deps.log,
      allowed: e.deps.allowed,
      online: e.deps.online,
      flushOpen: o.flush ?? (async () => {}),
      ...(o.tokenOk && { tokenOk: o.tokenOk }),
      openIds: () => o.open ?? [],
      locks,
    })
  return { e, coordinator }
}
const unsentNote = (e: Env, id = NID) => e.store.writeNote(mkNote({ noteId: id }))
const driveCount = (e: Env, id = NID) => e.drive.byKkeujeokId(id).length

describe('triggers', () => {
  test('noteClosed uploads a note with unsent changes', async () => {
    const { e, coordinator } = await setup({ locks: undefined })
    await unsentNote(e)
    await coordinator(undefined).noteClosed(NID)
    expect(driveCount(e)).toBe(1)
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('an open note is not uploaded by page load, root ready or the connection coming back', async () => {
    const { e, coordinator } = await setup({ open: [NID] })
    await unsentNote(e)
    const c = coordinator(undefined)
    await c.start()
    await c.unsent()
    await c.rootReady()
    expect(e.drive.calls).toEqual([])
    expect((await e.sync()).state).toBe('pending')
  })

  test('a hidden tab flushes the open editor first, then uploads the open note too', async () => {
    const order: string[] = []
    const { e, coordinator } = await setup({
      open: [NID],
      flush: async () => {
        order.push('flush')
        await e.store.writeNote(mkNote()) // the editor's last save lands
      },
    })
    e.drive.hooks.beforeCall = (m) => void (m === 'list' && order.push('drive'))
    await coordinator(undefined).hidden()
    expect(order.slice(0, 2)).toEqual(['flush', 'drive'])
    expect(driveCount(e)).toBe(1)
  })

  test('a hidden tab uploads the snapshot it started with; later edits wait for the next trigger', async () => {
    const { e, coordinator } = await setup({ open: [NID] })
    await unsentNote(e)
    e.drive.hooks.afterUploadAsync = async () => {
      e.drive.hooks.afterUploadAsync = undefined
      await e.store.writeNote(withStroke(mkNote(), PA, 'a2')) // the tab is visible again and writing
    }
    const c = coordinator(undefined)
    await c.hidden()
    expect((await e.sync()).state).toBe('pending')
    await c.hidden() // hidden again
    expect((await e.sync()).state).toBe('synced')
    expect(e.drive.byKkeujeokId(NID)[0]!.revs).toHaveLength(2)
  })

  test('page load finishes an interrupted upload before it uploads anything new', async () => {
    const { e, coordinator } = await setup()
    await unsentNote(e)
    e.hooks.onLog = (ev) => {
      if (ev === 'uploadFinished') throw new Error('killed')
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('killed')
    e.hooks.onLog = undefined
    await unsentNote(e, OTHER)
    await coordinator(undefined).start()
    expect(driveCount(e)).toBe(1)
    expect(driveCount(e, OTHER)).toBe(1)
    expect(e.drive.count('uploadSimple')).toBe(2)
  })

  test('rootReady starts the first time and uploads what waited afterwards', async () => {
    const { e, coordinator } = await setup()
    const c = coordinator(undefined)
    await c.rootReady()
    await unsentNote(e)
    await c.rootReady()
    expect(driveCount(e)).toBe(1)
  })

  test('offline or a closed gate: nothing is sent and the note stays pending', async () => {
    const { e, coordinator } = await setup()
    await unsentNote(e)
    const c = coordinator(undefined)
    e.flags.online = false
    await c.noteClosed(NID)
    e.flags.online = true
    e.flags.allowed = false
    await c.unsent()
    expect(e.drive.calls).toEqual([])
    e.flags.allowed = true
    await c.unsent() // the connection is back
    expect(driveCount(e)).toBe(1)
  })
})

describe('Web Locks', () => {
  test('a note open in another tab (its note lock held) is not uploaded here', async () => {
    const locks = fakeLocks()
    const { e, coordinator } = await setup({ locks })
    await unsentNote(e)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    void locks.request(noteLockName(NID), {}, () => held) // the other tab's editor
    await coordinator(locks).noteClosed(NID)
    await coordinator(locks).unsent()
    expect(e.drive.calls).toEqual([])
    release()
    await new Promise((r) => setTimeout(r, 0))
    await coordinator(locks).unsent()
    expect(driveCount(e)).toBe(1)
  })

  test('two tabs triggering together upload a note once', async () => {
    const locks = fakeLocks()
    const { e, coordinator } = await setup({ locks })
    await unsentNote(e)
    const a = coordinator(locks)
    const b = coordinator(locks)
    await Promise.all([a.noteClosed(NID), b.noteClosed(NID), a.unsent(), b.unsent()])
    expect(driveCount(e)).toBe(1)
    expect(e.drive.count('uploadSimple')).toBe(1)
  })

  test('the upload runs under the sync lock', async () => {
    const seen: string[] = []
    const inner = fakeLocks()
    const spy = {
      request: (name: string, opts: unknown, cb: (l: object | null) => unknown) =>
        (inner.request as unknown as (...a: unknown[]) => Promise<void>)(name, opts, (l: object | null) => {
          if (l) seen.push(name)
          return cb(l)
        }),
    } as unknown as LockManager
    const { e, coordinator } = await setup({ locks: spy })
    await unsentNote(e)
    await coordinator(spy).noteClosed(NID)
    expect(seen).toContain(SYNC_LOCK_NAME)
    expect(driveCount(e)).toBe(1)
  })

  test('a throwing lock manager does not lose the note: it stays pending', async () => {
    const bad = { request: () => Promise.reject(new Error('locks broke')) } as unknown as LockManager
    const { e, coordinator } = await setup({ locks: bad })
    await unsentNote(e)
    await expect(coordinator(bad).noteClosed(NID)).resolves.toBeUndefined()
    expect((await e.sync()).state).toBe('pending')
  })
})

describe('error notes', () => {
  async function failWith(e: Env, err: DriveError) {
    await unsentNote(e)
    e.drive.failAt('list', 1, err)
    await e.uploader.upload(NID)
    e.drive.clearFailures()
    expect((await e.sync()).info.state).toBe('error')
  }

  test.each([
    ['backoff', new DriveError('http', 503)],
    ['reauth', new DriveError('http', 401, 'noToken')],
    ['fatal', new DriveError('http', 409)],
  ])('class %s is retried at the next trigger', async (_c, err) => {
    const { e, coordinator } = await setup()
    await unsentNote(e)
    // backoff needs all 7 failures of the call; the other classes stop at the first
    if (err.status === 503) e.drive.failAlways('list', err)
    else e.drive.failAt('list', 1, err)
    await e.uploader.upload(NID)
    e.drive.clearFailures()
    expect((await e.sync()).info.state).toBe('error')
    await coordinator(undefined).unsent()
    expect((await e.sync()).info.state).toBe('synced')
    expect(e.events('stateChange')).toContainEqual(expect.objectContaining({ from: 'error', to: 'pending' }))
  })

  test.each([
    ['deleted', new DriveError('http', 404, 'notFound')],
    ['unreadable', new DriveError('parse')],
  ])('class %s is never retried', async (_c, err) => {
    const { e, coordinator } = await setup()
    await failWith(e, err)
    const calls = e.drive.calls.length
    await coordinator(undefined).unsent()
    await coordinator(undefined).hidden()
    expect((await e.sync()).info.state).toBe('error')
    expect(e.drive.calls.length).toBe(calls)
  })

  test('a reason that fails the same way again is retried once per page session', async () => {
    // a merge that cannot be done: every upload attempt ends in mergeFailed
    const { e, coordinator } = await setup({ merge: { merge: async () => ({ result: 'error', reason: 'boom' }) } })
    const id = await (async () => {
      await e.store.writeNote(mkNote({ pages: { [PA]: 'a1' } }))
      await e.uploader.upload(NID)
      return e.drive.byKkeujeokId(NID)[0]!.id
    })()
    // a changed remote head makes the merge run
    const { bytesOf, foreignEdit } = await import('./uploadHarness')
    e.drive.foreignRevision(id, await bytesOf(foreignEdit(mkNote({ pages: { [PA]: 'a1' } }), PA, 'a3')))
    await e.store.writeNote(withStroke(mkNote({ pages: { [PA]: 'a1' } }), PA, 'a2'))
    const c = coordinator(undefined)
    await c.unsent() // fails: mergeFailed
    expect((await e.sync()).info.lastError).toMatchObject({ reason: 'mergeFailed' })
    const downloads = e.drive.count('downloadRevision')
    await c.unsent() // the one retry
    const afterRetry = e.drive.count('downloadRevision')
    expect(afterRetry).toBeGreaterThan(downloads)
    await c.unsent()
    await c.hidden()
    expect(e.drive.count('downloadRevision')).toBe(afterRetry) // not again
    expect((await e.sync()).info.state).toBe('error')
  })
})

describe('fatal reasons only a manual retry ends (Story 12.2)', () => {
  test.each(['md5Mismatch', 'noRevisionId', 'localWrite', 'rootMissing'])('%s: one retry at the first trigger, none at later ones', async (reason) => {
    const { e, coordinator } = await setup()
    await unsentNote(e)
    const fail = () => e.store.updateSync(NID, (c) => ({ ...c, state: 'error', lastError: { class: 'fatal', reason } }))
    await fail()
    const c = coordinator(undefined)
    await c.unsent() // the one retry: it uploads
    expect(e.drive.calls.length).toBeGreaterThan(0)
    await fail()
    const calls = e.drive.calls.length
    await c.unsent()
    await c.hidden()
    expect(e.drive.calls.length).toBe(calls)
    expect((await e.sync()).info.state).toBe('error')
  })
})

describe('retry policy of the web display (Story 3.16)', () => {
  const quota = () => new DriveError('http', 403, 'storageQuotaExceeded')
  const reauth = () => new DriveError('http', 401, 'noToken')
  async function failWith(e: Env, err: DriveError) {
    await unsentNote(e)
    e.drive.failAt('list', 1, err)
    await e.uploader.upload(NID)
    e.drive.clearFailures()
    expect((await e.sync()).info.state).toBe('error')
  }
  const entries = (e: Env) => e.events('stateChange').length

  test('a quota note is not retried by hidden, unsent, rootReady-after-start or noteClosed', async () => {
    const { e, coordinator } = await setup()
    await failWith(e, quota())
    const before = entries(e)
    const c = coordinator(undefined)
    await c.hidden()
    await c.unsent()
    await c.noteClosed(NID)
    expect((await e.sync()).info.state).toBe('error')
    expect(entries(e)).toBe(before)
  })

  test('a quota note is retried at page load, by [다시 시도] / [지금 동기화] (syncNow)', async () => {
    const a = await setup()
    await failWith(a.e, quota())
    await a.coordinator(undefined).start()
    expect((await a.e.sync()).info.state).toBe('synced')
    a.e.close()
    await deleteNoteDatabase()
    const b = await setup()
    await failWith(b.e, quota())
    await b.coordinator(undefined).syncNow(NID)
    expect((await b.e.sync()).info.state).toBe('synced')
  })

  test('syncNow flushes the open editor first and uploads an open note', async () => {
    const order: string[] = []
    const { e, coordinator } = await setup({ open: [NID], flush: async () => void order.push('flush') })
    await unsentNote(e)
    e.drive.hooks.beforeCall = (m) => void (m === 'list' && order.push('drive'))
    await coordinator(undefined).syncNow(NID)
    expect(order.slice(0, 2)).toEqual(['flush', 'drive'])
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('a reauth note waits while the token is expired: no retry, no log entry', async () => {
    let ok = false
    const { e, coordinator } = await setup({ tokenOk: () => ok })
    await failWith(e, reauth())
    const before = entries(e)
    const c = coordinator(undefined)
    await c.hidden()
    await c.unsent()
    await c.start()
    expect((await e.sync()).info.state).toBe('error')
    expect(entries(e)).toBe(before)
    ok = true
    await c.unsent()
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('resume retries reauth notes even while the flag says expired, and leaves quota notes alone', async () => {
    const a = await setup({ tokenOk: () => false })
    await failWith(a.e, reauth())
    await a.coordinator(undefined).resume()
    expect((await a.e.sync()).info.state).toBe('synced')
    a.e.close()
    await deleteNoteDatabase()
    const b = await setup({ tokenOk: () => true })
    await failWith(b.e, quota())
    await b.coordinator(undefined).resume()
    expect((await b.e.sync()).info.state).toBe('error')
  })
})
