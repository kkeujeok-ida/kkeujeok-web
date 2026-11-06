// Story 14.3: the trash service over the fake Drive: list order, restore (origin and root fallback), purge, empty.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { createFolderService } from '../src/library/folderService'
import { createTrashService } from '../src/library/trashService'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type Env, makeEnv } from './uploadHarness'

const FOLDER = 'application/vnd.google-apps.folder'
const KKJ = 'application/vnd.kkeujeok.kkj'
let env: Env | undefined
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

async function setup() {
  const e = (env = await makeEnv())
  const folders = createFolderService({ drive: e.drive, device: e.device, store: e.store, allowed: () => true, online: () => true, upload: async () => {} })
  const svc = createTrashService({ drive: e.drive, device: e.device, folders })
  const bin = (await folders.trashbinFileId())!
  const mk = (id: string, mimeType: string, parents: string[], props: Record<string, string> = {}) =>
    e.drive.create({ name: id + (mimeType === KKJ ? '.kkj' : ''), mimeType, parents, appProperties: { kkeujeokId: id, ...props } })
  return { e, svc, bin, mk }
}

describe('trash service', () => {
  test('lists notes and folders by trashedAt desc; restore goes to the origin, else the top level with a notice', async () => {
    const { e, svc, bin, mk } = await setup()
    const origin = await mk('aaaa', FOLDER, ['ROOT'])
    await mk('n-old', KKJ, [bin], { trashedFrom: 'aaaa', trashedAt: '2026-11-01T00:00:00.000Z' })
    await mk('n-new', KKJ, [bin], { trashedFrom: 'zzzz', trashedAt: '2026-11-02T00:00:00.000Z' })
    const list = await svc.list()
    expect(list.map((x) => x.id)).toEqual(['n-new', 'n-old'])

    expect(await svc.restore(list[1]!)).toBe('done')
    const old = e.drive.byKkeujeokId('n-old')[0]!
    expect(old.parents).toEqual([origin.id])
    expect(old.appProperties.trashedFrom).toBeUndefined()
    expect(old.appProperties.trashedAt).toBeUndefined()

    expect(await svc.restore(list[0]!)).toBe('rootFallback')
    expect(e.drive.byKkeujeokId('n-new')[0]!.parents).toEqual(['ROOT'])
    expect(await svc.restore(list[0]!)).toBe('gone') // already restored
  })

  test('purge and empty set trashed=true, never delete; one failure stays listed', async () => {
    const { e, svc, bin, mk } = await setup()
    const a = await mk('n-a', KKJ, [bin], { trashedAt: '2026-11-02T00:00:00.000Z' })
    const b = await mk('n-b', KKJ, [bin], { trashedAt: '2026-11-01T00:00:00.000Z' })
    const list = await svc.list()
    expect(await svc.purge(list[0]!)).toBe('done')
    expect(e.drive.items.get(a.id)!.trashed).toBe(true)
    expect(e.drive.items.has(b.id)).toBe(true)
    expect(await svc.purge(list[0]!)).toBe('gone')

    const left = await svc.empty((await svc.list()))
    expect(left).toEqual([])
    expect(e.drive.items.get(b.id)!.trashed).toBe(true)
  })
})
