// Story 7.6: the folder service over the fake Drive and fake-indexeddb: offline queue, no double create,
// move rules, the order of a folder delete, remote changes.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { createFolderService } from '../src/library/folderService'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type Env, NID, makeEnv, mkNote } from './uploadHarness'

const FOLDER = 'application/vnd.google-apps.folder'
let env: Env | undefined
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

let n = 0
async function setup(o: { upload?: (id: string) => Promise<void> } = {}) {
  const e = (env = await makeEnv())
  const svc = createFolderService({
    drive: e.drive,
    device: e.device,
    store: e.store,
    allowed: () => e.flags.allowed,
    online: () => e.flags.online,
    upload: o.upload ?? (async (id) => void (await e.uploader.upload(id))),
    newFolderId: () => `01926f3a-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    now: () => new Date('2026-11-01T09:00:00.000Z'),
  })
  return { e, svc }
}
const folderItems = (e: Env) => [...e.drive.items.values()].filter((i) => i.mimeType === FOLDER && i.appProperties.kkeujeokId !== 'trashbin')

describe('create and the offline queue', () => {
  test('a folder made offline shows at once, is created once when online, and a retry makes no second one', async () => {
    const { e, svc } = await setup()
    e.flags.online = false
    const r = await svc.createFolder('  수학  ', 'root')
    expect(r.error).toBeUndefined()
    expect((await svc.view()).folders.map((f) => f.name)).toEqual(['수학'])
    expect(folderItems(e)).toHaveLength(0)
    expect(await svc.hasPending()).toBe(true)

    e.flags.online = true
    expect(await svc.flush()).toBe(true)
    expect(await svc.flush()).toBe(true)
    expect(folderItems(e)).toHaveLength(1)
    expect(folderItems(e)[0]!.appProperties.kkeujeokId).toBe(r.id)
    expect(folderItems(e)[0]!.name).toBe('수학')
    expect(await svc.hasPending()).toBe(false)
  })

  test('an interrupted creation (the answer was lost) is found again by kkeujeokId', async () => {
    const { e, svc } = await setup()
    e.drive.loseAnswer('create', 1)
    await svc.createFolder('A', 'root')
    await svc.flush() // the create reached Drive, its answer did not
    await svc.flush()
    expect(folderItems(e)).toHaveLength(1)
  })

  test('a note made in a folder offline goes to that folder once it exists', async () => {
    const { e, svc } = await setup()
    e.flags.online = false
    const f = await svc.createFolder('F', 'root')
    await svc.assignNote(NID, f.id!)
    e.flags.online = true
    const fileId = await svc.parentFileId(NID)
    expect(fileId).toBe(folderItems(e)[0]!.id)
    expect(folderItems(e)).toHaveLength(1)
  })

  test('offline rename and move are applied at once, queued in order and sent when online', async () => {
    const { e, svc } = await setup()
    const a = await svc.createFolder('A', 'root')
    const b = await svc.createFolder('B', 'root')
    await svc.flush()
    e.flags.online = false
    await svc.renameFolder(a.id!, 'A2')
    await svc.moveFolder(b.id!, a.id!)
    const v = await svc.view()
    expect(v.folder(a.id!)!.name).toBe('A2')
    expect(v.folder(b.id!)!.parentId).toBe(a.id)
    expect(await svc.hasPending()).toBe(true)
    e.flags.online = true
    expect(await svc.flush()).toBe(true)
    const byKid = (id: string) => e.drive.byKkeujeokId(id)[0]!
    expect(byKid(a.id!).name).toBe('A2')
    expect(byKid(b.id!).parents).toEqual([byKid(a.id!).id])
    expect(await svc.hasPending()).toBe(false)
  })
})

describe('moving', () => {
  test('a folder cannot go into itself or below itself, and an undo restores the old parent', async () => {
    const { svc } = await setup()
    const a = await svc.createFolder('A', 'root')
    const b = await svc.createFolder('B', a.id!)
    expect((await svc.moveFolder(a.id!, a.id!)).error).toBe('moveIntoSelf')
    expect((await svc.moveFolder(a.id!, b.id!)).error).toBe('moveIntoDescendant')
    expect((await svc.moveFolder(a.id!, 'nope')).error).toBe('parentNotFound')
    const r = await svc.moveFolder(b.id!, 'root')
    expect(r.error).toBeUndefined()
    expect((await svc.view()).folder(b.id!)!.parentId).toBe('root')
    await svc.undo(r.inverse!)
    expect((await svc.view()).folder(b.id!)!.parentId).toBe(a.id)
  })
})

describe('deleting a folder', () => {
  async function withNote(upload?: (id: string) => Promise<void>) {
    const s = await setup(upload ? { upload } : {})
    const f = await s.svc.createFolder('F', 'root')
    await s.svc.flush()
    await s.e.store.writeNote(mkNote())
    await s.svc.assignNote(NID, f.id!)
    return { ...s, f }
  }

  test('uploads what is unsent, moves the folder to .trashbin, then removes the device copy', async () => {
    const { e, svc, f } = await withNote()
    e.flags.online = false
    await svc.deleteFolder(f.id!)
    expect((await svc.view()).has(f.id!)).toBe(false) // hidden at once
    expect((await svc.view()).hiddenNotes.has(NID)).toBe(true)
    expect(await e.store.loadNote(NID)).not.toBeNull() // offline: nothing moved yet
    e.flags.online = true
    expect(await svc.flush()).toBe(true)

    const folder = e.drive.byKkeujeokId(f.id!)[0]!
    const trashbin = e.drive.byKkeujeokId('trashbin')[0]!
    expect(folder.parents).toEqual([trashbin.id])
    expect(folder.trashed).toBe(false)
    expect(folder.appProperties).toMatchObject({ trashedFrom: 'root', trashedAt: '2026-11-01T09:00:00.000Z' })
    const upload = e.drive.calls.findIndex((c) => /^(uploadSimple|startResumable)/.test(c))
    const move = e.drive.calls.findIndex((c) => c.startsWith('update') && c.includes('trashedFrom'))
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(move).toBeGreaterThan(upload)
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
    expect(await e.store.loadNote(NID)).toBeNull() // the device copy is gone
    expect(await svc.hasPending()).toBe(false)
  })

  test('when the upload fails the folder stays hidden, the device copy stays and the next flush retries', async () => {
    let works = false
    const { e, svc, f } = await withNote(async (id) => {
      if (works) await e!.uploader.upload(id)
    })
    await svc.deleteFolder(f.id!)
    await svc.flush()
    expect(e.drive.byKkeujeokId(f.id!)[0]!.parents).toEqual(['ROOT'])
    expect(await e.store.loadNote(NID)).not.toBeNull()
    expect((await svc.view()).has(f.id!)).toBe(false)
    works = true
    expect(await svc.flush()).toBe(true)
    expect(e.drive.byKkeujeokId(f.id!)[0]!.parents).not.toEqual(['ROOT'])
    expect(await e.store.loadNote(NID)).toBeNull()
  })
})

describe('reading Drive', () => {
  const mk = (e: Env, id: string, parents: string[], name = id) =>
    e.drive.create({ name, mimeType: FOLDER, parents, appProperties: { kkeujeokId: id } })

  test('a folder made, renamed or deleted elsewhere is followed; the folder being looked at can vanish', async () => {
    const { e, svc } = await setup()
    const a = await mk(e, 'aaaa', ['ROOT'], 'A')
    await mk(e, 'bbbb', [a.id], 'B')
    expect(await svc.refresh()).toBe(true)
    let v = await svc.view()
    expect(v.folders.map((f) => [f.id, f.name, f.parentId])).toEqual([['aaaa', 'A', 'root'], ['bbbb', 'B', 'aaaa']])
    e.drive.rename(a.id, 'A!')
    e.drive.trash(e.drive.byKkeujeokId('bbbb')[0]!.id)
    await svc.refresh()
    v = await svc.view()
    expect(v.folders.map((f) => f.name)).toEqual(['A!'])
    expect(v.has('bbbb')).toBe(false)
  })

  test('a folder cycle is drawn repaired and the smallest id is moved to the top level in Drive', async () => {
    const { e, svc } = await setup()
    const a = await mk(e, 'aaaa', ['ROOT'])
    const b = await mk(e, 'bbbb', [a.id])
    e.drive.move(a.id, b.id) // the other device moved A into B
    await svc.refresh()
    const v = await svc.view()
    expect(v.folder('aaaa')!.parentId).toBe('root')
    expect(v.folder('bbbb')!.parentId).toBe('aaaa')
    expect(e.drive.byKkeujeokId('aaaa')[0]!.parents).toEqual(['ROOT'])
  })

  test('a folder in .trashbin and the notes below it are hidden', async () => {
    const { e, svc } = await setup()
    const tb = await mk(e, 'trashbin', ['ROOT'], '.trashbin')
    await mk(e, 'cccc', [tb.id])
    await svc.refresh()
    expect((await svc.view()).has('cccc')).toBe(false)
  })
})
