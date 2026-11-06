// Story 14.4: the Drive state the Android client leaves in `.trashbin` (and what someone does by hand in the
// Drive UI) read by the web trash and library. The same scenarios as kkeujeok-client/test/trash_roundtrip_test.dart.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { createFolderService } from '../src/library/folderService'
import { createTrashService } from '../src/library/trashService'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type Env, makeEnv, mkNote } from './uploadHarness'

const FOLDER = 'application/vnd.google-apps.folder'
const KKJ = 'application/vnd.kkeujeok.kkj'
const F = '01926f3a-0000-7000-8000-000000001001' // live folder
const D = '01926f3a-0000-7000-8000-000000001002' // folder trashed elsewhere
const N1 = '01926f3a-0000-7000-8000-000000002001' // note in F
const N2 = '01926f3a-0000-7000-8000-000000002002' // note trashed elsewhere
const N3 = '01926f3a-0000-7000-8000-000000002003' // note below D
const AT1 = '2026-11-01T00:00:00.000Z'
const AT2 = '2026-11-02T00:00:00.000Z'

let env: Env | undefined
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

/** Drive as the other client leaves it: live folder F with N1; N2 and folder D (holding N3) in `.trashbin`. */
async function setup() {
  const e = (env = await makeEnv())
  const folders = createFolderService({ drive: e.drive, device: e.device, store: e.store, allowed: () => true, online: () => true, upload: async () => {} })
  const svc = createTrashService({ drive: e.drive, device: e.device, folders })
  const bin = (await folders.trashbinFileId())!
  const mk = (id: string, folder: boolean, parents: string[], props: Record<string, string> = {}) =>
    e.drive.create({ name: folder ? id : `${id}.kkj`, mimeType: folder ? FOLDER : KKJ, parents, appProperties: { kkeujeokId: id, ...props } })
  const f = await mk(F, true, ['ROOT'])
  await mk(N1, false, [f.id])
  await mk(N2, false, [bin], { trashedFrom: F, trashedAt: AT1 })
  const d = await mk(D, true, [bin], { trashedFrom: 'root', trashedAt: AT2 })
  await mk(N3, false, [d.id])
  expect(await folders.refresh()).toBe(true)
  const fileOf = (id: string) => e.drive.byKkeujeokId(id)[0]!
  return { e, folders, svc, bin, mk, fileOf }
}

describe('trash round trip with the Android client', () => {
  test('(a) trashed by the other client: in the trash list, nowhere in the library', async () => {
    const { folders, svc } = await setup()
    const v = await folders.view()
    expect(v.hiddenNotes).toEqual(new Set([N2, N3]))
    expect(v.folders.map((f) => f.id)).toEqual([F])
    expect([...v.hiddenNotes].some((id) => v.noteFolder[id] !== undefined)).toBe(false)
    expect((await svc.list()).map((x) => [x.id, x.isFolder, x.noteCount])).toEqual([[D, true, 1], [N2, false, 0]])
  })

  test('(a) a note with unsent changes trashed by the other client is revived, not lost', async () => {
    const { e, folders, svc, fileOf } = await setup()
    await e.store.writeNote(mkNote({ noteId: N2 }))
    expect(await folders.refresh()).toBe(true)
    expect(await e.store.listIds()).toContain(N2)
    expect(fileOf(N2).parents).toEqual([fileOf(F).id])
    expect((await svc.list()).map((x) => x.id)).toEqual([D])
  })

  test('(b) restore returns to the origin; origin gone means top level', async () => {
    const { folders, svc, bin, mk, fileOf } = await setup()
    const list = await svc.list()
    expect(await svc.restore(list.find((x) => x.id === N2)!)).toBe('done')
    expect(fileOf(N2).parents).toEqual([fileOf(F).id])
    expect(await svc.restore(list.find((x) => x.id === D)!)).toBe('done')
    await folders.refresh()
    const v = await folders.view()
    expect(v.hiddenNotes.size).toBe(0)
    expect(v.noteFolder[N2]).toBe(F)
    expect(v.noteFolder[N3]).toBe(D)
    // Origin deleted afterwards: top level with the notice.
    const n = await mk('01926f3a-0000-7000-8000-000000002004', false, [bin], { trashedFrom: F, trashedAt: AT1 })
    env!.drive.remove(fileOf(F).id)
    expect(await svc.restore((await svc.list())[0]!)).toBe('rootFallback')
    expect(env!.drive.items.get(n.id)!.parents).toEqual(['ROOT'])
  })

  test('(c) purge and empty set trashed=true and drop the item from the list', async () => {
    const { e, svc, fileOf } = await setup()
    const list = await svc.list()
    expect(await svc.purge(list[0]!)).toBe('done')
    expect((await svc.list()).map((x) => x.id)).toEqual([N2])
    expect(await svc.empty(await svc.list())).toEqual([])
    for (const id of [D, N2]) expect(fileOf(id).trashed).toBe(true)
    expect(e.drive.items.has(fileOf(D).id)).toBe(true) // never files.delete
    expect(await svc.list()).toEqual([])
  })

  test('(d) Drive UI: moved out is a library item; hand-added is listed by modifiedTime; a lost .trashbin is recreated', async () => {
    const { e, folders, svc, bin, mk, fileOf } = await setup()
    // Moved out of .trashbin by hand: stale properties are ignored.
    e.drive.move(fileOf(N2).id, 'ROOT')
    // Put in by hand: no properties, only a revision (so a modifiedTime).
    const handId = '01926f3a-0000-7000-8000-000000002005'
    const hand = await mk(handId, false, [bin])
    await e.drive.uploadSimple({ fileId: hand.id, metadata: {}, bytes: new Uint8Array([1]) })
    await folders.refresh()
    const v = await folders.view()
    expect(v.hiddenNotes.has(N2)).toBe(false)
    expect(v.noteFolder[N2]).toBeNull()
    expect(v.hiddenNotes.has(handId)).toBe(true)
    const entry = (await svc.list()).find((x) => x.id === handId)!
    expect(entry.trashedFrom).toBeNull()
    expect(entry.trashedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(await svc.restore(entry)).toBe('done')
    expect(fileOf(handId).parents).toEqual(['ROOT'])

    // .trashbin deleted: the next delete makes a new one; nothing is lost.
    e.drive.remove(bin)
    await folders.deleteFolder(F)
    await folders.flush()
    const fresh = fileOf('trashbin')
    expect(fresh.id).not.toBe(bin)
    expect(fileOf(F).parents).toEqual([fresh.id])
    expect(fileOf(N3)).toBeDefined()
  })
})
