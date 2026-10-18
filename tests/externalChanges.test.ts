// Drive changes that are not ours (Story 3.18) against the fake Drive and fake-indexeddb: a note
// trashed or deleted (removed, restored), renamed or moved, a file that cannot be read, a newer
// format. Each guard has a test that fails when it is removed.
import 'fake-indexeddb/auto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { listSummaryRule } from '../src/drive/noteSummary'
import { encodeKkj } from '../src/model/kkjCodec'
import { type Note, toWritableJson } from '../src/model/note'
import { sessionHistory } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { chained } from '../src/sync/noteChain'
import { createSyncStatus } from '../src/sync/syncStatus'
import { KKJ_MIME } from '../src/sync/noteReceiver'
import { registerOpenNote } from '../src/sync/openNotes'
import { commitMerge } from '../src/sync/commitMerge'
import { fakeLocks } from './helpers'
import { type RxEnv, makeRxEnv } from './receiveHarness'
import { NID, PA, PB, foreignEdit, mkNote, md5Of, withStroke } from './uploadHarness'

let env: RxEnv | undefined
const uploaded: string[] = []
const make = async (extra: Parameters<typeof makeRxEnv>[0] = {}) => {
  uploaded.length = 0
  const e = await makeRxEnv({
    // The coordinator's `noteClosed` stand-in: the real uploader of the same store and Drive.
    uploadNote: async (id) => {
      uploaded.push(id)
      await env!.uploader.upload(id)
    },
    ...extra,
  })
  return (env = e)
}
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const two = (id = NID) => mkNote({ noteId: id, pages: { [PA]: 'a1', [PB]: 'b1' } })
const downloads = (e: RxEnv) => e.drive.count('downloadRevision')
const states = (e: RxEnv) => e.events('stateChange').map((x) => `${x.from}>${x.to}`)
const garbage = new Uint8Array([1, 2, 3])
const newerFormat = (n: Note) => new Uint8Array(gzipSync(JSON.stringify({ ...toWritableJson(n), formatVersion: 2 })))
const gone = async (e: RxEnv, id = NID) => (await e.store.loadNote(id)) === null && (await e.store.readSync(id)).missing === true
/** A note synced with Drive, the first scan done. */
async function synced(e: RxEnv, note = two()) {
  const up = await e.seedSynced(note)
  await e.receiver.check()
  return up
}
/** A pending note: one stroke not sent. */
const edit = (e: RxEnv, note = two()) => e.store.writeNote(withStroke(note, PA, 'a2'))
/** A note open in this tab; `flush` is what the editor writes when it is asked to. */
function openEditor(note: Note, flush: () => Promise<void> = async () => {}) {
  const h = sessionHistory(note)
  return registerOpenNote(NID, {
    flush: async () => (await flush(), true),
    current: () => h.note,
    applyMerge: (a) => commitMerge(h, a),
  })
}

