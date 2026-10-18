// Story 3.20, upload side: a merge that raises a conflict is applied, the losing page goes to
// `.conflicts/<noteId>/<pageId>-<rev>.json` BEFORE the note (sync.md step 0), by idempotent creation,
// and the device lets go of the sidecar only when Drive has it. Fake Drive + fake-indexeddb.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { decodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import type { Conflict, Sidecar } from '../src/sync/merge'
import { type Env, NID, PA, PB, bytesOf, foreignEdit, makeEnv, mkNote, withStroke } from './uploadHarness'

let env: Env | undefined
const make: typeof makeEnv = async (o) => (env = await makeEnv(o))
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const FOLDER = 'application/vnd.google-apps.folder'
const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const pageRev = (n: Note, id: string) => n.pages.find((p) => p.id === id)?.rev
const head = async (e: Env, fileId: string) => (await decodeKkj(e.drive.revisions(fileId).at(-1)!.bytes)).note!
const kid = (pageId: string, rev: string) => `sc:${NID}:${pageId}:${rev}`
const one = (e: Env, id: string) => {
  const found = e.drive.byKkeujeokId(id)
  expect(found).toHaveLength(1)
  return found[0]!
}

/** The note is on Drive; both devices then edit page A: the remote one at once, this one locally. */
async function twoEdits(e: Env) {
  await e.store.writeNote(two())
  expect(await e.uploader.upload(NID)).toBe('uploaded')
  const file = one(e, NID)
  e.drive.foreignRevision(file.id, await bytesOf(foreignEdit(two(), PA, 'a3')))
  await e.store.writeNote(withStroke(two(), PA, 'a2'))
  return file.id
}
const uploadsByName = (e: Env) => e.drive.uploads.map((u) => (u.metadata.name as string | undefined) ?? '')

