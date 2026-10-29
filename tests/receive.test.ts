// The receive engine (Story 3.14) against the fake Drive and fake-indexeddb: every row
// of the spec's I/O matrix and the guards (each has a test that fails when it is removed).
import 'fake-indexeddb/auto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import type { Note } from '../src/model/note'
import { sessionHistory } from '../src/ops/sessionHistories'
import { DEVICE_STORE, NOTE_DB_NAME, deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { emptySync } from '../src/storage/syncInfo'
import { commitMerge } from '../src/sync/commitMerge'
import { registerOpenNote } from '../src/sync/openNotes'
import { fakeLocks } from './helpers'
import { type RxEnv, makeRxEnv } from './receiveHarness'
import { NID, PA, PB, foreignEdit, mkNote, withStroke } from './uploadHarness'

let env: RxEnv | undefined
const make = async (...a: Parameters<typeof makeRxEnv>) => (env = await makeRxEnv(...a))
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const NID2 = '01926f3a-0000-7000-8000-0000000000a2'
const two = (id = NID) => mkNote({ noteId: id, pages: { [PA]: 'a1', [PB]: 'b1' } })
const pageRev = (n: Note, id: string) => n.pages.find((p) => p.id === id)?.rev
const working = async (e: RxEnv, id = NID) => (await e.store.loadNote(id))!.note!
const token = async (e: RxEnv) => (await e.device.read()).pageToken
const downloads = (e: RxEnv) => e.drive.count('downloadRevision')
const states = (e: RxEnv) => e.events('stateChange').map((x) => `${x.from}>${x.to}`)

describe('first check on this browser', () => {
  test('start token first, cards from the summary without a download, token saved last', async () => {
    const e = await make()
    await e.remoteUpload(two(NID))
    await e.receiver.check()
    expect(downloads(e)).toBe(0)
    expect(await e.store.remote.get(NID)).toMatchObject({ title: '수학 노트', folderId: null, coverId: null, modifiedAt: '2026-10-10T04:20:00.000Z' })
    expect(await e.store.loadNote(NID)).toBeNull()
    expect(await token(e)).toBe(String(e.drive.changeCount()))
    const order = e.drive.calls.map((c) => c.split(' ')[0])
    expect(order.indexOf('getStartPageToken')).toBeLessThan(order.indexOf('list'))
    expect(e.drive.calls.find((c) => c.startsWith('list '))).toContain("mimeType='application/vnd.kkeujeok.kkj'")
    expect(e.invalid).toEqual([])
  })

  test('a file without a valid summary is downloaded and stored as a synced local note', async () => {
    const e = await make()
    const note = two()
    const up = await e.remoteUpload(note, { noSummary: true })
    await e.receiver.check()
    expect(downloads(e)).toBe(1)
    expect(await working(e)).toEqual(note)
    const s = await e.store.readSync(NID)
    expect(s).toMatchObject({ hasUnsent: false, base: note })
    expect(s.info).toMatchObject({ fileId: up.fileId, baseHeadRevisionId: up.head, state: 'synced' })
    expect(await e.store.remote.get(NID)).toBeNull()
  })

  test('the scan flag is set while the tree is listed and cleared after', async () => {
    const e = await make()
    await e.remoteUpload(two())
    const seen: boolean[] = []
    e.drive.hooks.beforeCall = (m) => m === 'list' && seen.push(e.receiver.getState().scanning)
    await e.receiver.check()
    expect(seen).toEqual([true])
    expect(e.receiver.getState().scanning).toBe(false)
  })

  test('a note that exists here is not turned into a card; a trashed file drops its card', async () => {
    const e = await make()
    const up = await e.remoteUpload(two(NID2))
    await e.receiver.check()
    expect(await e.store.remote.get(NID2)).not.toBeNull()
    e.drive.trash(up.fileId)
    await e.receiver.check()
    expect(await e.store.remote.get(NID2)).toBeNull()
  })

  test('a changed card (new head) is updated without a download and shows the badge first', async () => {
    const e = await make()
    const up = await e.remoteUpload(two())
    await e.receiver.check()
    const seen: boolean[] = []
    e.drive.hooks.beforeCall = (m) => m === 'get' && seen.push(true)
    const edited = foreignEdit(two(), PA, 'a2')
    const up2 = await e.remoteUpload(edited, { fileId: up.fileId })
    let badge: boolean | null = null
    const off = e.receiver.subscribe(() => (badge ??= e.receiver.getState().receiving.has(NID)))
    await e.receiver.check()
    off()
    expect(badge).toBe(true)
    expect((await e.store.remote.get(NID))!.headRevisionId).toBe(up2.head)
    expect(downloads(e)).toBe(0)
    expect(e.receiver.getState().receiving.size).toBe(0)
  })
})

describe('changes.list', () => {
  test('nothing changed: one changes.list, no download, token stays', async () => {
    const e = await make()
    await e.seedSynced(two())
    await e.receiver.check()
    e.drive.calls.length = 0
    const t = await token(e)
    await e.receiver.check()
    expect(e.drive.count('listChanges')).toBe(1)
    expect(downloads(e)).toBe(0)
    expect(await token(e)).toBe(t)
  })

  test('our own upload (head == base) is not downloaded or written', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.receiver.check()
    await e.uploader.upload(NID)
    const before = await e.store.readSync(NID)
    e.drive.calls.length = 0
    await e.receiver.check()
    expect(e.drive.count('listChanges')).toBe(1)
    expect(downloads(e)).toBe(0)
    expect(await e.store.readSync(NID)).toEqual(before)
  })

  test('closed note without unsent changes: badge before the download, working + base + sync replaced together', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const edited = foreignEdit(note, PB, 'b2')
    const up = await e.remoteUpload(edited, { fileId })
    const seen: boolean[] = []
    e.drive.hooks.beforeCall = (m) => m === 'downloadRevision' && seen.push(e.receiver.getState().receiving.has(NID))
    let version = e.receiver.getState().version
    await e.receiver.check()
    expect(seen).toEqual([true])
    expect(e.receiver.getState().receiving.size).toBe(0)
    expect(e.receiver.getState().version).toBeGreaterThan(version)
    expect(await working(e)).toEqual(edited)
    const s = await e.store.readSync(NID)
    expect(s.base).toEqual(edited)
    expect(s.hasUnsent).toBe(false)
    expect(s.info).toMatchObject({ baseHeadRevisionId: up.head, state: 'synced', lastError: null, pendingVerify: null })
    expect(states(e)).toEqual(['synced>syncing', 'syncing>synced'])
    expect(e.events('revisionDownloaded')).toHaveLength(1)
    expect(e.events('baseAdvanced').at(-1)).toMatchObject({ noteId: NID, revisionId: up.head })
    expect(await token(e)).toBe(String(e.drive.changeCount()))
    expect(e.invalid).toEqual([])
    version = 0
  })

  test('unsent changes: merged, base = remote, the note stays pending and keeps both edits', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.store.writeNote(withStroke(note, PA, 'a2'))
    const remote = foreignEdit(note, PB, 'b2')
    const up = await e.remoteUpload(remote, { fileId })
    await e.receiver.check()
    const w = await working(e)
    expect(pageRev(w, PB)).toBe('b2')
    expect(w.pages.find((p) => p.id === PA)!.elements).toHaveLength(1)
    const s = await e.store.readSync(NID)
    expect(s.base).toEqual(remote)
    expect(s.info.baseHeadRevisionId).toBe(up.head)
    expect(s.hasUnsent).toBe(true)
    expect(s.info.state).toBe('pending')
    expect(e.events('merged')).toHaveLength(1)
    expect(e.drive.uploads).toHaveLength(2) // the seed and the foreign edit: the receiver never uploads
  })

  test('a note open in this tab is merged through the editor registry', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const h = sessionHistory(note)
    let applied = 0
    const off = registerOpenNote(NID, {
      flush: async () => (await e.store.writeNote(h.note), true),
      current: () => h.note,
      applyMerge: (a) => (applied++, commitMerge(h, a)),
    })
    const remote = foreignEdit(note, PB, 'b2')
    const up = await e.remoteUpload(remote, { fileId })
    await e.receiver.check()
    off()
    expect(applied).toBe(1)
    expect(pageRev(h.note, PB)).toBe('b2')
    expect(pageRev(await working(e), PB)).toBe('b2')
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ baseHeadRevisionId: up.head, state: 'synced' })
  })

  test('a note open in another tab (its lock is taken) is left to that tab and announced', async () => {
    const locks = fakeLocks()
    const e = await make({ locks })
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const up = await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    void locks.request(`kkeujeok-note:${NID}`, {}, () => held)
    await new Promise((r) => setTimeout(r, 5))
    await e.receiver.check()
    release()
    expect(downloads(e)).toBe(0)
    expect(await working(e)).toEqual(note)
    expect(e.posted).toContainEqual({ t: 'remote', noteId: NID, fileId, head: up.head })
  })

  test('a note closed everywhere is received while this tab holds its lock', async () => {
    const locks = fakeLocks()
    const e = await make({ locks })
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    let heldDuring: boolean | null = null
    e.drive.hooks.beforeCall = (m) => {
      if (m !== 'downloadRevision') return
      void locks.request(`kkeujeok-note:${NID}`, { ifAvailable: true }, (l) => void (heldDuring = l === null))
    }
    await e.receiver.check()
    await new Promise((r) => setTimeout(r, 5))
    expect(heldDuring).toBe(true)
    expect(pageRev(await working(e), PB)).toBe('b2')
  })
})