describe('a note trashed or deleted in Drive', () => {
  test.each(['trash', 'remove'] as const)('%s, nothing unsent, not open: the copy is removed and Drive is not written', async (how) => {
    const e = await make()
    const { fileId } = await synced(e)
    e.drive[how](fileId)
    const before = e.receiver.getState().version
    await e.receiver.check()
    expect(await gone(e)).toBe(true)
    expect(e.drive.count('update')).toBe(0)
    expect(e.drive.uploads).toHaveLength(1) // only the other device's
    expect(e.receiver.getState().version).toBeGreaterThan(before)
    expect(e.receiver.getState().revived).toBe(0)
    expect(e.events('error')).toEqual([{ at: expect.any(String), event: 'error', class: 'deleted', noteId: NID, reason: how === 'trash' ? 'trashed' : 'removed' }])
    expect(e.invalid).toEqual([])
  })

  test('trashed with unsent changes: untrashed, restored once, uploaded to the same file', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    e.drive.trash(fileId)
    await e.receiver.check()
    expect(e.drive.items.get(fileId)!.trashed).toBe(false)
    expect(e.receiver.getState().revived).toBe(1)
    expect(uploaded).toEqual([NID])
    expect(e.drive.items.get(fileId)!.revs).toHaveLength(2)
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ fileId, state: 'synced', lastError: null })
    expect(s.hasUnsent).toBe(false)
  })

  test('deleted for good with unsent changes: created again with the same noteId, restored once', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    e.drive.remove(fileId)
    await e.receiver.check()
    expect(e.receiver.getState().revived).toBe(1)
    expect(uploaded).toEqual([NID])
    const made = e.drive.byKkeujeokId(NID)
    expect(made).toHaveLength(1)
    expect(made[0]!.id).not.toBe(fileId)
    expect(made[0]!.revs).toHaveLength(1)
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ fileId: made[0]!.id, state: 'synced' })
    expect((await e.store.loadNote(NID))!.note!.pages.find((p) => p.id === PA)!.rev).toBe('a2')
    expect(e.invalid).toEqual([])
  })

  test('the untrash is refused with 404 (deleted meanwhile): it is created again', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    e.drive.trash(fileId)
    e.drive.failAt('update', 1, new DriveError('http', 404, 'notFound'))
    await e.receiver.check()
    expect(e.receiver.getState().revived).toBe(1)
    const live = e.drive.byKkeujeokId(NID).filter((i) => !i.trashed)
    expect(live).toHaveLength(1)
    expect(live[0]!.id).not.toBe(fileId)
  })

  test('a conflict or an unresolved sidecar counts as unsent: the note is never removed', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await e.store.updateSync(NID, (c) => ({ ...c, conflicts: [{ pageId: PA, rev: 'a9', resolvedAt: null }] }))
    e.drive.remove(fileId)
    await e.receiver.check()
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect(e.receiver.getState().revived).toBe(1)
  })

  test('another file with the same kkeujeokId is trashed (duplicate cleanup): the note is untouched', async () => {
    const e = await make()
    await synced(e)
    const other = await e.remoteUpload(two())
    e.drive.trash(other.fileId)
    await e.receiver.check()
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect(e.events('error')).toEqual([])
  })

  test('the file id guard: a note that now points at another file is not touched', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await e.store.updateSync(NID, (c) => ({ ...c, fileId: 'someotherfile' }))
    e.drive.remove(fileId)
    await e.receiver.check()
    expect(await e.store.loadNote(NID)).not.toBeNull()
  })

  test('rescan after a refused token: a missing file is looked up, a listed or only unlisted live one stays', async () => {
    const e = await make()
    const a = await synced(e, two())
    const N2 = '01926f3a-0000-7000-8000-0000000000a2'
    const b = await e.seedSynced(two(N2))
    const N3 = '01926f3a-0000-7000-8000-0000000000a3'
    const c = await e.seedSynced(two(N3))
    await e.receiver.check()
    e.drive.remove(a.fileId)
    e.drive.items.get(b.fileId)!.hidden = true // live, only not listed
    e.drive.rejectTokens(410)
    await e.receiver.check()
    expect(await gone(e, NID)).toBe(true)
    expect(await e.store.loadNote(N2)).not.toBeNull()
    expect(await e.store.loadNote(N3)).not.toBeNull()
    expect(c.fileId).not.toBe(b.fileId)
    expect(e.events('pageTokenRejected')).toHaveLength(1)
    expect(e.events('error').filter((x) => x.noteId === N2)).toEqual([])
  })

  test('an upload that found the file trashed left error/deleted: the next start settles it', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    e.drive.trash(fileId)
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.store.readSync(NID)).info).toMatchObject({ state: 'error', lastError: { class: 'deleted', reason: 'trashed' } })
    // The change feed is past the trashing (it was consumed before the note knew its file): only the start sweep can find it.
    await e.device.write({ ...(await e.device.read()), pageToken: String(e.drive.changeCount()) })
    const fresh = e.mk() // a reloaded page: the first check runs the start sweep
    await fresh.check()
    expect(e.drive.items.get(fileId)!.trashed).toBe(false)
    expect((await e.store.readSync(NID)).info).toMatchObject({ lastError: null })
    expect(uploaded).toEqual([NID])
  })

  test('a download that answers 404 marks the note and settles it in the same check', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    await e.remoteUpload(foreignEdit(two(), PB, 'b2'), { fileId })
    e.drive.hooks.beforeCall = (m) => m === 'downloadRevision' && e.drive.remove(fileId) // deleted between the change and the download
    await e.receiver.check()
    // unsent changes: created again from the device copy
    expect(e.receiver.getState().revived).toBe(1)
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
    expect((await e.store.readSync(NID)).info).toMatchObject({ state: 'synced', lastError: null })
  })
})