describe('a conflict found while uploading', () => {
  test('sidecar first (folders by kkeujeokId), then the note; the sidecar leaves the device after Drive has it', async () => {
    const e = await make()
    const id = await twoEdits(e)
    expect(await e.uploader.upload(NID)).toBe('uploaded')

    const conflicts = one(e, 'conflicts')
    expect(conflicts).toMatchObject({ name: '.conflicts', mimeType: FOLDER, parents: ['ROOT'] })
    const cf = one(e, `cf:${NID}`)
    expect(cf).toMatchObject({ name: NID, mimeType: FOLDER, parents: [conflicts.id] })
    const sc = one(e, kid(PA, 'a2'))
    expect(sc).toMatchObject({ name: `${PA}-a2.json`, mimeType: 'application/json', parents: [cf.id] })
    expect(sc.appProperties).toEqual({ kkeujeokId: kid(PA, 'a2'), kkjEdited: '2026-10-11T04:20:00.000Z', kkjIndex: '0' })
    const body = JSON.parse(new TextDecoder().decode(sc.revs[0]!.bytes)) as Sidecar
    expect(Object.keys(body)).toEqual(['noteId', 'pageId', 'rev', 'seq', 'editedAt', 'editedBy', 'kind', 'page'])
    expect(body).toMatchObject({ noteId: NID, pageId: PA, rev: 'a2', kind: 'bothEdited' })
    expect(body.page.rev).toBe('a2')
    expect(body.page.elements).toHaveLength(1) // this device's stroke

    // The sidecar request came before the note's new revision.
    const names = uploadsByName(e)
    expect(names.indexOf(`${PA}-a2.json`)).toBeGreaterThan(0)
    expect(e.drive.uploads.at(-1)!.fileId).toBe(id)
    expect(e.drive.uploads.findIndex((u) => u.metadata.name === `${PA}-a2.json`)).toBeLessThan(e.drive.uploads.length - 1)
    // The note on Drive and on the device has the REMOTE page; the sidecar is not in the .kkj.
    expect(pageRev(await head(e, id), PA)).toBe('a3')
    expect(pageRev((await e.store.loadNote(NID))!.note!, PA)).toBe('a3')
    expect(JSON.stringify(await head(e, id))).not.toContain('"a2"')

    const s = await e.sync()
    expect(s.info.state).toBe('conflict')
    expect(s.info.conflicts).toEqual([
      { pageId: PA, kind: 'bothEdited', rev: 'a2', theirsRev: 'a3', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null },
    ])
    expect(s.info.unsentSidecars).toEqual([])
    expect(s.hasUnsent).toBe(false)
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull() // unresolved: kept for the resolve dialog (Story 3.22)
    expect((await e.device.read()).conflictsFolderId).toBe(conflicts.id)
    expect((await e.device.read()).createIntents).toEqual([])
    expect(e.invalid).toEqual([])
  })

  test('the state moves by conflictFound and the log has one entry per sidecar, never a page id', async () => {
    const e = await make()
    await twoEdits(e)
    await e.uploader.upload(NID)
    const states = e.events('stateChange').map((x) => `${x.from}>${x.to}`)
    expect(states.slice(-2)).toEqual(['pending>syncing', 'syncing>conflict'])
    expect(e.events('conflictFound')).toHaveLength(1)
    expect(JSON.stringify(e.entries)).not.toContain(PA)
    expect(e.events('merged')).toHaveLength(1)
  })

  test('the other pages sync in the same run', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const id = one(e, NID).id
    const remote = foreignEdit(foreignEdit(two(), PA, 'a3'), PB, 'b3')
    e.drive.foreignRevision(id, await bytesOf(remote))
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    await e.uploader.upload(NID)
    const h = await head(e, id)
    expect([pageRev(h, PA), pageRev(h, PB)]).toEqual(['a3', 'b3'])
    expect((await e.sync()).info.state).toBe('conflict')
  })

  test('a page the other device deleted: the page leaves the note, the sidecar keeps this device version', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const id = one(e, NID).id
    const remote = two()
    remote.pages = remote.pages.filter((p) => p.id !== PB)
    remote.orderRev = 'o2'
    e.drive.foreignRevision(id, await bytesOf(remote))
    await e.store.writeNote(withStroke(two(), PB, 'b2'))
    await e.uploader.upload(NID)
    expect((await e.store.loadNote(NID))!.note!.pages.map((p) => p.id)).toEqual([PA])
    const sc = one(e, kid(PB, 'b2'))
    expect(sc.appProperties.kkjIndex).toBe('1')
    expect(JSON.parse(new TextDecoder().decode(sc.revs[0]!.bytes))).toMatchObject({ kind: 'remoteDeleted', pageId: PB })
    const s = await e.sync()
    expect(s.info.state).toBe('conflict')
    expect(s.info.conflicts[0]).toMatchObject({ kind: 'remoteDeleted', theirsRev: null, originalIndex: 1 })
  })

  test('a second upload with the conflict still open uploads nothing again', async () => {
    const e = await make()
    await twoEdits(e)
    await e.uploader.upload(NID)
    const calls = e.drive.calls.length
    expect(await e.uploader.upload(NID)).toBe('skipped')
    expect(e.drive.calls.length).toBe(calls)
  })
})