describe('receive race guards (12.1)', () => {
  test('commitReceive refuses when the sync record changed after the decision, and when the note has unsent changes', async () => {
    const e = await make()
    const note = two()
    await e.seedSynced(note)
    const s = await e.store.readSync(NID)
    const next = { ...s.info, baseHeadRevisionId: 'r2' }
    await e.store.updateSync(NID, (c) => ({ ...c, unsentSidecars: [{ pageId: PA, rev: 'x' }] }))
    expect(await e.store.commitReceive(NID, note, note, next, s.info)).toBe(false)
    await e.store.updateSync(NID, (c) => ({ ...c, unsentSidecars: [] }))
    // a working copy that differs from the base is never replaced, even when `expected` is that copy
    const mine = withStroke(note, PA, 'a2')
    await e.store.writeNote(mine)
    expect(await e.store.commitReceive(NID, mine, note, next, (await e.store.readSync(NID)).info)).toBe(false)
    expect((await e.store.readSync(NID)).info.baseHeadRevisionId).toBe(s.info.baseHeadRevisionId)
  })

  test('three rejected commits: only that note waits, the token stays, it is logged and received again', async () => {
    let reject = true
    const e = await make({ locks: fakeLocks() })
    const real = e.store
    const flaky = e.mk({ store: { ...real, commitReceive: (...a: Parameters<typeof real.commitReceive>) => (reject ? Promise.resolve(false) : real.commitReceive(...a)) } })
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await flaky.check()
    const t = await token(e)
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await flaky.check()
    expect(await token(e)).toBe(t)
    expect(pageRev(await working(e), PB)).toBe(pageRev(note, PB))
    expect(e.events('error').some((x) => x.reason === 'receiveRejected' && x.noteId === NID)).toBe(true)
    reject = false
    await flaky.check()
    expect(pageRev(await working(e), PB)).toBe('b2')
  })

  test('a note whose lock is held is remembered and received by the next check', async () => {
    const locks = fakeLocks()
    const e = await make({ locks })
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    void locks.request(`kkeujeok-note:${NID}`, {}, () => held)
    await new Promise((r) => setTimeout(r, 5))
    await e.receiver.check()
    expect(pageRev(await working(e), PB)).toBe(pageRev(note, PB))
    expect(e.events('error').some((x) => x.reason === 'noteLocked')).toBe(true)
    release()
    await new Promise((r) => setTimeout(r, 5))
    await e.receiver.check()
    expect(pageRev(await working(e), PB)).toBe('b2')
  })

  test('a merge the editor could not take now (applyFailed) is retried by the next check, the note does not go to error', async () => {
    const e = await make()
    let defer = true
    const merge = { merge: async (a: Parameters<typeof e.deps.merge.merge>[0]) => (defer ? { result: 'error' as const, reason: 'applyFailed' } : e.deps.merge.merge(a)) }
    const rx = e.mk({ merge })
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await rx.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await rx.check()
    expect(pageRev(await working(e), PB)).toBe(pageRev(note, PB))
    expect((await e.sync()).info.state).not.toBe('error')
    expect(e.events('error').some((x) => x.reason === 'mergeDeferred' && x.noteId === NID)).toBe(true)
    defer = false
    await rx.check()
    expect(pageRev(await working(e), PB)).toBe('b2')
  })

  test('an error note skipped into retry is received again once it left error, and beforeOpen uses it', async () => {
    const e = await make({ locks: fakeLocks() })
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'error' }))
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.receiver.check()
    expect(pageRev(await working(e), PB)).toBe(pageRev(note, PB))
    expect(e.events('error').some((x) => x.reason === 'receiveSkippedError' && x.noteId === NID)).toBe(true)
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'pending' }))
    await e.receiver.beforeOpen(NID) // the remembered head, not the (already advanced) token
    expect(pageRev(await working(e), PB)).toBe('b2')
  })

  test('a note without a working copy is dropped from retry', async () => {
    const e = await make({ locks: fakeLocks() })
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'error' }))
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.receiver.check()
    await e.store.removeNote(NID, await working(e))
    e.drive.calls.length = 0
    await e.receiver.check()
    const before = e.events('error').length
    await e.receiver.check()
    expect(e.events('error').length).toBe(before)
  })

  test('commitReceive with the base record missing refuses cleanly', async () => {
    const e = await make()
    const note = two()
    await e.seedSynced(note)
    const s = await e.store.readSync(NID)
    const db = await openNoteDb()
    await db.withDb((d) => d.delete('base', NID))
    db.close()
    expect(await e.store.commitReceive(NID, note, note, { ...s.info, baseHeadRevisionId: 'r2' }, s.info)).toBe(false)
  })

  test('a downloadRevision 404 of a live file is transient, not a deletion', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    e.drive.failAt('downloadRevision', e.drive.count('downloadRevision') + 1, new DriveError('http', 404, 'notFound'))
    await e.receiver.check()
    const info = (await e.store.readSync(NID)).info
    expect(info.state).not.toBe('error')
    expect(info.lastError).toBeNull()
    expect(e.events('error').some((x) => x.reason === 'revisionNotFound')).toBe(true)
  })
})