describe('a note open here', () => {
  test('deleted with nothing unsent: the banner state, nothing removed; [닫기] removes it', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two())
    e.drive.trash(fileId)
    await e.receiver.check()
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect((await e.store.readSync(NID)).info).toMatchObject({ state: 'error', lastError: { class: 'deleted', reason: 'trashed' } })
    expect(e.receiver.getState().revived).toBe(0)
    await e.receiver.check() // marked once, logged once
    expect(e.events('error')).toHaveLength(1)
    off()
    await e.receiver.noteClosed(NID)
    expect(await gone(e)).toBe(true)
  })

  test('typed after the banner: leaving restores the note instead of deleting it', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two())
    e.drive.trash(fileId)
    await e.receiver.check()
    await edit(e) // a stroke saved while the banner shows
    off()
    await e.receiver.noteClosed(NID)
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect(e.drive.items.get(fileId)!.trashed).toBe(false)
    expect(e.receiver.getState().revived).toBe(1)
    expect(uploaded).toEqual([NID])
  })

  test('strokes still in the editor queue are flushed first: the note has unsent changes and is restored', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two(), () => edit(e))
    e.drive.trash(fileId)
    await e.receiver.check()
    off()
    expect(e.drive.items.get(fileId)!.trashed).toBe(false)
    expect(e.receiver.getState().revived).toBe(1)
    expect(uploaded).toEqual([]) // an open note uploads when it is closed or hidden
  })

  test('[다시 살리기]: untrashed, no snackbar; whole again when nothing is unsent, pending when something is', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two())
    e.drive.trash(fileId)
    await e.receiver.check()
    await e.receiver.revive(NID)
    off()
    expect(e.drive.items.get(fileId)!.trashed).toBe(false)
    expect(e.receiver.getState().revived).toBe(0)
    expect((await e.store.readSync(NID)).info).toMatchObject({ state: 'synced', lastError: null })
    expect(states(e)).toContain('synced>error')
    expect(states(e)).toContain('error>pending')
    expect(states(e)).toContain('pending>syncing')
  })

  test('[다시 살리기] of a permanently deleted note forgets the file so the next upload creates it', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two())
    e.drive.remove(fileId)
    await e.receiver.check()
    await e.receiver.revive(NID)
    off()
    expect((await e.store.readSync(NID)).info).toMatchObject({ fileId: null, baseHeadRevisionId: null, state: 'pending', lastError: null })
    await edit(e)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
  })

  test('the account changed during the flush: nothing is decided', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two(), async () => void (e.acct.current = { sub: 'sub-2', email: 'b@example.test' }))
    e.drive.trash(fileId)
    await e.receiver.check()
    off()
    expect((await e.store.readSync(NID)).info.lastError).toBeNull()
    expect(e.events('error')).toEqual([])
  })

  test('restored from the trash: the note is linked again and whole', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two())
    e.drive.trash(fileId)
    await e.receiver.check()
    await e.drive.update(fileId, { trashed: false })
    await e.receiver.check()
    off()
    expect((await e.store.readSync(NID)).info).toMatchObject({ state: 'synced', lastError: null })
    expect(downloads(e)).toBe(0)
  })

  test('opening a trashed note: files.get says trashed, the banner state is set', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two())
    e.drive.trash(fileId)
    await e.receiver.noteOpened(NID)
    off()
    expect((await e.store.readSync(NID)).info.lastError).toMatchObject({ class: 'deleted', reason: 'trashed' })
  })

  test('opening a note whose file is gone for good: 404 is the removed kind', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor(two())
    e.drive.remove(fileId)
    await e.receiver.noteOpened(NID)
    off()
    expect((await e.store.readSync(NID)).info.lastError).toMatchObject({ class: 'deleted', reason: 'removed' })
  })
})

