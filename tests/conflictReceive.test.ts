// Story 3.20, receive side: a remote change that conflicts with this device's edit is applied (the remote
// page wins the note), the losing page is recorded as a sidecar, the note becomes a `conflict` note whose
// sidecar the next upload sends, and the receiver itself writes nothing to Drive.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import type { Note } from '../src/model/note'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type RxEnv, makeRxEnv } from './receiveHarness'
import { NID, PA, PB, foreignEdit, mkNote, withStroke } from './uploadHarness'

let env: RxEnv | undefined
const make = async () => (env = await makeRxEnv())
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const pageRev = (n: Note, id: string) => n.pages.find((p) => p.id === id)?.rev
const working = async (e: RxEnv) => (await e.store.loadNote(NID))!.note!
const states = (e: RxEnv) => e.events('stateChange').map((x) => `${x.from}>${x.to}`)

/** Synced note; this device edits page A, the other device uploads its own edit of page A. */
async function conflicting(e: RxEnv) {
  const note = two()
  const { fileId } = await e.seedSynced(note)
  await e.receiver.check()
  await e.store.writeNote(withStroke(note, PA, 'a2'))
  const up = await e.remoteUpload(foreignEdit(note, PA, 'a3'), { fileId })
  return { note, fileId, up }
}

describe('receiving a conflicting change', () => {
  test('the remote page is in the note, this version is a sidecar record, the note is a conflict note; Drive is not written', async () => {
    const e = await make()
    const { up } = await conflicting(e)
    const writes = e.drive.uploads.length
    await e.receiver.check()
    expect(pageRev(await working(e), PA)).toBe('a3')
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ state: 'conflict', baseHeadRevisionId: up.head, lastError: null })
    expect(s.info.conflicts).toEqual([
      { pageId: PA, kind: 'bothEdited', rev: 'a2', theirsRev: 'a3', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null },
    ])
    expect(s.info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a2' }])
    expect(s.hasUnsent).toBe(true) // the sidecar waits for the next upload
    expect((await e.store.sidecars.get(NID, PA, 'a2'))!.page.elements).toHaveLength(1)
    expect(e.drive.uploads).toHaveLength(writes)
    expect(e.drive.byKkeujeokId('conflicts')).toHaveLength(0)
    expect(states(e).slice(-3)).toEqual(['synced>pending', 'pending>syncing', 'syncing>conflict'])
    expect(e.events('conflictFound')).toHaveLength(1)
    expect(e.events('error')).toEqual([])
    expect(e.invalid).toEqual([])
  })

  test('the next upload sends the sidecar only: no new revision of the note, the state stays conflict', async () => {
    const e = await make()
    const { fileId } = await conflicting(e)
    await e.receiver.check()
    const revs = e.drive.revisions(fileId).length
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.revisions(fileId)).toHaveLength(revs)
    expect(e.drive.byKkeujeokId(`sc:${NID}:${PA}:a2`)).toHaveLength(1)
    const s = await e.store.readSync(NID)
    expect(s.info).toMatchObject({ state: 'conflict', unsentSidecars: [] })
    expect(s.hasUnsent).toBe(false)
    expect(await e.store.sidecars.get(NID, PA, 'a2')).toBeNull()
  })

  test('a note that already is a conflict note takes another remote change and stays a conflict note', async () => {
    const e = await make()
    const { fileId, note } = await conflicting(e)
    await e.receiver.check()
    await e.uploader.upload(NID)
    const base = (await e.store.readSync(NID)).base!
    await e.remoteUpload(foreignEdit(base, PB, 'b2'), { fileId })
    await e.receiver.check()
    const w = await working(e)
    expect([pageRev(w, PA), pageRev(w, PB)]).toEqual(['a3', 'b2'])
    const s = await e.store.readSync(NID)
    expect(s.info.state).toBe('conflict')
    expect(s.info.conflicts).toHaveLength(1)
    expect(note.noteId).toBe(NID)
  })

  test('a later remote change of the conflicted page takes the new remote page and adds no second entry or sidecar', async () => {
    const e = await make()
    const { fileId, note } = await conflicting(e)
    await e.receiver.check()
    // another device writes the same page again on top of its first edit
    const again = foreignEdit(foreignEdit(note, PA, 'a3'), PA, 'a4')
    await e.remoteUpload(again, { fileId })
    await e.receiver.check()
    const s = await e.store.readSync(NID)
    expect(s.info.conflicts).toHaveLength(1)
    expect(s.info.conflicts[0]).toMatchObject({ rev: 'a2' })
    expect(s.info.unsentSidecars).toHaveLength(1)
  })

  test('a page the other device deleted: the page is out of the note, the version is a sidecar, the note is a conflict note', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.store.writeNote(withStroke(note, PB, 'b2'))
    const remote = two()
    remote.pages = remote.pages.filter((p) => p.id !== PB)
    remote.orderRev = 'o2'
    await e.remoteUpload(remote, { fileId })
    await e.receiver.check()
    expect((await working(e)).pages.map((p) => p.id)).toEqual([PA])
    const s = await e.store.readSync(NID)
    expect(s.info.state).toBe('conflict')
    expect(s.info.conflicts[0]).toMatchObject({ pageId: PB, kind: 'remoteDeleted', theirsRev: null })
    expect(await e.store.sidecars.get(NID, PB, 'b2')).not.toBeNull()
  })

  test('a merge without a conflict leaves everything as it was (no sync records invented, no sidecar)', async () => {
    const e = await make()
    const note = two()
    const { fileId } = await e.seedSynced(note)
    await e.receiver.check()
    await e.store.writeNote(withStroke(note, PA, 'a2'))
    await e.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    await e.receiver.check()
    const s = await e.store.readSync(NID)
    expect(s.info.conflicts).toEqual([])
    expect(s.info.unsentSidecars).toEqual([])
    expect(s.info.state).toBe('pending')
    expect(e.events('conflictFound')).toEqual([])
  })
})