describe('guards', () => {
  test('a stroke saved while the head downloads is never overwritten (stale snapshot)', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    const mine = withStroke(note, PA, 'a2')
    e.drive.hooks.beforeCall = (m) => {
      if (m === 'downloadRevision') void e.store.writeNote(mine) // lands before the commit
    }
    await e.receiver.check()
    const w = await working(e)
    expect(w.pages.find((p) => p.id === PA)!.elements).toHaveLength(1) // our stroke survived
    expect(pageRev(w, PB)).toBe('b2') // and the remote page arrived by the merge path
    expect((await e.store.readSync(NID)).hasUnsent).toBe(true)
  })

  test('commitReceive refuses when the working copy is not the one it was decided on', async () => {
    const e = await make()
    const note = two()
    await e.store.writeNote(withStroke(note, PA, 'a2'))
    const ok = await e.store.commitReceive(NID, note, note, { ...emptySync(), fileId: 'f', baseHeadRevisionId: 'r1', state: 'synced' }, emptySync())
    expect(ok).toBe(false)
    expect((await working(e)).pages.find((p) => p.id === PA)!.elements).toHaveLength(1)
    expect((await e.store.readSync(NID)).info.baseHeadRevisionId).toBeNull()
    // and a "new note" write refuses when a copy is there
    expect(await e.store.commitReceive(NID, null, note, { ...emptySync(), fileId: 'f', baseHeadRevisionId: 'r1', state: 'synced' }, emptySync())).toBe(false)
  })

  test('single-flight: concurrent checks share one changes.list', async () => {
    const e = await make()
    await e.seedSynced(two())
    await e.receiver.check()
    e.drive.calls.length = 0
    await Promise.all([e.receiver.check(), e.receiver.check(), e.receiver.check()])
    expect(e.drive.count('listChanges')).toBe(1)
  })

  test('gate closed or offline: no Drive call at all', async () => {
    const e = await make()
    await e.remoteUpload(two())
    e.drive.calls.length = 0
    e.flags.allowed = false
    await e.receiver.check()
    e.flags.allowed = true
    e.flags.online = false
    await e.receiver.check()
    expect(e.drive.calls).toEqual([])
    expect(await token(e)).toBeNull()
  })

  test('signed out or another account: nothing is requested or written', async () => {
    const e = await make()
    await e.remoteUpload(two())
    e.drive.calls.length = 0
    e.acct.current = null
    await e.receiver.check()
    expect(e.drive.calls).toEqual([])
    await e.device.adoptAccount('other', 'o@example.test')
    e.acct.current = { sub: 'sub-1', email: 'a@example.test' }
    await e.receiver.check()
    expect(e.drive.calls).toEqual([])
  })

  test('the account changes during the download: no write, no token', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const t = await token(e)
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    e.drive.hooks.beforeCall = (m) => {
      if (m === 'downloadRevision') e.acct.current = { sub: 'sub-2', email: 'b@example.test' }
    }
    await e.receiver.check()
    expect(await working(e)).toEqual(note)
    expect((await e.store.readSync(NID)).info.baseHeadRevisionId).not.toBeNull()
    expect(await token(e)).toBe(t)
    expect(e.receiver.getState().receiving.size).toBe(0)
  })

  test('the account changes right after the download is logged: the commit is not made', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    e.hooks.onLog = (event) => {
      if (event === 'revisionDownloaded') e.acct.current = { sub: 'sub-2', email: 'b@example.test' }
    }
    await e.receiver.check()
    expect(await working(e)).toEqual(note)
  })

  test('another tab tagged the device with another account before the token is saved: not saved', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const t = await token(e)
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    let tagged = false
    const device = { ...e.device, read: async () => ({ ...(await e.device.read()), ...(tagged && { sub: 'sub-2' }) }) }
    e.hooks.onLog = (event) => void (event === 'baseAdvanced' && (tagged = true))
    await e.mk({ device }).check()
    expect(pageRev(await working(e), PB)).toBe('b2')
    expect(await token(e)).toBe(t)
  })

  test('the account changes during changes.list: nothing is applied', async () => {
    const e = await make()
    await e.remoteUpload(two())
    await e.receiver.check()
    await e.remoteUpload(two(NID2))
    e.drive.hooks.beforeCall = (m) => {
      if (m === 'listChanges') e.acct.current = null
    }
    const t = await token(e)
    await e.receiver.check()
    expect(await e.store.remote.get(NID2)).toBeNull()
    expect(await token(e)).toBe(t)
  })

  test('an unreadable device record is never overwritten: error deviceUnreadable, no Drive call', async () => {
    const e = await make()
    const ndb = openNoteDb()
    await ndb.withDb((db) => db.put(DEVICE_STORE, 'garbage', 'device'))
    e.drive.calls.length = 0
    await e.receiver.check()
    expect(e.drive.calls).toEqual([])
    expect(e.events('error').at(-1)).toMatchObject({ class: 'fatal', reason: 'deviceUnreadable' })
    expect(await ndb.withDb((db) => db.get(DEVICE_STORE, 'device'))).toBe('garbage')
    ndb.close()
  })

  test('the token is saved only after every change was applied', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const t = await token(e)
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    e.drive.failAlways('downloadRevision', new DriveError('network'))
    await e.receiver.check()
    expect(await token(e)).toBe(t)
    expect(e.sleeps).toHaveLength(6) // sync.backoff: six waits, the 7th failure ends it
    expect(e.events('backoff')).toHaveLength(6)
    expect(e.events('error').at(-1)).toMatchObject({ class: 'backoff', noteId: NID })
    expect((await e.store.readSync(NID)).info.state).toBe('syncing') // "Start" receives it again
    expect(await working(e)).toEqual(note)
    // the connection is back: the same change comes again and ends the receive
    e.drive.clearFailures()
    await e.receiver.check()
    expect(pageRev(await working(e), PB)).toBe('b2')
    expect((await e.store.readSync(NID)).info.state).toBe('synced')
    expect(await token(e)).toBe(String(e.drive.changeCount()))
  })

  test('a note in error or with an unfinished upload is skipped', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'error', lastError: { class: 'fatal' } }))
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.receiver.check()
    expect(downloads(e)).toBe(0)
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'syncing', lastError: null, pendingVerify: { parentRevisionId: null, oursRevisionId: null, round: 1 } }))
    await e.remoteUpload(foreignEdit(note, PB, 'b3'), { fileId })
    await e.receiver.check()
    expect(downloads(e)).toBe(0)
  })

  test('an unreadable working copy is never overwritten', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const ndb = openNoteDb()
    await ndb.withDb((db) => db.put('notes', gzipSync(Buffer.from('not a note')), NID))
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.receiver.check()
    expect(downloads(e)).toBe(0)
    expect((await e.store.loadNote(NID))!.result).toBe('unreadable')
    ndb.close()
  })
})