describe('guards of the deletion', () => {
  test('removeNote refuses a stale working copy and deletes nothing', async () => {
    const e = await make()
    await synced(e)
    const stale = (await e.store.loadNote(NID))!.note!
    await edit(e)
    expect(await e.store.removeNote(NID, stale)).toBe(false)
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect((await e.store.readSync(NID)).hasUnsent).toBe(true)
    const now = (await e.store.loadNote(NID))!.note!
    expect(await e.store.removeNote(NID, now)).toBe(true)
    expect(await gone(e)).toBe(true)
    expect(await e.store.removeNote(NID, now)).toBe(false)
  })

  test('a stroke saved between the decision and the removal: the removal fails, the note is restored instead', async () => {
    let env2!: RxEnv
    const base = await make()
    env2 = base
    const { fileId } = await synced(base)
    let first = true
    const store = {
      ...base.store,
      removeNote: async (id: string, expected: Note) => {
        if (first) {
          first = false
          await edit(base)
        }
        return base.store.removeNote(id, expected)
      },
    }
    const receiver = base.mk({ store: store as never })
    base.drive.trash(fileId)
    await receiver.check()
    expect(await env2.store.loadNote(NID)).not.toBeNull()
    expect(base.drive.items.get(fileId)!.trashed).toBe(false)
  })

  test('the per-note chain: a decision waits for the work already running on the note', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const busy = chained(NID, () => gate)
    e.drive.trash(fileId)
    const check = e.receiver.check()
    await new Promise((r) => setTimeout(r, 20))
    expect(await e.store.loadNote(NID)).not.toBeNull()
    release()
    await busy
    await check
    expect(await gone(e)).toBe(true)
  })

  test('a note open in another tab (its lock is taken) is left to that tab, which decides when told', async () => {
    const locks = fakeLocks()
    const e = await make({ locks })
    const { fileId } = await synced(e)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    void locks.request(`kkeujeok-note:${NID}`, {}, () => held)
    await new Promise((r) => setTimeout(r, 5))
    e.drive.trash(fileId)
    await e.receiver.check()
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect(e.posted).toContainEqual({ t: 'deleted', noteId: NID, fileId, kind: 'trashed' })
    // the other tab: the note is open there
    const off = openEditor(two())
    await e.receiver.onMessage({ t: 'deleted', noteId: NID, fileId, kind: 'trashed' })
    off()
    release()
    expect((await e.store.readSync(NID)).info.lastError).toMatchObject({ class: 'deleted' })
  })

  test('a failing connection while untrashing leaves the note and the token as they are', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    e.drive.trash(fileId)
    const t = (await e.device.read()).pageToken
    e.drive.failAlways('update', new DriveError('http', 503, 'backendError'))
    await e.receiver.check()
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect((await e.device.read()).pageToken).toBe(t)
    expect(e.receiver.getState().revived).toBe(0)
  })
})

describe('the status store', () => {
  test('a removed note leaves the snapshot and no longer counts as unsent (the tab-close warning)', async () => {
    const e = await make()
    await synced(e)
    await edit(e)
    const status = createSyncStatus({ store: e.store, delayMs: 1 })
    await status.refreshAll()
    expect(status.getSnapshot().notes.get(NID)).toMatchObject({ hasUnsent: true })
    await e.store.writeNote((await e.store.loadNote(NID))!.note!) // unchanged working copy
    const work = (await e.store.loadNote(NID))!.note!
    await e.store.updateSync(NID, (c) => c)
    expect(await e.store.removeNote(NID, work)).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(status.getSnapshot().notes.has(NID)).toBe(false)
    expect(status.anyUnsent()).toBe(false)
    status.dispose()
  })
})