describe('the sidecar must be on Drive before the device lets go', () => {
  test('a failing sidecar upload: the note is NOT uploaded, record and list entry stay, the merge is already applied', async () => {
    const e = await make()
    const id = await twoEdits(e)
    const revs = e.drive.revisions(id).length
    e.drive.failAt('uploadSimple', 2, new DriveError('http', 403, 'storageQuotaExceeded')) // 1 = the first note, 2 = the sidecar
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(e.drive.revisions(id)).toHaveLength(revs)
    expect(e.drive.byKkeujeokId(kid(PA, 'a2'))).toHaveLength(0)
    const s = await e.sync()
    expect(s.info.state).toBe('error')
    expect(s.info.lastError).toMatchObject({ class: 'quota' })
    expect(s.info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a2' }])
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
    expect(s.info.conflicts).toHaveLength(1)
    expect(pageRev((await e.store.loadNote(NID))!.note!, PA)).toBe('a3') // the remote page is in, this version is safe in the sidecar
    // [다시 시도]: the sidecar goes, then the note state is settled.
    e.drive.clearFailures()
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'pending' }))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.byKkeujeokId(kid(PA, 'a2'))).toHaveLength(1)
    const after = await e.sync()
    expect(after.info.unsentSidecars).toEqual([])
    expect(after.info.state).toBe('conflict')
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
  })

  test('a file whose checksum is not ours: the record and the list entry are kept, the note is not uploaded', async () => {
    const e = await make()
    const id = await twoEdits(e)
    const revs = e.drive.revisions(id).length
    e.drive.hooks.corruptMd5 = true
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'fatal', reason: 'md5Mismatch' })
    expect((await e.sync()).info.unsentSidecars).toHaveLength(1)
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
    expect(e.drive.revisions(id)).toHaveLength(revs)
  })

  test('a lost answer of the sidecar create: it is found by its kkeujeokId, never created twice', async () => {
    const e = await make()
    await twoEdits(e)
    e.drive.loseAnswer('uploadSimple', 2)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.byKkeujeokId(kid(PA, 'a2'))).toHaveLength(1)
    expect(e.sleeps.length).toBeGreaterThan(0) // one backoff
    expect((await e.sync()).info.unsentSidecars).toEqual([])
  })

  test('a crash right after the sidecar was created: the next run finds it, does not create it again, then lets go of the record', async () => {
    const e = await make()
    await twoEdits(e)
    let n = 0
    e.drive.hooks.afterUploadAsync = () => {
      if (++n === 1) throw new Error('crash after the sidecar create') // the first request of this run is the sidecar
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('crash')
    expect(e.drive.byKkeujeokId(kid(PA, 'a2'))).toHaveLength(1)
    expect((await e.sync()).info.unsentSidecars).toHaveLength(1) // the device had not let go yet
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
    e.drive.hooks.afterUploadAsync = undefined
    const sidecarCreates = e.drive.uploads.filter((u) => u.metadata.name === `${PA}-a2.json`).length
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'pending' }))
    await e.reload().upload(NID)
    expect(e.drive.uploads.filter((u) => u.metadata.name === `${PA}-a2.json`)).toHaveLength(sidecarCreates)
    expect(e.drive.byKkeujeokId(kid(PA, 'a2'))).toHaveLength(1)
    expect((await e.sync()).info.unsentSidecars).toEqual([])
    expect(await e.store.sidecars.get(NID, PA, 'a2')).not.toBeNull()
  })

  test('the listing lags behind the creates: the response ids are used, no duplicates appear', async () => {
    const e = await make()
    await twoEdits(e)
    e.drive.lagOn()
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    e.drive.settle()
    expect(e.drive.byKkeujeokId('conflicts')).toHaveLength(1)
    expect(e.drive.byKkeujeokId(`cf:${NID}`)).toHaveLength(1)
    expect(e.drive.byKkeujeokId(kid(PA, 'a2'))).toHaveLength(1)
    expect(one(e, kid(PA, 'a2')).parents).toEqual([one(e, `cf:${NID}`).id])
  })

  test('duplicate .conflicts folders: the earliest stays, children move into it, the other is trashed last', async () => {
    const e = await make()
    await twoEdits(e)
    const make1 = (name: string, kkeujeokId: string, parents: string[]) =>
      e.drive.create({ name, mimeType: FOLDER, parents, appProperties: { kkeujeokId } })
    const keep = await make1('.conflicts', 'conflicts', ['ROOT'])
    const dup = await make1('.conflicts', 'conflicts', ['ROOT'])
    const cfInDup = await make1(NID, `cf:${NID}`, [dup.id])
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.items.get(dup.id)!.trashed).toBe(true)
    expect(e.drive.items.get(keep.id)!.trashed).toBe(false)
    expect(e.drive.items.get(cfInDup.id)!.parents).toEqual([keep.id])
    expect(one(e, kid(PA, 'a2')).parents).toEqual([cfInDup.id])
    expect(e.events('duplicatesCleaned').at(-1)).toMatchObject({ count: 1 })
    // the order: children moved, trash last
    const updates = e.drive.calls.filter((c) => c.startsWith('update '))
    expect(updates.at(-1)).toContain('"trashed":true')
  })

  test('duplicate sidecar files of one id: one stays, the rest are trashed', async () => {
    const e = await make()
    await twoEdits(e)
    // a crashed device left two files for the same sidecar
    const conflictsFolder = await e.drive.create({ name: '.conflicts', mimeType: FOLDER, parents: ['ROOT'], appProperties: { kkeujeokId: 'conflicts' } })
    const cf = await e.drive.create({ name: NID, mimeType: FOLDER, parents: [conflictsFolder.id], appProperties: { kkeujeokId: `cf:${NID}` } })
    const x = await e.drive.create({ name: 'x.json', parents: [cf.id], appProperties: { kkeujeokId: kid(PA, 'a2') } })
    const y = await e.drive.create({ name: 'y.json', parents: [cf.id], appProperties: { kkeujeokId: kid(PA, 'a2') } })
    await e.uploader.upload(NID)
    expect(e.drive.items.get(x.id)!.trashed).toBe(false)
    expect(e.drive.items.get(y.id)!.trashed).toBe(true)
    expect(e.drive.uploads.filter((u) => u.metadata.name === `${PA}-a2.json`)).toHaveLength(0) // found, not created again
    expect((await e.sync()).info.unsentSidecars).toEqual([])
  })

  test('a missing local record cannot block the note for ever: the entry is dropped and logged', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    await e.store.updateSync(NID, (c) => ({ ...c, unsentSidecars: [{ pageId: PA, rev: 'zz' }] }))
    await e.uploader.upload(NID)
    expect((await e.sync()).info.unsentSidecars).toEqual([])
    expect(e.events('error').at(-1)).toMatchObject({ class: 'fatal', reason: 'sidecarMissing' })
  })

  test('without a root folder id nothing is created', async () => {
    const e = await make({ rootFolderId: null })
    await e.store.writeNote(two())
    await e.store.recordConflicts(NID, {
      conflicts: [{ pageId: PA, kind: 'bothEdited', rev: 'a2', theirsRev: 'a3', detectedAt: 'x', originalIndex: 0, resolvedAt: null } as Conflict],
      sidecars: [{ noteId: NID, pageId: PA, rev: 'a2', seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: two().pages[0]! }],
    })
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.sync()).info.lastError).toMatchObject({ reason: 'rootMissing' })
    expect(e.drive.items.size).toBe(0)
  })
})