describe('failures', () => {
  test('a newer-format remote is not written: error unreadable/unsupportedVersion', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    const bytes = gzipSync(Buffer.from(JSON.stringify({ ...note, formatVersion: 99 })))
    e.drive.foreignRevision(fileId, new Uint8Array(bytes))
    await e.receiver.check()
    expect(await working(e)).toEqual(note)
    expect((await e.store.readSync(NID)).info).toMatchObject({ state: 'error', lastError: { class: 'unreadable', reason: 'unsupportedVersion' } })
    expect(e.events('error').at(-1)).toMatchObject({ class: 'unreadable', reason: 'unsupportedVersion' })
  })

  test.each([400, 404, 410])('page token rejected (%i): logged, new token, rescan, token saved last', async (status) => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.remoteUpload(two(NID2)) // a note the token would have shown too
    e.drive.rejectTokens(status)
    e.drive.calls.length = 0
    await e.receiver.check()
    expect(e.events('pageTokenRejected')).toHaveLength(1)
    const order = e.drive.calls.map((c) => c.split(' ')[0])
    expect(order.indexOf('listChanges')).toBeLessThan(order.indexOf('getStartPageToken'))
    expect(order.indexOf('getStartPageToken')).toBeLessThan(order.indexOf('list'))
    expect(pageRev(await working(e), PB)).toBe('b2')
    expect(await e.store.remote.get(NID2)).not.toBeNull()
    expect(await token(e)).toBe(String(e.drive.changeCount()))
  })

  test('a rescan that fails keeps the old token', async () => {
    const e = await make()
    await e.seedSynced(two())
    await e.receiver.check()
    const t = await token(e)
    e.drive.rejectTokens(410)
    e.drive.failAlways('list', new DriveError('http', 403, 'storageQuotaExceeded'))
    await e.receiver.check()
    expect(await token(e)).toBe(t)
    expect(e.events('error').at(-1)).toMatchObject({ class: 'quota' })
  })

  test('reauth (401) is logged and leaves the token and the notes', async () => {
    const e = await make()
    await e.seedSynced(two())
    await e.receiver.check()
    const t = await token(e)
    e.drive.failAt('listChanges', e.drive.count('listChanges') + 1, new DriveError('http', 401))
    await e.receiver.check()
    expect(e.events('error').at(-1)).toMatchObject({ class: 'reauth' })
    expect(await token(e)).toBe(t)
  })

  test('Start: a note left syncing is received again; one already current settles', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'syncing' }))
    const fresh = e.mk()
    await fresh.check()
    expect((await e.store.readSync(NID)).info.state).toBe('synced')
    await e.store.updateSync(NID, (c) => ({ ...c, state: 'syncing' }))
    const up = await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.mk().check() // the change list also shows it; either path ends the receive
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ state: 'synced', baseHeadRevisionId: up.head })
  })
})