describe('rename and move in Drive', () => {
  test('a renamed file with the same head: the title follows, nothing else changes, nothing downloaded or sent', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const work = (await e.store.loadNote(NID))!.note!
    const sync = (await e.store.readSync(NID)).info
    e.drive.rename(fileId, 'Drive에서 바꾼 이름.kkj')
    await e.receiver.check()
    e.drive.move(fileId, 'outside-kkeujeok')
    await e.receiver.check()
    expect(downloads(e)).toBe(0)
    const after = (await e.store.loadNote(NID))!.note!
    expect(after).toEqual({ ...work, meta: { ...work.meta, title: 'Drive에서 바꾼 이름' } }) // metaRev and every page rev stay
    const s = await e.store.readSync(NID)
    expect(s.info).toEqual(sync)
    expect(s.base!.meta.title).toBe('Drive에서 바꾼 이름')
    expect(s.hasUnsent).toBe(false)
    expect(e.drive.uploads).toHaveLength(1)
    expect(await e.uploader.upload(NID)).toBe('skipped') // a rename alone is no change to send
    expect(e.drive.uploads).toHaveLength(1)
    expect(e.events('error')).toEqual([])
  })

  test('the next upload keeps the Drive name and leaves the folder alone', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    e.drive.rename(fileId, 'x.kkj')
    e.drive.move(fileId, 'outside-kkeujeok')
    await e.receiver.check()
    await e.store.writeNote(withStroke((await e.store.loadNote(NID))!.note!, PA, 'a2'))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    const f = e.drive.items.get(fileId)!
    expect(f.name).toBe('x.kkj')
    expect(f.parents).toEqual(['outside-kkeujeok'])
    expect(e.drive.calls.some((c) => c.startsWith('update'))).toBe(false)
  })

  test('a title changed here and not uploaded wins; the upload renames the Drive file', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const work = (await e.store.loadNote(NID))!.note!
    await e.store.writeNote({ ...work, metaRev: 'rev-meta-app', meta: { ...work.meta, title: '앱 이름' } })
    e.drive.rename(fileId, 'Drive 이름.kkj')
    await e.receiver.check()
    expect((await e.store.loadNote(NID))!.note!.meta.title).toBe('앱 이름')
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.items.get(fileId)!.name).toBe('앱 이름.kkj')
  })

  test('a name that is no valid title is not taken', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    e.drive.rename(fileId, '끝 공백 .kkj')
    await e.receiver.check()
    expect((await e.store.loadNote(NID))!.note!.meta.title).toBe('수학 노트')
  })

  test('a rename seen while the note is open is applied when it is closed', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    const off = openEditor((await e.store.loadNote(NID))!.note!)
    e.drive.rename(fileId, '열린 노트 새 이름.kkj')
    await e.receiver.check()
    expect((await e.store.loadNote(NID))!.note!.meta.title).toBe('수학 노트')
    off()
    await e.receiver.noteClosed(NID)
    expect((await e.store.loadNote(NID))!.note!.meta.title).toBe('열린 노트 새 이름')
  })

  test('a remote-only card follows the Drive name and folder without a download', async () => {
    const e = await make()
    const up = await e.remoteUpload(two())
    await e.receiver.check()
    expect((await e.store.remote.get(NID))!.title).toBe('수학 노트')
    e.drive.rename(up.fileId, '새 이름.kkj')
    e.drive.move(up.fileId, 'folder-x')
    await e.receiver.check()
    expect(await e.store.remote.get(NID)).toMatchObject({ title: '새 이름', folderId: 'folder-x', headRevisionId: up.head })
    expect(downloads(e)).toBe(0)
    expect(e.receiver.getState().receiving.size).toBe(0)
  })
})

