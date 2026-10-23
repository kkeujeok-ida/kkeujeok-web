// Story 3.25, the sync side of the version history: the Drive revision / sidecar calls on the fake Drive, the
// outcome-returning upload-and-verify, and the restore procedure (read, upload+verify, pin, queue apply, leftover
// conflicts) with every failing step leaving the note unchanged. Fake Drive + fake-indexeddb.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { encodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { History } from '../src/ops/history'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { unresolvedOf } from '../src/sync/conflicts'
import { createUploadCoordinator } from '../src/sync/uploadCoordinator'
import { type RestoreApply, createVersionRestorer, createVersionSource } from '../src/sync/versionHistory'
import { type VersionEntry, versionListRule } from '../src/sync/versionList'
import { Writer } from '../src/ui/library/writer'
import { resolveConflict } from '../src/ops/resolveConflict'
import type { Conflict } from '../src/sync/merge'
import { type Env, NID, PA, PB, bytesOf, foreignEdit, makeEnv, mkNote, withStroke } from './uploadHarness'

let env: Env | undefined
const make: typeof makeEnv = async (o) => (env = await makeEnv(o))
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const NOW = '2026-10-13T00:00:00.000Z'
// version.list only accepts sidecars whose page id and rev are UUIDs
const REV2 = '01926f3a-0000-7000-8000-0000000000c2'
const REV3 = '01926f3a-0000-7000-8000-0000000000c3'
const strokeIds = (n: Note, pageId: string) => (n.pages.find((p) => p.id === pageId)?.elements as { id: string }[] | undefined)?.map((s) => s.id)

function setup(e: Env, o: { restorerCoordinator?: Partial<ReturnType<typeof coordinatorOf>> } = {}) {
  const coordinator = { ...coordinatorOf(e), ...o.restorerCoordinator }
  const source = createVersionSource(e.drive)
  let n = 0
  const restorer = createVersionRestorer({
    drive: e.drive,
    store: e.store,
    coordinator: coordinator as ReturnType<typeof coordinatorOf>,
    source,
    now: () => NOW,
    newRev: () => `01926f3a-0000-7000-8000-${String(900 + ++n).padStart(12, '0')}`,
    editedBy: () => 'Chrome, Windows',
  })
  return { coordinator, source, restorer }
}
function coordinatorOf(e: Env) {
  return createUploadCoordinator({
    store: e.store,
    uploader: e.uploader,
    log: e.deps.log,
    allowed: () => e.flags.allowed,
    online: () => e.flags.online,
    flushOpen: async () => {},
    openIds: () => [],
    locks: undefined,
  })
}

/** A writer over the stored note, as the open editor has it. */
async function editor(e: Env) {
  const note = (await e.store.loadNote(NID))!.note!
  const history = new History(note)
  const w = new Writer(history, e.store, () => ({ color: '#000000', width: 2, usePressure: false }) as never, () => {}, () => 'Chrome, Windows')
  const apply: RestoreApply = (run) => w.applyRestored(run)
  return { w, history, apply }
}

/** The entry of `version.list` for revision `id` (older than the head). */
async function entryOf(e: Env, fileId: string, id: string): Promise<VersionEntry> {
  const d = await createVersionSource(e.drive).load(NID, fileId)
  const r = versionListRule({
    now: NOW,
    noteId: NID,
    headRevisionId: d.headRevisionId,
    revisions: d.revisions.map((v) => ({ id: v.id, modifiedTime: v.modifiedTime, keepForever: v.keepForever === true })),
    sidecars: d.sidecars.map((f) => ({ appProperties: f.appProperties })),
  })
  if ('error' in r) throw new Error(r.error)
  return r.entries.find((x) => x.kind === 'revision' && x.revisionId === id)!
}

/** The note is on Drive (rev1: pages A, B without strokes); then page A gets a stroke that is not uploaded yet. */
async function withUnsentEdit(e: Env) {
  await e.store.writeNote(two())
  expect(await e.uploader.upload(NID)).toBe('uploaded')
  const fileId = e.drive.byKkeujeokId(NID)[0]!.id
  const first = e.drive.revisions(fileId)[0]!.id
  await e.store.writeNote(withStroke(two(), PA, 'a2', 's-unsent'))
  return { fileId, first }
}

