// An in-memory Drive for the root folder tests: createdTime, parents, trashed,
// appProperties, `drive.file` visibility (foreign items are never listed), a
// lagging list, paging, call log and failure injection.
import {
  DriveError,
  type DriveClient,
  type DriveFile,
} from '../src/drive/driveClient'

type Item = DriveFile & { createdTime: string; foreign?: boolean; hidden?: boolean }

const unq = (s: string) => s.replace(/\\(.)/g, '$1')

export function createFakeDrive(o: { pageSize?: number } = {}) {
  const items = new Map<string, Item>()
  const calls: string[] = []
  const counts: Record<string, number> = {}
  const failures: { method: string; nth: number; err: DriveError }[] = []
  let n = 0
  let clock = Date.UTC(2026, 9, 10, 4, 0, 0)
  let lag = false

  function enter(method: string, detail = '') {
    calls.push(`${method}${detail ? ' ' + detail : ''}`)
    counts[method] = (counts[method] ?? 0) + 1
    const f = failures.find((x) => x.method === method && x.nth === counts[method])
    if (f) throw f.err
  }
  const view = (i: Item): DriveFile => ({
    id: i.id,
    ...(i.name !== undefined && { name: i.name }),
    parents: [...i.parents],
    appProperties: { ...i.appProperties },
    createdTime: i.createdTime,
    trashed: i.trashed,
  })

  function add(meta: { name?: string; parents?: string[]; appProperties?: Record<string, string>; foreign?: boolean }): Item {
    clock += 60_000
    const item: Item = {
      id: `d${++n}`,
      ...(meta.name !== undefined && { name: meta.name }),
      parents: meta.parents ?? ['root'],
      appProperties: meta.appProperties ?? {},
      createdTime: new Date(clock).toISOString(),
      trashed: false,
      ...(meta.foreign && { foreign: true }),
    }
    items.set(item.id, item)
    return item
  }

  const drive: DriveClient & Record<string, unknown> = {
    async list(q, p = {}) {
      enter('list', q)
      const kid = /value='((?:\\.|[^'\\])*)'/.exec(q)
      const par = /^'((?:\\.|[^'\\])*)' in parents/.exec(q)
      const all = [...items.values()].filter(
        (i) =>
          !i.trashed &&
          !i.foreign &&
          !i.hidden &&
          (kid ? i.appProperties.kkeujeokId === unq(kid[1]!) : par ? i.parents.includes(unq(par[1]!)) : false),
      )
      const size = o.pageSize ?? 1000
      const start = p.pageToken ? Number(p.pageToken) : 0
      const page = all.slice(start, start + size)
      return { files: page.map(view), ...(start + size < all.length && { nextPageToken: String(start + size) }) }
    },
    async create(meta) {
      enter('create')
      const item = add(meta as Parameters<typeof add>[0])
      if (lag) item.hidden = true
      return view(item)
    },
    async get(id) {
      enter('get', id)
      const i = items.get(id)
      if (!i) throw new DriveError('http', 404, 'notFound')
      return view(i)
    },
    async update(id, p) {
      enter('update', JSON.stringify({ id, ...p }))
      const i = items.get(id)
      if (!i) throw new DriveError('http', 404, 'notFound')
      if (p.addParents) i.parents = [...i.parents.filter((x) => x !== p.removeParents), p.addParents]
      else if (p.removeParents) i.parents = i.parents.filter((x) => x !== p.removeParents)
      if (p.trashed !== undefined) i.trashed = p.trashed
      return view(i)
    },
  }

  return Object.assign(drive, {
    calls,
    items,
    /** Items created after this stay out of lists until `settle()`. */
    lagOn: () => void (lag = true),
    settle() {
      lag = false
      for (const i of items.values()) delete i.hidden
    },
    /** A folder or file this app can never see (made by the user, no kkeujeokId). */
    foreign: (name: string) => add({ name, foreign: true }),
    /** A root made earlier (by another device). */
    addRoot: (parents = ['root']) => add({ name: 'Kkeujeok', parents, appProperties: { kkeujeokId: 'root' } }),
    addChild: (parent: string, name = 'child') => add({ name, parents: [parent], appProperties: { kkeujeokId: `n-${n + 1}` } }),
    /** The nth call (1-based) of `method` rejects with `err`. */
    failAt: (method: string, nth: number, err: DriveError) => void failures.push({ method, nth, err }),
    failAlways(method: string, err: DriveError) {
      for (let k = 1; k <= 50; k++) failures.push({ method, nth: k, err })
    },
    clearFailures: () => void (failures.length = 0, Object.keys(counts).forEach((k) => delete counts[k])),
    roots: () => [...items.values()].filter((i) => i.appProperties.kkeujeokId === 'root' && !i.foreign),
    trash: (id: string) => void (items.get(id)!.trashed = true),
    remove: (id: string) => void items.delete(id),
    count: (m: string) => calls.filter((c) => c.split(' ')[0] === m).length,
  })
}
export type FakeDrive = ReturnType<typeof createFakeDrive>
