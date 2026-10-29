// Story 3.22, the sync side of resolving a conflict: `Drive.update(appProperties)`, the one `sync.json` write of
// `conflictResolved`, the sidecar kept readable until the conflict is resolved, `kkjResolved` on the Drive sidecar
// once the resolving upload is verified, and the 30-day cleanup at start. Fake Drive + fake-indexeddb.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import type { Note } from '../src/model/note'
import { resolveConflict } from '../src/ops/resolveConflict'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { NoteSaveError, openNoteStore } from '../src/storage/noteStore'
import { unresolvedOf } from '../src/sync/conflicts'
import type { Conflict } from '../src/sync/merge'
import { SIDECAR_KEEP_MS } from '../src/sync/noteUploader'
import { SYNC_LOCK_NAME, createUploadCoordinator, noteLockName } from '../src/sync/uploadCoordinator'
import { fakeLocks } from './helpers'
import { type Env, NID, PA, PB, bytesOf, foreignEdit, makeEnv, mkNote, withStroke } from './uploadHarness'

let env: Env | undefined
const make: typeof makeEnv = async (o) => (env = await makeEnv(o))
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const kid = (pageId: string, rev: string) => `sc:${NID}:${pageId}:${rev}`
const NOW = '2026-10-13T00:00:00.000Z'
const ctx = { now: NOW, orderRev: 'o9', rev: 'r9', editedBy: 'Chrome, Windows', lastSeenRemoteSeq: 0 }
const oneFile = (e: Env, id: string) => {
  const found = e.drive.byKkeujeokId(id)
  expect(found).toHaveLength(1)
  return found[0]!
}

/** The note is on Drive; both devices edit page A: this one locally, the other one remotely. Uploaded: state `conflict`. */
async function conflicted(e: Env) {
  await e.store.writeNote(two())
  await e.uploader.upload(NID)
  const file = oneFile(e, NID)
  e.drive.foreignRevision(file.id, await bytesOf(foreignEdit(two(), PA, 'a3')))
  await e.store.writeNote(withStroke(two(), PA, 'a2'))
  expect(await e.uploader.upload(NID)).toBe('uploaded')
  expect((await e.sync()).info.state).toBe('conflict')
  return file.id
}

/** What the editor does: resolveConflict on the stored note, saved. */
async function resolveLocally(e: Env, choice: string, which = 0): Promise<{ note: Note; conflict: Conflict }> {
  const s = await e.sync()
  const entry = unresolvedOf(s.info)[which] as unknown as Conflict
  const sc = (await e.store.sidecars.get(NID, entry.pageId, entry.rev))!
  const out = resolveConflict((await e.store.loadNote(NID))!.note!, entry, sc, choice, ctx)
  if (out.result !== 'resolved') throw new Error(out.error)
  await e.store.writeNote(out.note)
  return { note: out.note, conflict: out.conflict }
}

describe('DriveClient.update with appProperties', () => {
  test('the fake merges the properties and a null value deletes the key', async () => {
    const e = await make()
    const f = await e.drive.create({ name: 'x', appProperties: { kkeujeokId: 'k', a: '1' } })
    await e.drive.update(f.id, { appProperties: { b: '2', a: null } })
    expect(oneFile(e, 'k').appProperties).toEqual({ kkeujeokId: 'k', b: '2' })
  })
})

describe('the sidecar stays readable until the conflict is resolved', () => {
  test('after the upload the record is still there; once resolved, the next sidecarSent removes it', async () => {
    const e = await make()
    await conflicted(e)
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
    expect((await e.sync()).info.unsentSidecars).toEqual([])
  })

  test('resolved before its upload: the file is created with kkjResolved and the record goes after Drive has it', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const entry = { pageId: PA, kind: 'bothEdited', rev: 'a2', theirsRev: 'a3', detectedAt: NOW, originalIndex: 0, resolvedAt: null } as const
    await e.store.recordConflicts(NID, {
      conflicts: [entry],
      sidecars: [{ noteId: NID, pageId: PA, rev: 'a2', seq: 2, editedAt: NOW, editedBy: 'C', kind: 'bothEdited', page: withStroke(two(), PA, 'a2').pages[0]! }],
    })
    expect((await e.sync()).info.unsentSidecars).toHaveLength(1)
    await e.store.writeNote(withStroke(two(), PA, 'r9')) // the resolved page
    await e.uploader.conflictResolved(NID, { ...entry, resolvedAt: NOW })
    await e.uploader.upload(NID)
    expect(oneFile(e, kid(PA, 'a2')).appProperties.kkjResolved).toBe(NOW)
    expect(await e.store.sidecars.get(NID, PA, 'a2')).toBeNull()
  })
})