describe('the Drive revision and sidecar calls (fake Drive)', () => {
  test('listRevisions tells keepForever; updateRevision pins and releases; a purged revision is 404', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    expect((await e.drive.listRevisions(fileId)).map((r) => r.keepForever)).toEqual([false])
    await e.drive.updateRevision(fileId, first, { keepForever: true })
    expect((await e.drive.listRevisions(fileId))[0]!.keepForever).toBe(true)
    await e.drive.updateRevision(fileId, first, { keepForever: false })
    expect((await e.drive.listRevisions(fileId))[0]!.keepForever).toBe(false)
    e.drive.purgeRevision(fileId, first)
    await expect(e.drive.updateRevision(fileId, first, { keepForever: true })).rejects.toMatchObject({ kind: 'http', status: 404 })
  })

  test('inspectRevision: ok with the pages and the preview page; purged is a result; a zero-page revision is unreadable', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const src = createVersionSource(e.drive)
    const ok = await src.inspectRevision(NID, fileId, first)
    expect(ok.info).toMatchObject({ ok: true })
    expect(ok.page?.id).toBe(PA)
    e.drive.purgeRevision(fileId, first)
    expect((await src.inspectRevision(NID, fileId, first)).info).toEqual({ ok: false, reason: 'purged' })
    const empty = { ...two(), pages: [] } as unknown as Note
    const rev = e.drive.foreignRevision(fileId, await encodeKkj(empty))
    expect((await src.inspectRevision(NID, fileId, rev)).info).toEqual({ ok: false, reason: 'unreadable' })
    const other = e.drive.foreignRevision(fileId, new Uint8Array([1, 2, 3]))
    expect((await src.inspectRevision(NID, fileId, other)).info).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('a network error is not a result: it reaches the caller (the status stays unknown)', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    e.drive.failAt('downloadRevision', 1, new DriveError('network'))
    await expect(createVersionSource(e.drive).inspectRevision(NID, fileId, first)).rejects.toMatchObject({ kind: 'network' })
  })
})

describe('uploadVerified / uploadForRestore', () => {
  test('unsent edits are uploaded and the new head is answered', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const head = await e.uploader.uploadVerified(NID)
    expect(head).not.toBe(first)
    expect(head).toBe((await e.sync()).info.baseHeadRevisionId)
    expect(e.drive.revisions(fileId)).toHaveLength(2)
  })

  test('nothing unsent: only the head is confirmed, no upload', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const base = (await e.sync()).info.baseHeadRevisionId
    const n = e.drive.uploads.length
    expect(await e.uploader.uploadVerified(NID)).toBe(base)
    expect(e.drive.uploads).toHaveLength(n)
  })

  test('nothing unsent but Drive moved on: null, nothing pinned', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    e.drive.foreignRevision(e.drive.byKkeujeokId(NID)[0]!.id, await bytesOf(foreignEdit(two(), PA, 'a3')))
    expect(await e.uploader.uploadVerified(NID)).toBeNull()
  })

  test('nothing unsent but the file is trashed: null and the note is in error', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    e.drive.trash(e.drive.byKkeujeokId(NID)[0]!.id)
    expect(await e.uploader.uploadVerified(NID)).toBeNull()
    expect((await e.sync()).info.state).toBe('error')
  })

  test('a note in error is not uploaded; a failed upload is null and the error is recorded', async () => {
    const e = await make()
    await withUnsentEdit(e)
    e.drive.failAlways('uploadSimple', new DriveError('http', 403, 'storageQuotaExceeded'))
    expect(await e.uploader.uploadVerified(NID)).toBeNull()
    expect((await e.sync()).info).toMatchObject({ state: 'error', lastError: { class: 'quota' } })
    e.drive.clearFailures()
    expect(await e.uploader.uploadVerified(NID)).toBeNull() // still in error until a retry
  })

  test('uploadForRestore: a flush that fails or throws is null before any Drive call', async () => {
    const e = await make()
    await withUnsentEdit(e)
    const c = coordinatorOf(e)
    const n = e.drive.calls.length
    expect(await c.uploadForRestore(NID, async () => false)).toBeNull()
    expect(await c.uploadForRestore(NID, async () => Promise.reject(new Error('x')))).toBeNull()
    expect(e.drive.calls).toHaveLength(n)
  })

  test('uploadForRestore: offline or closed gate is null; a note in error is retried by hand first', async () => {
    const e = await make()
    await withUnsentEdit(e)
    const c = coordinatorOf(e)
    e.flags.online = false
    expect(await c.uploadForRestore(NID, async () => true)).toBeNull()
    e.flags.online = true
    e.drive.failAlways('uploadSimple', new DriveError('http', 403, 'storageQuotaExceeded'))
    expect(await c.uploadForRestore(NID, async () => true)).toBeNull()
    expect((await e.sync()).info.state).toBe('error')
    e.drive.clearFailures()
    expect(await c.uploadForRestore(NID, async () => true)).not.toBeNull() // [다시 시도] semantics: the error is cleared and it goes
  })

  test('reportFailure puts the note in error with the class of the Drive error', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    await e.uploader.reportFailure(NID, new DriveError('http', 403, 'keepForeverRevisionLimitExceeded'))
    expect((await e.sync()).info).toMatchObject({ state: 'error', lastError: { class: 'fatal', status: 403 } })
  })
})