describe('opening a note', () => {
  test('a card is downloaded before the editor opens, then the card is gone', async () => {
    const e = await make()
    const note = two()
    await e.remoteUpload(note)
    await e.receiver.check()
    expect(await e.store.loadNote(NID)).toBeNull()
    await e.receiver.beforeOpen(NID)
    expect(await working(e)).toEqual(note)
    expect(await e.store.remote.get(NID)).toBeNull()
    expect((await e.store.readSync(NID)).info.state).toBe('synced')
  })

  test('a card whose download fails rejects and stays a card', async () => {
    const e = await make()
    await e.remoteUpload(two())
    await e.receiver.check()
    e.drive.failAlways('downloadRevision', new DriveError('http', 404, 'notFound'))
    await expect(e.receiver.beforeOpen(NID)).rejects.toBeTruthy()
    expect(await e.store.remote.get(NID)).not.toBeNull()
    expect(await e.store.loadNote(NID)).toBeNull()
  })

  test('a note flagged receiving is received before it opens', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    let resolved = false
    const seen: Promise<void>[] = []
    e.drive.hooks.beforeCall = (m) => {
      if (m === 'downloadRevision' && !resolved) {
        resolved = true
        seen.push(e.receiver.beforeOpen(NID)) // opened while the poll is receiving it
      }
    }
    await e.receiver.check()
    await Promise.all(seen)
    expect(pageRev(await working(e), PB)).toBe('b2')
    expect(downloads(e)).toBe(1) // one receive, shared by the chain
  })

  test('offline: the device copy opens at once, no request', async () => {
    const e = await make()
    await e.seedSynced(two())
    e.flags.online = false
    e.drive.calls.length = 0
    await e.receiver.beforeOpen(NID)
    await e.receiver.noteOpened(NID)
    expect(e.drive.calls).toEqual([])
  })

  test('noteOpened with the base gone and a known head receives it (not stale)', async () => {
    const e = await make()
    const note = two()
    const { head } = await e.seedSynced(note)
    const h = sessionHistory(note)
    let applied = 0
    const off = registerOpenNote(NID, {
      flush: async () => (await e.store.writeNote(h.note), true),
      current: () => h.note,
      applyMerge: (a) => (applied++, commitMerge(h, a)),
    })
    await e.store.updateSync(NID, (c) => ({ ...c, baseHeadRevisionId: null, extra: { ...c.extra, knownRevisionIds: [head] } }))
    await e.receiver.noteOpened(NID)
    off()
    expect(downloads(e)).toBe(1)
  })

  test('noteOpened asks the remote head once and receives through the open editor when it differs', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    const h = sessionHistory(note)
    let applied = 0
    const off = registerOpenNote(NID, {
      flush: async () => (await e.store.writeNote(h.note), true),
      current: () => h.note,
      applyMerge: (a) => (applied++, commitMerge(h, a)),
    })
    e.drive.calls.length = 0
    await e.receiver.noteOpened(NID)
    expect(e.drive.count('get')).toBe(1) // head == base: nothing else
    expect(downloads(e)).toBe(0)
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.receiver.noteOpened(NID)
    off()
    expect(applied).toBe(1)
    expect(pageRev(h.note, PB)).toBe('b2')
  })

  test('a note that was never uploaded is not asked about', async () => {
    const e = await make()
    await e.store.writeNote(two())
    e.drive.calls.length = 0
    await e.receiver.noteOpened(NID)
    expect(e.drive.calls).toEqual([])
  })
})

