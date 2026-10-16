// An in-memory Drive for the root folder tests: createdTime, parents, trashed,
// appProperties, `drive.file` visibility (foreign items are never listed), a
// lagging list, paging, call log and failure injection.
import { createHash } from 'node:crypto'
import {
  DriveError,
  type DriveClient,
  type DriveFile,
} from '../src/drive/driveClient'

type Rev = { id: string; modifiedTime: string; bytes: Uint8Array }
type Session = { fileId?: string; metadata: Record<string, unknown>; size: number; received: number; chunks: Uint8Array[] }
type Item = DriveFile & { createdTime: string; foreign?: boolean; hidden?: boolean; revs: Rev[] }

const unq = (s: string) => s.replace(/\\(.)/g, '$1')

export function createFakeDrive(o: { pageSize?: number } = {}) {
  const items = new Map<string, Item>()
  const calls: string[] = []
  const counts: Record<string, number> = {}
  const failures: { method: string; nth: number; err: DriveError }[] = []
  let n = 0
  let clock = Date.UTC(2026, 9, 10, 4, 0, 0)
  let lag = false
  const hooks: { beforeCall?: (method: string, nth: number) => void; afterUpload?: (fileId: string) => void; afterUploadAsync?: (fileId: string) => Promise<void> | void; corruptMd5?: boolean } = {}
  const finished = new Map<string, DriveFile>()

  function enter(method: string, detail = '') {
    calls.push(`${method}${detail ? ' ' + detail : ''}`)
    counts[method] = (counts[method] ?? 0) + 1
    hooks.beforeCall?.(method, counts[method])
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
    ...(i.revs.length > 0 && {
      headRevisionId: i.revs.at(-1)!.id,
      md5Checksum: createHash('md5').update(i.revs.at(-1)!.bytes).digest('hex'),
      modifiedTime: i.revs.at(-1)!.modifiedTime,
    }),
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
      revs: [],
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

    // ---- uploads, revisions ----
    async uploadSimple({ fileId, metadata, bytes }) {
      enter('uploadSimple', fileId ?? 'create')
      uploads.push({ kind: 'simple', fileId, metadata, size: bytes.length })
      const f = commitUpload(fileId, metadata, bytes)
      await hooks.afterUploadAsync?.(f.id)
      afterEffect('uploadSimple')
      return f
    },
    async startResumable({ fileId, metadata, size }) {
      enter('startResumable', fileId ?? 'create')
      const uri = `session:${++n}`
      sessions.set(uri, { ...(fileId !== undefined && { fileId }), metadata, size, received: 0, chunks: [] })
      uploads.push({ kind: 'resumable', fileId, metadata, size })
      return uri
    },
    async putResumable(uri, size, offset, chunk) {
      enter('putResumable', `${uri} ${chunk ? `${offset}+${chunk.length}` : 'status'}`)
      const s = sessions.get(uri)
      if (!s) {
        const done = finished.get(uri)
        if (done && !chunk) return { received: size, file: done }
        throw new DriveError('http', 404, 'notFound')
      }
      if (chunk) {
        // Drive keeps only what continues what it holds.
        if (offset > s.received) throw new DriveError('http', 400, 'badContentRange')
        const fresh = chunk.subarray(s.received - offset)
        s.chunks.push(fresh)
        s.received += fresh.length
        chunkLog.push({ offset, length: chunk.length })
      }
      if (s.received < size) {
        afterEffect('putResumable')
        return { received: hideRange ? 0 : s.received }
      }
      const all = new Uint8Array(size)
      let at = 0
      for (const c of s.chunks) (all.set(c, at), (at += c.length))
      sessions.delete(uri)
      const f = commitUpload(s.fileId, s.metadata, all)
      finished.set(uri, f)
      await hooks.afterUploadAsync?.(f.id)
      afterEffect('putResumable')
      return { received: size, file: f }
    },
    async listRevisions(fileId) {
      enter('listRevisions', fileId)
      const i = items.get(fileId)
      if (!i) throw new DriveError('http', 404, 'notFound')
      const shown = hiddenRevs > 0 ? i.revs.slice(0, i.revs.length - 1) : i.revs
      if (hiddenRevs > 0) hiddenRevs--
      return shown.map((r) => ({ id: r.id, modifiedTime: r.modifiedTime }))
    },
    async downloadRevision(fileId, revisionId) {
      enter('downloadRevision', `${fileId} ${revisionId}`)
      const r = items.get(fileId)?.revs.find((x) => x.id === revisionId)
      if (!r) throw new DriveError('http', 404, 'notFound')
      return r.bytes
    },
  }

  const uploads: { kind: string; fileId?: string; metadata: Record<string, unknown>; size: number }[] = []
  const sessions = new Map<string, Session>()
  const chunkLog: { offset: number; length: number }[] = []
  const lost: { method: string; nth: number }[] = []
  let hiddenRevs = 0
  let hideRange = false
  let rev = 0

  // The effect of an upload on the stored file: a new revision, name and properties.
  function commitUpload(fileId: string | undefined, metadata: Record<string, unknown>, bytes: Uint8Array): DriveFile {
    clock += 60_000
    let i: Item
    if (fileId === undefined) {
      i = add({
        name: metadata.name as string,
        parents: (metadata.parents as string[] | undefined) ?? ['root'],
        appProperties: {},
      })
      if (lag) i.hidden = true
    } else {
      const f = items.get(fileId)
      if (!f) throw new DriveError('http', 404, 'notFound')
      i = f
      if (typeof metadata.name === 'string') i.name = metadata.name
    }
    const props = (metadata.appProperties ?? {}) as Record<string, string | null>
    for (const [k, v] of Object.entries(props)) {
      if (v === null) delete i.appProperties[k]
      else i.appProperties[k] = v
    }
    i.revs.push({ id: `rev${++rev}`, modifiedTime: new Date(clock).toISOString(), bytes: new Uint8Array(bytes) })
    hooks.afterUpload?.(i.id)
    const v = view(i)
    return hooks.corruptMd5 ? { ...v, md5Checksum: '0'.repeat(32) } : v
  }

  // The answer of the nth call of a method is lost after its effect happened.
  function afterEffect(method: string) {
    const k = lost.findIndex((x) => x.method === method && x.nth === counts[method])
    if (k >= 0) {
      lost.splice(k, 1)
      throw new DriveError('network')
    }
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
    hooks,
    uploads,
    sessions,
    chunkLog,
    /** The nth call (1-based) of `method` does its work, then rejects with a network error. */
    loseAnswer: (method: string, nth: number) => void lost.push({ method, nth }),
    /** Another device writes a revision: it becomes the head. */
    foreignRevision(fileId: string, bytes: Uint8Array) {
      clock += 60_000
      items.get(fileId)!.revs.push({ id: `rev${++rev}`, modifiedTime: new Date(clock).toISOString(), bytes })
      return `rev${rev}`
    },
    /** The revision listing lacks the newest revision for the next `times` listings. */
    lagRevisions: (times: number) => void (hiddenRevs = times),
    /** A 308 answers without a Range header. */
    hideRangeHeader: () => void (hideRange = true),
    /** Revisions Drive deleted. */
    purgeRevision: (fileId: string, id: string) => void (items.get(fileId)!.revs = items.get(fileId)!.revs.filter((r) => r.id !== id)),
    dropSessions: () => sessions.clear(),
    revisions: (fileId: string) => items.get(fileId)!.revs,
    byKkeujeokId: (id: string) => [...items.values()].filter((i) => i.appProperties.kkeujeokId === id && !i.foreign),
  })
}
export type FakeDrive = ReturnType<typeof createFakeDrive>
