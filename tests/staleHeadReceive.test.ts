// Story 15.14: after a conflict is resolved and uploaded, a late listing that returns the older revision
// (the one received at the conflict) as the head is not a remote change: no second conflict, the base stays.
import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'vitest'
import { resolveConflict } from '../src/ops/resolveConflict'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { decodeKkj } from '../src/model/kkjCodec'
import { unresolvedOf } from '../src/sync/conflicts'
import type { Conflict } from '../src/sync/merge'
import { type RxEnv, makeRxEnv } from './receiveHarness'
import { NID, PA, PB, foreignEdit, mkNote, withStroke } from './uploadHarness'

let env: RxEnv | undefined
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

test('a stale head after the resolving upload is skipped: synced, base kept, the resolution is the final revision', async () => {
  const e = (env = await makeRxEnv())
  const note = mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
  const { fileId } = await e.seedSynced(note)
  await e.receiver.check()
  await e.store.writeNote(withStroke(note, PA, 'a2'))
  const theirs = await e.remoteUpload(foreignEdit(note, PA, 'a3'), { fileId })
  await e.receiver.check()
  expect((await e.store.readSync(NID)).info.state).toBe('conflict')

  const info = (await e.store.readSync(NID)).info
  const entry = unresolvedOf(info)[0] as unknown as Conflict
  const sc = (await e.store.sidecars.get(NID, entry.pageId, entry.rev))!
  const ctx = { now: '2026-10-13T00:00:00.000Z', orderRev: 'o9', rev: 'r9', editedBy: 'Chrome, Windows', lastSeenRemoteSeq: 0 }
  const out = resolveConflict((await e.store.loadNote(NID))!.note!, entry, sc, 'mine', ctx)
  if (out.result !== 'resolved') throw new Error(out.error)
  await e.store.writeNote(out.note)
  await e.uploader.conflictResolved(NID, out.conflict as never)
  expect(await e.uploader.upload(NID)).toBe('uploaded')
  const ours = (await e.store.readSync(NID)).info.baseHeadRevisionId!
  expect(ours).not.toBe(theirs.head)

  e.drive.staleHead(fileId, theirs.head, 3) // the listing still shows the revision received at the conflict
  const before = e.events('stateChange').length
  await e.receiver.check()
  const after = (await e.store.readSync(NID)).info
  expect(after).toMatchObject({ state: 'synced', baseHeadRevisionId: ours })
  expect(e.events('stateChange')).toHaveLength(before)
  expect(e.events('conflictFound')).toHaveLength(1)
  const head = e.drive.revisions(fileId).at(-1)!
  expect(head.id).toBe(ours)
  const finalNote = (await decodeKkj(head.bytes)).note!
  expect(finalNote.pages.find((p) => p.id === PA)?.rev).toBe('r9')
})