describe('restoring a revision', () => {
  test('uploads and verifies the current state, pins that head, applies restoreNote through the queue, then it uploads', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const { restorer } = setup(e)
    const ed = await editor(e)
    expect(strokeIds(ed.history.note, PA)).toEqual(['s-unsent'])
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r).toEqual({ failure: null })
    // the state before the restore (with the unsent stroke) is a revision of its own, and it is the pinned one
    const revs = e.drive.revisions(fileId)
    expect(revs).toHaveLength(2)
    expect(revs.map((x) => x.keepForever === true)).toEqual([false, true])
    // the note now has the content of the first revision, with new revs and higher seqs
    expect(strokeIds(ed.history.note, PA)).toEqual([])
    const pa = ed.history.note.pages.find((p) => p.id === PA)!
    expect(pa.rev).not.toBe('a1')
    expect(pa.seq).toBeGreaterThan(2)
    expect(await ed.w.flushSaves()).toBe(true)
    expect(strokeIds((await e.store.loadNote(NID))!.note!, PA)).toEqual([])
    // the restore is an ordinary unsent edit: it goes up
    expect((await e.sync()).hasUnsent).toBe(true)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.revisions(fileId)).toHaveLength(3)
    expect(e.drive.revisions(fileId)[1]!.keepForever).toBe(true) // the "복원 전" revision stays as it is
  })

  test('the undo records of the restored pages are gone and the restore is no undo step', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const ed = await editor(e)
    ed.history.doOp({ op: 'addStroke', pageId: PB, stroke: { id: 's-b', type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: [[1, 1, 0.5, 0]] } as never }, { rev: 'b2', now: NOW, editedBy: 'x', lastSeenRemoteSeq: 0 })
    expect(ed.history.undoDepth).toBe(1)
    await e.store.writeNote(ed.history.note) // the edit is saved, so it is part of what is uploaded
    const { restorer } = setup(e)
    await ed.w.flushSaves()
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBeNull()
    expect(ed.history.undoDepth).toBe(0) // every page of the old note was touched
  })

  test('step 1: a purged or unreadable revision restores nothing and does not upload or pin', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    e.drive.purgeRevision(fileId, first)
    const { restorer } = setup(e)
    const ed = await editor(e)
    const before = ed.history.note
    const n = e.drive.uploads.length
    expect(await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).toEqual({ failure: 'unreadable' })
    expect(ed.history.note).toBe(before)
    expect(e.drive.uploads).toHaveLength(n)
    expect(e.drive.calls.some((c) => c.startsWith('updateRevision'))).toBe(false)
  })

  test('step 1: a network error while reading is unreadable too (nothing is done)', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    e.drive.failAt('downloadRevision', 1, new DriveError('network'))
    const { restorer } = setup(e)
    const ed = await editor(e)
    expect((await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('unreadable')
  })

  test('step 1: a version of another note does not apply (the trial run fails before anything is uploaded)', async () => {
    const e = await make()
    const { fileId } = await withUnsentEdit(e)
    const other = e.drive.foreignRevision(fileId, await encodeKkj({ ...two(), noteId: '01926f3a-0000-7000-8000-0000000000ff' }))
    const entry = { kind: 'revision', revisionId: other, at: NOW, deviceName: null, status: 'unknown', current: false, beforeRestore: false, restorable: true } as const
    const { restorer } = setup(e)
    const ed = await editor(e)
    const n = e.drive.uploads.length
    // the reader refuses a file of another note: unreadable
    expect((await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('unreadable')
    expect(e.drive.uploads).toHaveLength(n)
  })

  test('step 2: a flush that fails aborts before the upload (notSaved), the note is unchanged', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    const { restorer } = setup(e)
    const ed = await editor(e)
    const before = ed.history.note
    const n = e.drive.uploads.length
    expect((await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: async () => false })).failure).toBe('notSaved')
    expect(ed.history.note).toBe(before)
    expect(e.drive.uploads).toHaveLength(n)
    expect(e.drive.calls.some((c) => c.startsWith('updateRevision'))).toBe(false)
  })

  test('step 2: the upload fails (quota) -> notSaved, sync error, no pin, note unchanged', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    e.drive.failAlways('uploadSimple', new DriveError('http', 403, 'storageQuotaExceeded'))
    const { restorer } = setup(e)
    const ed = await editor(e)
    const before = ed.history.note
    expect((await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('notSaved')
    expect(ed.history.note).toBe(before)
    expect((await e.sync()).info.state).toBe('error')
    expect(e.drive.calls.some((c) => c.startsWith('updateRevision'))).toBe(false)
  })

  test('step 2: nothing unsent and the head moved on -> notSaved, no pin, note unchanged', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    const first = e.drive.revisions(fileId)[0]!.id
    const mid = e.drive.foreignRevision(fileId, await bytesOf(foreignEdit(two(), PA, 'a3')))
    expect(mid).toBeTruthy()
    const entry = await entryOf(e, fileId, first)
    const { restorer } = setup(e)
    const ed = await editor(e)
    expect((await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('notSaved')
    expect(e.drive.calls.some((c) => c.startsWith('updateRevision'))).toBe(false)
  })

  test('step 2: the file is trashed -> notSaved', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    const first = e.drive.revisions(fileId)[0]!.id
    e.drive.foreignRevision(fileId, await bytesOf(two())) // a second revision, so `first` is older
    const entry = await entryOf(e, fileId, first)
    e.drive.trash(fileId)
    const { restorer } = setup(e)
    const ed = await editor(e)
    expect((await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('notSaved')
  })

  test('step 3: the pin fails -> notPinned, the note is unchanged and in sync error', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    e.drive.failAlways('updateRevision', new DriveError('http', 500, 'backendError'))
    const { restorer } = setup(e)
    const ed = await editor(e)
    const before = ed.history.note
    expect((await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('notPinned')
    expect(ed.history.note).toBe(before)
    expect((await e.sync()).info.state).toBe('error')
  })

  test('step 4: the queue refuses (a stroke, read-only) -> notApplied, the note is unchanged', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    const { restorer } = setup(e)
    const ed = await editor(e)
    const before = ed.history.note
    const r = await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: () => false, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBe('notApplied')
    expect(ed.history.note).toBe(before)
  })

  test('step 4: an edit saved after the upload and the pin aborts the restore (changed), nothing is overwritten', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    const { restorer } = setup(e)
    const ed = await editor(e)
    e.drive.hooks.beforeCall = (method) => {
      if (method === 'updateRevision') ed.history.doOp({ op: 'addStroke', pageId: PB, stroke: { id: 's-late', type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: [[1, 1, 0.5, 0]] } as never }, { rev: 'b9', now: NOW, editedBy: 'x', lastSeenRemoteSeq: 0 })
    }
    const r = await restorer.restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBe('changed')
    expect(strokeIds(ed.history.note, PB)).toEqual(['s-late'])
    expect(strokeIds(ed.history.note, PA)).toEqual(['s-unsent'])
  })

  test('the restored page takes the seq the sync record has seen (it must not look stale on another device)', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    const ed = await editor(e)
    const store = { ...e.store, readSync: async (id: string) => { const r = await e.store.readSync(id); return { ...r, info: { ...r.info, extra: { ...r.info.extra, lastSeenRemoteSeq: 50 } } } } }
    const r = await createVersionRestorer({ drive: e.drive, store, coordinator: coordinatorOf(e), now: () => NOW, newRev: () => `01926f3a-0000-7000-8000-${String(950 + Math.random() * 40 | 0).padStart(12, '0')}`, editedBy: () => 'x' }).restore({ noteId: NID, fileId, entry, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBeNull()
    expect(Math.min(...ed.history.note.pages.map((p) => p.seq))).toBeGreaterThan(50)
  })

  test('an exception after the apply (flush throws) still reports the restore as done', async () => {
    const e = await make()
    const { fileId, first } = await withUnsentEdit(e)
    const entry = await entryOf(e, fileId, first)
    const { restorer } = setup(e)
    const ed = await editor(e)
    let n = 0
    const r = await restorer.restore({
      noteId: NID,
      fileId,
      entry,
      live: () => ed.history.note,
      apply: ed.apply,
      flush: async () => {
        if (n++ >= 1) throw new Error('flush')
        return true
      },
    })
    expect(r.failure).toBeNull()
    expect(strokeIds(ed.history.note, PA)).toEqual([])
  })

  test('the writer refuses a restore when read-only or leaving, and mid-stroke work is refused by busy()', async () => {
    const e = await make()
    await withUnsentEdit(e)
    const ed = await editor(e)
    const run = (n: Note) => ({ note: n, undoDrop: [] })
    ed.w.readOnly = true
    expect(ed.w.applyRestored(run)).toBe(false)
    ed.w.readOnly = false
    expect(ed.w.applyRestored(() => null)).toBe(false)
    expect(ed.w.applyRestored(run)).toBe(true)
    void ed.w.finalize()
    expect(ed.w.applyRestored(run)).toBe(false)
  })
})

describe('the 200 pin cap', () => {
  async function pinned(e: Env, fileId: string, n: number) {
    // n extra old revisions, all pinned
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const id = e.drive.foreignRevision(fileId, await bytesOf(two()))
      e.drive.revisions(fileId).find((r) => r.id === id)!.keepForever = true
      ids.push(id)
    }
    return ids
  }

  test('at the cap the oldest pin is released first, then the head is marked', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    const first = e.drive.revisions(fileId)[0]!.id
    const ids = await pinned(e, fileId, 201)
    // Drive moved on: the foreign head is in base after a receive; here the base is made equal to the head
    const head = ids.at(-1)!
    await e.store.updateSync(NID, (c) => ({ ...c, baseHeadRevisionId: head }))
    e.drive.revisions(fileId).find((r) => r.id === head)!.keepForever = false
    const { restorer } = setup(e)
    const ed = await editor(e)
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBeNull()
    const upd = e.drive.calls.filter((c) => c.startsWith('updateRevision'))
    expect(upd).toHaveLength(2)
    expect(upd[0]).toContain(`${ids[0]} false`)
    expect(upd[1]).toContain(`${head} true`)
    expect(e.drive.revisions(fileId).filter((x) => x.keepForever).length).toBeLessThanOrEqual(200)
  })

  test('a release that answers 404 counts as released', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    const first = e.drive.revisions(fileId)[0]!.id
    const ids = await pinned(e, fileId, 201)
    const head = ids.at(-1)!
    await e.store.updateSync(NID, (c) => ({ ...c, baseHeadRevisionId: head }))
    e.drive.revisions(fileId).find((r) => r.id === head)!.keepForever = false
    // Drive purges the oldest pin between the listing and the release
    e.drive.hooks.beforeCall = (method, nth) => {
      if (method === 'updateRevision' && nth === 1) e.drive.purgeRevision(fileId, ids[0]!)
    }
    const { restorer } = setup(e)
    const ed = await editor(e)
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBeNull()
  })

  test('a non-Drive exception after a release also puts the released pin back', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    const first = e.drive.revisions(fileId)[0]!.id
    const ids = await pinned(e, fileId, 201)
    const head = ids.at(-1)!
    await e.store.updateSync(NID, (c) => ({ ...c, baseHeadRevisionId: head }))
    e.drive.revisions(fileId).find((r) => r.id === head)!.keepForever = false
    e.drive.hooks.beforeCall = (method, nth) => {
      if (method === 'updateRevision' && nth === 2) throw new TypeError('boom')
    }
    const { restorer } = setup(e)
    const ed = await editor(e)
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBe('notApplied')
    e.drive.hooks.beforeCall = undefined
    expect(e.drive.revisions(fileId).find((x) => x.id === ids[0])!.keepForever).toBe(true)
  })

  test('the mark fails after a release: the released pin is put back and the restore is aborted', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    const first = e.drive.revisions(fileId)[0]!.id
    const ids = await pinned(e, fileId, 201)
    const head = ids.at(-1)!
    await e.store.updateSync(NID, (c) => ({ ...c, baseHeadRevisionId: head }))
    e.drive.revisions(fileId).find((r) => r.id === head)!.keepForever = false
    e.drive.failAt('updateRevision', 2, new DriveError('http', 500, 'backendError')) // the mark
    const { restorer } = setup(e)
    const ed = await editor(e)
    const before = ed.history.note
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBe('notPinned')
    expect(ed.history.note).toBe(before)
    expect(e.drive.revisions(fileId).find((x) => x.id === ids[0])!.keepForever).toBe(true) // put back
    expect((await e.sync()).info.state).toBe('error')
  })
})