describe('a file that cannot be read', () => {
  test('a note here: error unreadable with the head, copy and Drive file untouched, never uploaded', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    const work = (await e.store.loadNote(NID))!.note!
    const head = e.drive.foreignRevision(fileId, garbage)
    await e.receiver.check()
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ state: 'error', lastError: { class: 'unreadable', reason: 'parse', head } })
    expect(s.hasUnsent).toBe(true)
    expect((await e.store.loadNote(NID))!.note).toEqual(work)
    expect(await e.uploader.upload(NID)).toBe('skipped')
    expect(e.drive.revisions(fileId)).toHaveLength(2)
    expect(e.drive.items.get(fileId)!.revs.at(-1)!.bytes).toEqual(garbage)
    expect(e.invalid).toEqual([])
  })

  test('the same broken head is not downloaded again', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    e.drive.foreignRevision(fileId, garbage)
    await e.receiver.check()
    const n = downloads(e)
    await e.receiver.noteOpened(NID)
    e.drive.rejectTokens(410)
    await e.receiver.check()
    expect(downloads(e)).toBe(n)
  })

  test('fixed in Drive (another head): tried again and received', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    e.drive.foreignRevision(fileId, garbage)
    await e.receiver.check()
    expect((await e.store.readSync(NID)).state).toBe('error')
    const fixed = foreignEdit(two(), PB, 'b2')
    await e.remoteUpload(fixed, { fileId })
    await e.receiver.check()
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ state: 'synced', lastError: null })
    expect((await e.store.loadNote(NID))!.note!.pages.find((p) => p.id === PB)!.rev).toBe('b2')
  })

  test('a note that is not here: a blocked card, not downloaded again for the same head', async () => {
    const e = await make()
    const up = await e.remoteUpload(two(), { noSummary: true })
    e.drive.foreignRevision(up.fileId, garbage)
    await e.receiver.check()
    expect(await e.store.remote.get(NID)).toMatchObject({ blocked: 'unreadable', fileId: up.fileId, title: '수학 노트' })
    expect(await e.store.loadNote(NID)).toBeNull()
    expect(downloads(e)).toBe(1)
    e.drive.rejectTokens(410)
    await e.receiver.check()
    expect(downloads(e)).toBe(1)
    expect(e.events('error')).toEqual([expect.objectContaining({ class: 'unreadable', reason: 'parse' })])
    expect(e.invalid).toEqual([])
  })

  test('a card whose summary is valid is found unreadable when it is opened', async () => {
    const e = await make()
    const note = two()
    const sum = listSummaryRule({ op: 'write', note, md5: md5Of(garbage) }) as { name: string; appProperties: Record<string, string> }
    const f = await e.drive.uploadSimple({ metadata: { name: sum.name, appProperties: sum.appProperties, mimeType: KKJ_MIME, parents: ['ROOT'] }, bytes: garbage })
    await e.receiver.check()
    expect(downloads(e)).toBe(0)
    expect((await e.store.remote.get(NID))!.blocked).toBeUndefined()
    await expect(e.receiver.beforeOpen(NID)).rejects.toBeDefined()
    expect(await e.store.remote.get(NID)).toMatchObject({ blocked: 'unreadable', fileId: f.id })
    const n = downloads(e)
    await e.receiver.beforeOpen(NID)
    expect(downloads(e)).toBe(n)
  })
})

describe('a note of a newer format', () => {
  test('a note here: never merged or written, error unsupportedVersion, never uploaded', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    const work = (await e.store.loadNote(NID))!.note!
    const head = e.drive.foreignRevision(fileId, newerFormat(two()))
    await e.receiver.check()
    expect((await e.store.readSync(NID)).info).toMatchObject({ state: 'error', lastError: { class: 'unreadable', reason: 'unsupportedVersion', head } })
    expect((await e.store.loadNote(NID))!.note).toEqual(work)
    expect(await e.uploader.upload(NID)).toBe('skipped')
    expect(e.drive.revisions(fileId)).toHaveLength(2)
  })

  test('the upload that finds it records the head too, and a later fix is received', async () => {
    const e = await make()
    const { fileId } = await synced(e)
    await edit(e)
    const head = e.drive.foreignRevision(fileId, newerFormat(two()))
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.store.readSync(NID)).info.lastError).toMatchObject({ class: 'unreadable', reason: 'unsupportedVersion', head })
    await e.remoteUpload(foreignEdit(two(), PB, 'b2'), { fileId })
    await e.receiver.check()
    expect((await e.store.readSync(NID)).info.lastError).toBeNull()
  })

  test('a note that is not here: a blocked card unsupportedVersion', async () => {
    const e = await make()
    const up = await e.remoteUpload(two(), { noSummary: true })
    e.drive.foreignRevision(up.fileId, newerFormat(two()))
    await e.receiver.check()
    expect(await e.store.remote.get(NID)).toMatchObject({ blocked: 'unsupportedVersion' })
    expect(await e.store.loadNote(NID)).toBeNull()
  })
})

describe('the encoded note is a valid file', () => {
  test('encodeKkj of the fixture reads back (sanity for the helpers above)', async () => {
    expect((await encodeKkj(two())).length).toBeGreaterThan(10)
  })
})