describe('conflictResolved', () => {
  test('ONE sync.json write: the entry takes the resolver conflict and the state moves conflict -> pending; logged as a state change', async () => {
    const puts: string[] = []
    const store = openNoteStore(indexedDB, { afterPut: (_tx, s) => void puts.push(s) })
    const e = await make({ store })
    await conflicted(e)
    const { conflict } = await resolveLocally(e, 'mine')
    puts.length = 0
    const info = await e.uploader.conflictResolved(NID, conflict as never)
    expect(puts.filter((s) => s === 'sync')).toHaveLength(1)
    expect(puts).not.toContain('notes')
    expect(info.state).toBe('pending')
    expect(info.conflicts).toEqual([{ ...conflict, resolvedAt: NOW }])
    expect(e.events('stateChange').at(-1)).toMatchObject({ from: 'conflict', to: 'pending' })
    expect((await e.sync()).hasUnsent).toBe(true) // the resolved page is not on Drive yet
    expect(e.invalid).toEqual([])
  })

  test.each([['mine', 'local'], ['theirs', 'remote'], ['both', 'both']])('choice %s is logged as %s; conflict -> pending has no reason', async (choice, logged) => {
    const e = await make()
    await conflicted(e)
    const { conflict } = await resolveLocally(e, choice)
    await e.uploader.conflictResolved(NID, conflict as never, choice)
    expect(e.events('conflictResolved').at(-1)).toMatchObject({ noteId: NID, choice: logged })
    expect(e.events('stateChange').at(-1)).not.toHaveProperty('reason')
  })

  test('another conflict is still open: the state stays conflict', async () => {
    const e = await make()
    await conflicted(e)
    const id = oneFile(e, NID).id
    e.drive.foreignRevision(id, await bytesOf(foreignEdit(foreignEdit(two(), PA, 'a3'), PB, 'b3')))
    await e.store.writeNote(withStroke(withStroke(two(), PA, 'a2'), PB, 'b2'))
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'pending' }))
    await e.uploader.upload(NID)
    const open = unresolvedOf((await e.sync()).info)
    expect(open.length).toBeGreaterThanOrEqual(1)
    const { conflict } = await resolveLocally(e, 'theirs')
    const info = await e.uploader.conflictResolved(NID, conflict as never)
    expect(unresolvedOf(info).length).toBe(open.length - 1)
    expect(info.state).toBe(open.length > 1 ? 'conflict' : 'pending')
  })

  test('no such unresolved conflict: rejects, nothing changes', async () => {
    const e = await make()
    await conflicted(e)
    const before = (await e.sync()).info
    await expect(e.uploader.conflictResolved(NID, { pageId: PB, rev: 'zzz', kind: 'bothEdited', resolvedAt: NOW })).rejects.toBeInstanceOf(NoteSaveError)
    expect((await e.sync()).info).toEqual(before)
    // an entry that is resolved already is not "a matching entry" a second time
    const { conflict } = await resolveLocally(e, 'mine')
    await e.uploader.conflictResolved(NID, conflict as never)
    await expect(e.uploader.conflictResolved(NID, conflict as never)).rejects.toBeInstanceOf(NoteSaveError)
  })

  test('a resolve that leaves the note as Drive has it (the other device deleted the page, remove) is saved, not pending', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const id = oneFile(e, NID).id
    const remote = two()
    remote.pages = remote.pages.filter((p) => p.id !== PB)
    remote.orderRev = 'o2'
    e.drive.foreignRevision(id, await bytesOf(remote))
    await e.store.writeNote(withStroke(two(), PB, 'b2'))
    await e.uploader.upload(NID)
    expect((await e.sync()).info.state).toBe('conflict')
    const { conflict } = await resolveLocally(e, 'remove')
    const info = await e.uploader.conflictResolved(NID, conflict as never)
    expect(info.state).toBe('synced')
    expect(e.events('stateChange').at(-1)).toMatchObject({ from: 'conflict', to: 'synced' })
    expect((await e.sync()).state).toBe('synced')
  })

  test('a sync.json that cannot be read is not overwritten', async () => {
    const e = await make()
    await conflicted(e)
    const { conflict } = await resolveLocally(e, 'mine')
    const ndb = (await import('../src/storage/noteDb')).openNoteDb()
    await ndb.withDb((db) => db.put('sync', { state: 'bogus' }, NID))
    ndb.close()
    await expect(e.uploader.conflictResolved(NID, conflict as never)).rejects.toBeInstanceOf(NoteSaveError)
  })
})