describe('sidecars only', () => {
  const rec = (resolvedAt: string | null) => ({
    conflicts: [{ pageId: PA, kind: 'bothEdited', rev: 'a2', theirsRev: 'a3', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 1, resolvedAt } as Conflict],
    sidecars: [{ noteId: NID, pageId: PA, rev: 'a2', seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: two().pages[0]! } as Sidecar],
  })

  test('the note itself is on Drive: only the sidecar goes, no new revision, the state follows the open conflicts', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const id = one(e, NID).id
    await e.store.recordConflicts(NID, rec(null))
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'conflict' }))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.revisions(id)).toHaveLength(1)
    expect(one(e, kid(PA, 'a2')).appProperties.kkjIndex).toBe('1')
    const s = await e.sync()
    expect(s.info.state).toBe('conflict')
    expect(s.hasUnsent).toBe(false)
    expect(e.events('uploadStarted')).toHaveLength(1) // only the first note upload
  })

  test('a sidecar of an already resolved conflict is created with kkjResolved', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    await e.store.recordConflicts(NID, rec('2026-10-12T05:00:00.000Z'))
    await e.uploader.upload(NID)
    expect(one(e, kid(PA, 'a2')).appProperties.kkjResolved).toBe('2026-10-12T05:00:00.000Z')
    expect((await e.sync()).info.state).toBe('synced') // nothing open any more
  })
})