describe('restoring a page of a conflict sidecar', () => {
  /** A conflict resolved with "theirs": this device's version lives on as a sidecar with kkjResolved. */
  async function resolvedConflict(e: Env) {
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    e.drive.foreignRevision(fileId, await bytesOf(foreignEdit(two(), PA, REV3)))
    await e.store.writeNote(withStroke(two(), PA, REV2, 's-mine'))
    await e.uploader.upload(NID)
    expect((await e.sync()).info.state).toBe('conflict')
    const entry = unresolvedOf((await e.sync()).info)[0] as unknown as Conflict
    const sc = (await e.store.sidecars.get(NID, entry.pageId, entry.rev))!
    const out = resolveConflict((await e.store.loadNote(NID))!.note!, entry, sc, 'theirs', { now: NOW, orderRev: 'o9', rev: 'r9', editedBy: 'Chrome, Windows', lastSeenRemoteSeq: 0 })
    if (out.result !== 'resolved') throw new Error(out.error)
    await e.store.writeNote(out.note)
    await e.uploader.conflictResolved(NID, out.conflict as never)
    await e.uploader.upload(NID)
    await e.uploader.markResolved(NID)
    return { fileId, entry }
  }

  async function sidecarEntry(e: Env, fileId: string, now = NOW): Promise<VersionEntry> {
    const d = await createVersionSource(e.drive).load(NID, fileId)
    const r = versionListRule({ now, noteId: NID, headRevisionId: d.headRevisionId, revisions: [], sidecars: d.sidecars.map((f) => ({ appProperties: f.appProperties })) })
    if ('error' in r) throw new Error(r.error)
    return r.entries[0]!
  }

  test('the resolved sidecar is listed, restorePage puts its page back in place (new rev, higher seq)', async () => {
    const e = await make()
    const { fileId, entry } = await resolvedConflict(e)
    const item = await sidecarEntry(e, fileId, '2026-10-14T00:00:00.000Z')
    expect(item).toMatchObject({ kind: 'sidecar', pageId: PA, rev: entry.rev, restorable: true })
    const { restorer, source } = setup(e)
    const ed = await editor(e)
    expect(strokeIds(ed.history.note, PA)).not.toContain('s-mine')
    const r = await restorer.restore({ noteId: NID, fileId, entry: item, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBeNull()
    expect(strokeIds(ed.history.note, PA)).toContain('s-mine')
    expect(ed.history.note.pages.map((p) => p.id)).toEqual([PA, PB])
    // the preview download of the same sidecar works too
    const files = (await source.load(NID, fileId)).sidecars
    expect((await source.inspectSidecar(NID, files[0]!.id, PA, entry.rev)).info).toMatchObject({ ok: true })
  })

  test('a sidecar page that is gone from the note is recreated at its original index', async () => {
    const e = await make()
    const { fileId } = await resolvedConflict(e)
    const item = await sidecarEntry(e, fileId, '2026-10-14T00:00:00.000Z')
    const { restorer } = setup(e)
    const ed = await editor(e)
    ed.history.note.pages.splice(0, 1) // page A was removed meanwhile
    await e.store.writeNote(ed.history.note)
    const r = await restorer.restore({ noteId: NID, fileId, entry: item, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.failure).toBeNull()
    expect(ed.history.note.pages.map((p) => p.id)).toEqual([PA, PB])
  })

  test('a missing sidecar file is unreadable (nothing is uploaded)', async () => {
    const e = await make()
    const { fileId } = await resolvedConflict(e)
    const item = await sidecarEntry(e, fileId, '2026-10-14T00:00:00.000Z')
    for (const f of e.drive.byKkeujeokId(`sc:${NID}:${(item as { pageId: string }).pageId}:${(item as { rev: string }).rev}`)) e.drive.remove(f.id)
    const { restorer } = setup(e)
    const ed = await editor(e)
    const n = e.drive.uploads.length
    expect((await restorer.restore({ noteId: NID, fileId, entry: item, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('unreadable')
    expect(e.drive.uploads).toHaveLength(n)
  })
})

describe('leftover conflicts of a whole-note restore', () => {
  async function conflicted(e: Env) {
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    const first = e.drive.revisions(fileId)[0]!.id
    e.drive.foreignRevision(fileId, await bytesOf(foreignEdit(two(), PA, 'a3')))
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    await e.uploader.upload(NID)
    expect((await e.sync()).info.state).toBe('conflict')
    // the base is Drive's head now; the person has nothing unsent but the conflict
    return { fileId, first }
  }

  test('the open conflicts are marked resolved in sync.json, the locks come from that committed record', async () => {
    const e = await make()
    const { fileId, first } = await conflicted(e)
    const { restorer } = setup(e)
    const ed = await editor(e)
    ed.history.setLocked([PA])
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r).toEqual({ failure: null, locked: [] })
    const s = await e.sync()
    expect(unresolvedOf(s.info)).toEqual([])
    expect(s.info.conflicts[0]!.resolvedAt).toBe(NOW)
    expect(s.info.state).toBe('pending')
  })

  test('the record cannot be written twice: the conflict stays open, the restore stays done, the locks are not touched', async () => {
    const e = await make()
    const { fileId, first } = await conflicted(e)
    let calls = 0
    const { restorer } = setup(e, {
      restorerCoordinator: {
        conflictResolved: async () => {
          calls++
          throw new Error('write failed')
        },
      },
    })
    const ed = await editor(e)
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r).toEqual({ failure: null }) // no `locked`: the editor keeps its locks
    expect(calls).toBe(2) // once more, then it stays open
    expect(unresolvedOf((await e.sync()).info)).toHaveLength(1)
    expect(strokeIds(ed.history.note, PA)).toEqual([]) // restored all the same
  })

  test('the first write fails, the retry succeeds', async () => {
    const e = await make()
    const { fileId, first } = await conflicted(e)
    let calls = 0
    const base = coordinatorOf(e)
    const { restorer } = setup(e, {
      restorerCoordinator: {
        conflictResolved: async (id: string, c: Record<string, unknown>) => {
          if (calls++ === 0) throw new Error('write failed')
          return base.conflictResolved(id, c)
        },
      },
    })
    const ed = await editor(e)
    const r = await restorer.restore({ noteId: NID, fileId, entry: await entryOf(e, fileId, first), live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })
    expect(r.locked).toEqual([])
    expect(unresolvedOf((await e.sync()).info)).toEqual([])
  })

  test('a restorePage resolves only the conflicts of its page', async () => {
    const e = await make()
    await conflicted(e)
    const { restorer } = setup(e)
    const ed = await editor(e)
    const info = (await e.sync()).info
    const item = { kind: 'sidecar', pageId: PB, rev: 'x', at: NOW, deviceName: null, status: 'unknown', originalIndex: 1, restorable: true } as const
    // no sidecar of page B exists: unreadable, and the conflict of page A is untouched
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    expect((await restorer.restore({ noteId: NID, fileId, entry: item, live: () => ed.history.note, apply: ed.apply, flush: () => ed.w.flushSaves() })).failure).toBe('unreadable')
    expect(unresolvedOf((await e.sync()).info)).toHaveLength(info.conflicts.length)
  })
})

describe('a sidecar record that cannot be read', () => {
  test('is not an absence: its unsentSidecars entry stays and nothing is sent', async () => {
    const e = await make()
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    e.drive.foreignRevision(fileId, await bytesOf(foreignEdit(two(), PA, REV3)))
    await e.store.writeNote(withStroke(two(), PA, REV2, 's-mine'))
    const get = e.store.sidecars.get
    e.store.sidecars.get = async () => {
      throw new Error('idb: transient')
    }
    await e.uploader.upload(NID).catch(() => {}) // a failed upload: the note stays unsent
    e.store.sidecars.get = get
    const left = (await e.sync()).info.unsentSidecars
    expect(left).toHaveLength(1)
    expect(e.drive.byKkeujeokId(`sc:${NID}:${PA}:${REV2}`)).toHaveLength(0)
  })
})