describe('markResolved', () => {
  async function resolvedAndUploaded(e: Env, choice = 'mine') {
    const fileId = await conflicted(e)
    const { conflict } = await resolveLocally(e, choice)
    await e.uploader.conflictResolved(NID, conflict as never)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    return { fileId, conflict }
  }

  test('after the resolving upload is verified: kkjResolved on the Drive sidecar, the entry flagged, the local record gone', async () => {
    const e = await make()
    await resolvedAndUploaded(e)
    expect(oneFile(e, kid(PA, 'a2')).appProperties.kkjResolved).toBeUndefined() // not by the upload itself
    await e.uploader.markResolved(NID)
    expect(oneFile(e, kid(PA, 'a2')).appProperties.kkjResolved).toBe(NOW)
    const s = await e.sync()
    expect(s.info.conflicts[0]).toMatchObject({ resolvedAt: NOW, sidecarMarked: true })
    expect(await e.store.sidecars.get(NID, PA, 'a2')).toBeNull()
    // nothing more to do: no further Drive call
    const calls = e.drive.calls.length
    await e.uploader.markResolved(NID)
    expect(e.drive.calls.length).toBe(calls)
  })

  test('not before the resolve is on Drive (something is unsent)', async () => {
    const e = await make()
    await conflicted(e)
    const { conflict } = await resolveLocally(e, 'mine')
    await e.uploader.conflictResolved(NID, conflict as never)
    const calls = e.drive.calls.length
    await e.uploader.markResolved(NID)
    expect(e.drive.calls.length).toBe(calls)
    expect(oneFile(e, kid(PA, 'a2')).appProperties.kkjResolved).toBeUndefined()
  })

  test('no sidecar on Drive: the flag stays unset and the local record stays', async () => {
    const e = await make()
    await resolvedAndUploaded(e)
    e.drive.remove(oneFile(e, kid(PA, 'a2')).id)
    await e.uploader.markResolved(NID)
    const s = await e.sync()
    expect(s.info.conflicts[0]!.sidecarMarked).toBeUndefined()
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
  })

  test('a failure is logged per conflict, never thrown, and tried again next time', async () => {
    const e = await make()
    await resolvedAndUploaded(e)
    e.drive.failAlways('update', new DriveError('http', 403, 'forbidden'))
    await expect(e.uploader.markResolved(NID)).resolves.toBeUndefined()
    expect(e.events('error').at(-1)).toMatchObject({ class: 'fatal', noteId: NID, status: 403 })
    expect((await e.sync()).info.conflicts[0]!.sidecarMarked).toBeUndefined()
    expect(e.invalid).toEqual([])
    e.drive.clearFailures()
    await e.uploader.markResolved(NID)
    expect(oneFile(e, kid(PA, 'a2')).appProperties.kkjResolved).toBe(NOW)
  })
})

describe('cleanResolvedSidecars', () => {
  const DAY = 24 * 60 * 60 * 1000
  async function withResolved(e: Env) {
    await conflicted(e)
    const { conflict } = await resolveLocally(e, 'mine')
    await e.uploader.conflictResolved(NID, conflict as never)
    await e.uploader.upload(NID)
    await e.uploader.markResolved(NID)
  }

  test('resolved more than 30 days ago: the Drive sidecar is trashed, the entry flagged', async () => {
    let now = Date.parse(NOW) + SIDECAR_KEEP_MS - DAY // 29 days
    const e = await make({ now: () => now })
    await withResolved(e)
    const sc = oneFile(e, kid(PA, 'a2'))
    await e.uploader.cleanResolvedSidecars([NID])
    expect(sc.trashed).toBe(false)
    expect((await e.sync()).info.conflicts[0]!.sidecarTrashed).toBeUndefined()
    now = Date.parse(NOW) + SIDECAR_KEEP_MS + 1000 // just over 30 days
    await e.uploader.cleanResolvedSidecars([NID])
    expect(sc.trashed).toBe(true)
    expect((await e.sync()).info.conflicts[0]!.sidecarTrashed).toBe(true)
    // flagged: not looked at again
    const calls = e.drive.calls.length
    await e.uploader.cleanResolvedSidecars([NID])
    expect(e.drive.calls.length).toBe(calls)
  })

  test('an unresolved conflict is never cleaned, however old', async () => {
    const e = await make({ now: () => Date.parse(NOW) + 400 * DAY })
    await conflicted(e)
    const sc = oneFile(e, kid(PA, 'a2'))
    await e.uploader.cleanResolvedSidecars([NID])
    expect(sc.trashed).toBe(false)
  })

  test('no file found: no flag; a failure is logged and ignored', async () => {
    const e = await make({ now: () => Date.parse(NOW) + 31 * DAY })
    await withResolved(e)
    e.drive.failAlways('update', new DriveError('http', 403, 'forbidden'))
    await expect(e.uploader.cleanResolvedSidecars([NID])).resolves.toBeUndefined()
    expect(e.events('error').at(-1)).toMatchObject({ class: 'fatal', noteId: NID })
    expect((await e.sync()).info.conflicts[0]!.sidecarTrashed).toBeUndefined()
    e.drive.clearFailures()
    e.drive.remove(oneFile(e, kid(PA, 'a2')).id)
    await e.uploader.cleanResolvedSidecars([NID])
    expect((await e.sync()).info.conflicts[0]!.sidecarTrashed).toBeUndefined()
  })
})