describe('a failure while the note is in conflict', () => {
  test('conflict -> upload -> syncing -> failed: the note ends in error, the conflict stays in sync.json', async () => {
    const e = await make()
    await twoEdits(e)
    e.drive.failAt('uploadSimple', 3, new DriveError('http', 403, 'storageQuotaExceeded')) // 3 = the note after its sidecar
    expect(await e.uploader.upload(NID)).toBe('failed')
    const s = await e.sync()
    expect(s.info.state).toBe('error')
    expect(s.info.conflicts).toHaveLength(1)
    expect(s.info.unsentSidecars).toEqual([]) // the sidecar was confirmed before the note failed
    expect(e.events('stateChange').map((x) => `${x.from}>${x.to}`).slice(-2)).toEqual(['syncing>conflict', 'conflict>error'])
  })
})

describe('the cached .conflicts folder id', () => {
  const entry = (pageId: string, rev: string) => ({
    conflicts: [{ pageId, kind: 'bothEdited', rev, theirsRev: 'x', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null } as Conflict],
    sidecars: [{ noteId: NID, pageId, rev, seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: two().pages.find((p) => p.id === pageId)! } as Sidecar],
  })
  /** One sidecar is on Drive, so `.conflicts` exists and its id is cached; a second one waits. */
  async function seeded() {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    await e.store.recordConflicts(NID, entry(PA, 'a2'))
    await e.uploader.upload(NID)
    const cached = (await e.device.read()).conflictsFolderId!
    expect(cached).toBeTruthy()
    await e.store.recordConflicts(NID, entry(PB, 'b2'))
    return { e, cached }
  }

  test('alive: the sidecar lands in it and no .conflicts is created again', async () => {
    const { e, cached } = await seeded()
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.byKkeujeokId('conflicts')).toHaveLength(1)
    expect((await e.device.read()).conflictsFolderId).toBe(cached)
    expect(one(e, `cf:${NID}`).parents).toEqual([cached])
    expect(one(e, kid(PB, 'b2')).parents).toEqual([one(e, `cf:${NID}`).id])
  })

  test.each([
    ['trashed', (e: Env, id: string) => e.drive.trash(id)],
    ['gone (404)', (e: Env, id: string) => e.drive.remove(id)],
  ])('%s: a new one is found or created, cached, and the sidecar goes under it', async (_n, kill) => {
    const { e, cached } = await seeded()
    kill(e, cached)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    const now = (await e.device.read()).conflictsFolderId!
    expect(now).not.toBe(cached)
    expect(e.drive.byKkeujeokId('conflicts').filter((f) => !f.trashed).map((f) => f.id)).toEqual([now])
    expect(one(e, kid(PB, 'b2'))).toBeTruthy()
    expect((await e.sync()).info.unsentSidecars).toEqual([])
  })

  test('another error on the cached get is not taken for "gone"', async () => {
    const { e, cached } = await seeded()
    e.drive.clearFailures()
    e.drive.failAlways('get', new DriveError('http', 403, 'forbidden'))
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.device.read()).conflictsFolderId).toBe(cached)
    expect(e.drive.byKkeujeokId(kid(PB, 'b2'))).toHaveLength(0)
    expect((await e.sync()).info.unsentSidecars).toEqual([{ pageId: PB, rev: 'b2' }])
  })
})

describe('sidecars only, edited meanwhile', () => {
  test('an edit during the sidecar upload the edit is kept as unsent', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    await e.store.recordConflicts(NID, {
      conflicts: [{ pageId: PA, kind: 'bothEdited', rev: 'a2', theirsRev: 'a3', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null } as Conflict],
      sidecars: [{ noteId: NID, pageId: PA, rev: 'a2', seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: two().pages[0]! } as Sidecar],
    })
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'conflict' }))
    // The edit lands right after the `verified` commit (its state change is logged), before the final re-read.
    let edited = false
    const append = e.deps.log.append
    e.deps.log.append = async (ev: string, f: Record<string, unknown> = {}) => {
      const r = await append(ev, f)
      if (ev === 'stateChange' && f.to === 'conflict' && !edited) {
        edited = true
        await e.store.writeNote(withStroke(two(), PB, 'b2'))
      }
      return r
    }
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(edited).toBe(true)
    const s = await e.sync()
    expect(s.info.state).toBe('conflict') // rules: 'conflict edit' stays conflict
    expect(s.hasUnsent).toBe(true)
  })
})