describe('sharing with the uploader and other tabs', () => {
  test('a receive and an upload of one note never overlap (one chain per note)', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.store.writeNote(withStroke(note, PA, 'a2'))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const log: string[] = []
    const real = e.drive.downloadRevision.bind(e.drive)
    e.drive.downloadRevision = async (f: string, r: string) => {
      log.push('download start')
      await gate
      log.push('download end')
      return real(f, r)
    }
    const realGet = e.drive.get.bind(e.drive)
    e.drive.get = (async (id: string, o?: { fields?: string }) => (log.push('upload get'), realGet(id, o))) as typeof e.drive.get
    const rx = e.receiver.check()
    await new Promise((r) => setTimeout(r, 20))
    const up = e.uploader.upload(NID)
    await new Promise((r) => setTimeout(r, 20))
    expect(log).toEqual(['download start']) // the upload waits for the receive of the same note
    release()
    await rx
    await up
    expect(log.indexOf('upload get')).toBeGreaterThan(log.indexOf('download end'))
  })

  test('a message from another tab: "changed" bumps the version; "remote" for a note open here receives it', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    const v = e.receiver.getState().version
    await e.receiver.onMessage({ t: 'changed' })
    expect(e.receiver.getState().version).toBe(v + 1)
    expect(e.posted).toEqual([]) // not echoed
    const up = await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.receiver.onMessage({ t: 'remote', noteId: NID, fileId, head: up.head }) // not open here: ignored
    expect(downloads(e)).toBe(0)
    const h = sessionHistory(note)
    const off = registerOpenNote(NID, { flush: async () => (await e.store.writeNote(h.note), true), current: () => h.note, applyMerge: (a) => commitMerge(h, a) })
    await e.receiver.onMessage({ t: 'remote', noteId: NID, fileId, head: up.head })
    off()
    expect(pageRev(h.note, PB)).toBe('b2')
  })

  test('the db name is the note db (a remote card lives in it)', async () => {
    const e = await make()
    await e.remoteUpload(two())
    await e.receiver.check()
    expect((await indexedDB.databases()).map((d) => d.name)).toContain(NOTE_DB_NAME)
  })
})