describe('the coordinator', () => {
  const coordinator = (e: Env) =>
    createUploadCoordinator({
      store: e.store,
      uploader: e.uploader,
      log: e.deps.log,
      allowed: e.deps.allowed,
      online: e.deps.online,
      flushOpen: async () => {},
      openIds: () => [],
      locks: undefined,
    })

  test('conflictResolved records the entry; syncNow uploads the resolve and marks the sidecar', async () => {
    const e = await make()
    await conflicted(e)
    const c = coordinator(e)
    const { conflict } = await resolveLocally(e, 'both')
    const info = await c.conflictResolved(NID, conflict as never)
    expect(info.state).toBe('pending')
    await c.syncNow(NID)
    const s = await e.sync()
    expect(s.info.state).toBe('synced')
    expect(oneFile(e, kid(PA, 'a2')).appProperties.kkjResolved).toBe(NOW)
    expect(s.info.conflicts[0]).toMatchObject({ sidecarMarked: true })
  })

  test('a resolve with nothing to send is marked when the next trigger looks at the note', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const id = oneFile(e, NID).id
    const remote = two()
    remote.pages = remote.pages.filter((p) => p.id !== PB)
    remote.orderRev = 'o2'
    e.drive.foreignRevision(id, await bytesOf(remote))
    await e.store.writeNote(withStroke(two(), PB, 'b2'))
    await e.uploader.upload(NID)
    const c = coordinator(e)
    const { conflict } = await resolveLocally(e, 'remove')
    await c.conflictResolved(NID, conflict as never)
    await c.noteClosed(NID)
    expect(oneFile(e, kid(PB, 'b2')).appProperties.kkjResolved).toBe(NOW)
  })

  test('start trashes sidecars resolved more than 30 days ago', async () => {
    const e = await make({ now: () => Date.parse(NOW) + 31 * 24 * 60 * 60 * 1000 })
    await conflicted(e)
    const c = coordinator(e)
    const { conflict } = await resolveLocally(e, 'mine')
    await c.conflictResolved(NID, conflict as never)
    await c.syncNow(NID)
    await c.start()
    for (let i = 0; i < 50 && !oneFile(e, kid(PA, 'a2')).trashed; i++) await new Promise((r) => setTimeout(r, 10)) // start does not wait for it
    expect(oneFile(e, kid(PA, 'a2')).trashed).toBe(true)
  })

  test('marking with nothing to upload honors the other-tab check and runs under the sync lock', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const id = oneFile(e, NID).id
    const remote = two()
    remote.pages = remote.pages.filter((p) => p.id !== PB)
    remote.orderRev = 'o2'
    e.drive.foreignRevision(id, await bytesOf(remote))
    await e.store.writeNote(withStroke(two(), PB, 'b2'))
    await e.uploader.upload(NID)
    const locks = fakeLocks()
    const seen: boolean[] = []
    const markResolved = async (n: string) => {
      seen.push(await new Promise<boolean>((r) => void locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, (l) => r(l === null))))
      return e.uploader.markResolved(n)
    }
    const c = createUploadCoordinator({
      store: e.store,
      uploader: { upload: e.uploader.upload, resume: e.uploader.resume, markResolved },
      log: e.deps.log,
      allowed: e.deps.allowed,
      online: e.deps.online,
      flushOpen: async () => {},
      openIds: () => [],
      locks: locks as unknown as LockManager,
    })
    const { conflict } = await resolveLocally(e, 'remove')
    await e.uploader.conflictResolved(NID, conflict as never)
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    void locks.request(noteLockName(NID), {}, () => held) // an editor of another tab has the note
    await c.noteClosed(NID)
    expect(seen).toEqual([])
    release()
    await new Promise((r) => setTimeout(r, 10))
    await c.noteClosed(NID)
    expect(seen).toEqual([true]) // the sync lock was held while marking
    expect(oneFile(e, kid(PB, 'b2')).appProperties.kkjResolved).toBe(NOW)
  })

  test('a coordinator whose uploader cannot record says so', async () => {
    const e = await make()
    const c = createUploadCoordinator({
      store: e.store,
      uploader: { upload: e.uploader.upload, resume: e.uploader.resume },
      log: e.deps.log,
      allowed: () => true,
      online: () => true,
      flushOpen: async () => {},
      openIds: () => [],
      locks: undefined,
    })
    await expect(c.conflictResolved(NID, {})).rejects.toThrow()
  })
})
