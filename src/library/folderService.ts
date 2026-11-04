// Story 7.6: the folders of the library on this browser and in Drive.
//
// The device record keeps three things in `extra` (spec `library` "Offline"):
// `folders` (the cache: id = kkeujeokId, fileId = Drive id or null until it is
// created, name, parentId), `noteParents` (note id -> parent kkeujeokId) and
// `driveOps` (Drive-only changes waiting to be sent, in order). Every change is
// applied to the cache at once and sent when the browser is online.
// Mirrors kkeujeok-client/lib/library/folder_service.dart.
import { type DriveClient, DriveError, kkeujeokIdQuery } from '../drive/driveClient'
import { driveDuplicatesRule } from '../drive/duplicates'
import { newId } from '../model/ids'
import type { NoteStore } from '../storage/noteStore'
import { NoteSaveError } from '../storage/noteDb'
import type { SyncDevice, SyncDeviceStore } from '../storage/syncDevice'
import { NOTE_FILES_QUERY } from '../sync/noteReceiver'
import { isTrashMark } from '../sync/noteUploader'
import {
  type DriveOp,
  type Folder,
  type RuleError,
  libraryCreateFolder,
  libraryMoveFolder,
  libraryMoveNote,
  libraryRenameFolder,
  libraryTree,
  trashFolderRule,
} from './libraryRules'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FOLDERS_QUERY = `trashed=false and mimeType='${FOLDER_MIME}'`
// Not library folders: the system ones, and `cf:<noteId>` (a conflict folder named by a noteId, which showed as a hash-named folder: Story 18.1).
const SYSTEM_IDS = new Set(['root', 'assets', 'conflicts', 'trashbin'])
const isLibraryFolderKey = (k: string) => !SYSTEM_IDS.has(k) && !k.includes(':')

type DriveFileLike = { id: string; parents: string[]; appProperties: Record<string, string> }
type CacheFolder = Folder & { fileId: string | null }
type State = { folders: CacheFolder[]; noteParents: Record<string, string>; ops: DriveOp[] }

/** A folder the person sees; `parentId` is `root` or another visible folder. */
export type LibraryFolder = Folder

/**
 * What the library shows: `folders` in cache order, the folder of every known note (`null` = top level)
 * and the notes that are hidden (in the trash, or below a folder that is).
 */
export class FolderView {
  constructor(
    readonly folders: LibraryFolder[] = [],
    readonly noteFolder: Readonly<Record<string, string | null>> = {},
    readonly hiddenNotes: ReadonlySet<string> = new Set(),
  ) {}
  has = (id: string) => this.folders.some((f) => f.id === id)
  folder = (id: string) => this.folders.find((f) => f.id === id)
  childrenOf = (parentId: string) => this.folders.filter((f) => f.parentId === parentId)
  /** True when `id` is `ancestor` or lies below it. */
  isInside(id: string, ancestor: string): boolean {
    let p: string | undefined = id
    for (let n = 0; p !== undefined && p !== 'root' && n <= this.folders.length; n++) {
      if (p === ancestor) return true
      p = this.folder(p)?.parentId
    }
    return false
  }
  /** The notes in `id` and every folder below it. */
  noteCount(id: string): number {
    return Object.values(this.noteFolder).filter((f) => f !== null && this.isInside(f, id)).length
  }
}

/** The answer of a folder change: `error` is a rule code (nothing changed); `inverse` undoes it. */
export type FolderResult = { error?: string; id?: string; inverse?: DriveOp | null }

export type FolderServiceDeps = {
  drive: DriveClient
  device: Pick<SyncDeviceStore, 'read' | 'update'>
  store: Pick<NoteStore, 'readSync' | 'listIds' | 'loadNote' | 'removeNote'>
  /** The upload gate (root folder ready). */
  allowed: () => boolean
  online: () => boolean
  /** Uploads one note; the service checks afterwards whether anything is left unsent. */
  upload: (noteId: string) => Promise<void>
  /** Story 7.8: a note is open in an editor (any tab): its device copy is not removed under it. */
  isOpen?: (noteId: string) => Promise<boolean>
  /** Story 18.1: the sync log; every folder change adds a `folderOp` entry. */
  log?: { append(event: string, fields?: Record<string, unknown>): Promise<unknown> }
  now?: () => Date
  newFolderId?: () => string
}

export type FolderService = ReturnType<typeof createFolderService>

const subtree = (s: State, id: string): Set<string> => {
  const out = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of s.folders) if (out.has(f.parentId) && !out.has(f.id)) (out.add(f.id), (grew = true))
  }
  return out
}
const folderOf = (s: State, id: string) => s.folders.find((f) => f.id === id)
const notesIn = (s: State, ids: Set<string>) => Object.entries(s.noteParents).filter(([, p]) => ids.has(p)).map(([n]) => n)

/** The tree the rules see: a folder with a pending `trashFolder` hangs below `trashbin` (spec trash "Hiding while pending"). */
function treeOf(s: State) {
  const trashing = new Set(s.ops.filter((o) => o.kind === 'trashFolder').map((o) => o.id))
  return libraryTree({
    folders: s.folders.map((f) => ({ id: f.id, parentId: trashing.has(f.id) ? 'trashbin' : f.parentId })),
    notes: Object.entries(s.noteParents).map(([noteId, parentId]) => ({ noteId, parentId })),
  })
}

/** The visible folders in the shape the rules take. */
const visible = (s: State): Folder[] => treeOf(s).folders.map((v) => ({ id: v.id, name: folderOf(s, v.id)!.name, parentId: v.parentId }))

function readState(d: SyncDevice): State {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null) : [])
  const np = d.extra.noteParents
  return {
    folders: list(d.extra.folders).map((f) => ({ id: String(f.id), fileId: typeof f.fileId === 'string' ? f.fileId : null, name: String(f.name ?? ''), parentId: String(f.parentId ?? 'root') })),
    noteParents: Object.fromEntries(Object.entries(typeof np === 'object' && np !== null ? np : {}).filter(([, v]) => typeof v === 'string') as [string, string][]),
    ops: list(d.extra.driveOps).map((o) => ({ ...o })),
  }
}
const writeState = (d: SyncDevice, s: State): SyncDevice => ({ ...d, extra: { ...d.extra, folders: s.folders, noteParents: s.noteParents, driveOps: s.ops } })

const keyOf = (e: DriveOp) => `${String(e.kind)}\u0000${String(e.id ?? e.noteId)}`

/** A new entry of the same kind and id replaces the older one in place and keeps its `removeParent` (spec library "Offline"). */
function enqueue(ops: DriveOp[], op: DriveOp) {
  const i = ops.findIndex((e) => keyOf(e) === keyOf(op))
  if (i < 0) ops.push(op)
  else if (op.kind === 'trashFolder') {
    // the first delete keeps its date and origin
  } else if (op.kind === 'moveNote' || op.kind === 'moveFolder') {
    const keep = ops[i]!.removeParent
    if (op.addParent === keep) ops.splice(i, 1)
    else ops[i] = { ...op, removeParent: keep }
  } else ops[i] = op
}

const is404 = (e: unknown) => e instanceof DriveError && e.kind === 'http' && e.status === 404

export function createFolderService(deps: FolderServiceDeps) {
  const { drive, device, store } = deps
  const now = deps.now ?? (() => new Date())
  const makeId = deps.newFolderId ?? newId
  const listeners = new Set<() => void>()
  let tail: Promise<unknown> = Promise.resolve()
  const creating = new Map<string, Promise<string | null>>()

  /** Public changes run one after another. */
  const run = <T>(body: () => Promise<T>): Promise<T> => {
    const r = tail.then(body)
    tail = r.catch(() => {})
    return r
  }
  const notify = () => listeners.forEach((fn) => fn())
  const logOp = (op: string, folderId: string) => void Promise.resolve(deps.log?.append('folderOp', { op, folderId })).catch(() => {})
  const load = async () => readState(await device.read())
  /** Changes the cache under the device record's transaction. */
  async function mutate(change: (s: State) => void): Promise<void> {
    await device.update((d) => {
      const s = readState(d)
      change(s)
      return writeState(d, s)
    })
    notify()
  }

  function viewOf(s: State): FolderView {
    const t = treeOf(s)
    return new FolderView(
      t.folders.map((v) => ({ id: v.id, name: folderOf(s, v.id)!.name, parentId: v.parentId })),
      Object.fromEntries(t.notes.map((n) => [n.noteId, n.folderId])),
      new Set(t.hidden.notes),
    )
  }

  async function all(q: string, fields: string) {
    const out = []
    let token: string | undefined
    do {
      const p = await drive.list(q, { fields: `nextPageToken,files(${fields})`, ...(token && { pageToken: token }) })
      out.push(...p.files)
      token = p.nextPageToken
    } while (token)
    return out
  }

  /** Finds or creates the folder with `kkeujeokId` `kid`; the oldest stays when there are several (`.trashbin` duplicates: Story 14.2). */
  async function ensureItem(kid: string, name: string, parentFile: string): Promise<string> {
    const drop = (list: Record<string, unknown>[]) => list.filter((i) => i.kkeujeokId !== kid)
    await device.update((d) => ({ ...d, createIntents: [...drop(d.createIntents), { kkeujeokId: kid, kind: 'folder', parentId: parentFile }] }))
    let found = await all(kkeujeokIdQuery(kid), 'id,createdTime')
    let fileId: string | undefined
    if (found.length === 0) {
      const made = await drive.create({ name, mimeType: FOLDER_MIME, parents: [parentFile], appProperties: { kkeujeokId: kid } })
      found = await all(kkeujeokIdQuery(kid), 'id,createdTime')
      if (found.length === 0) fileId = made.id // the listing lags
    }
    fileId ??= (driveDuplicatesRule({ kkeujeokId: kid, items: found.map((f) => ({ id: f.id, createdTime: f.createdTime ?? '9999-12-31T23:59:59.999Z' })) }) as { keep: string }).keep
    await device.update((d) => ({ ...d, createIntents: drop(d.createIntents) }))
    return fileId
  }

  /** The Drive id of cache folder `id`, created when it is not there yet (spec drive-layout "Idempotent creation"). */
  const ensureFolder = (id: string): Promise<string | null> => {
    let p = creating.get(id)
    if (!p) {
      p = create(id).finally(() => void creating.delete(id))
      creating.set(id, p)
    }
    return p
  }
  async function create(id: string): Promise<string | null> {
    const s = await load()
    const f = folderOf(s, id)
    if (!f) return null
    if (f.fileId) return f.fileId
    const root = (await device.read()).rootFolderId
    if (!root) return null
    const parentFile = f.parentId === 'root' || !folderOf(s, f.parentId) ? root : ((await ensureFolder(f.parentId)) ?? root)
    const fileId = await ensureItem(id, f.name, parentFile)
    await mutate((st) => void (folderOf(st, id) && (folderOf(st, id)!.fileId = fileId)))
    return fileId
  }

  /** Makes `target` the only parent of `fileId`. */
  async function moveTo(fileId: string | null, target: string | null) {
    if (!fileId || !target) return
    const cur = (await drive.get(fileId, { fields: 'id,parents' })).parents
    if (cur.length === 1 && cur[0] === target) return
    const others = cur.filter((p) => p !== target).join(',')
    await drive.update(fileId, { ...(!cur.includes(target) && { addParents: target }), ...(others && { removeParents: others }) })
  }

  const unsent = async (noteId: string) => {
    const r = await store.readSync(noteId)
    return r.hasUnsent || r.info.pendingVerify !== null || r.state === 'conflict'
  }

  async function removeLocal(noteId: string): Promise<boolean> {
    try {
      const r = await store.loadNote(noteId)
      return r?.result === 'ok' && !!r.note && (await store.removeNote(noteId, r.note))
    } catch (e) {
      if (e instanceof NoteSaveError) return false
      throw e
    }
  }

  /** The folder, everything below it and their notes leave the cache; a note whose device copy stayed (`kept`) stays hidden. */
  const forget = (id: string, kept: string[]) =>
    mutate((s) => {
      const ids = subtree(s, id)
      for (const n of notesIn(s, ids)) {
        if (kept.includes(n)) s.noteParents[n] = 'trashbin'
        else delete s.noteParents[n]
      }
      s.folders = s.folders.filter((f) => !ids.has(f.id))
      s.ops = s.ops.filter((o) => o.kind === 'trashFolder' || !ids.has(String(o.id)))
    })

  /** One `trashFolder` entry (`trash.trashFolder`): upload what is unsent, move to `.trashbin`, remove the device copies. False while it must wait. */
  async function trash(op: DriveOp, root: string): Promise<boolean> {
    const id = String(op.id)
    let s = await load()
    const f = folderOf(s, id)
    if (!f) return true
    const fileId = await ensureFolder(id)
    if (!fileId) return true
    const trashbin = await ensureItem('trashbin', '.trashbin', root)
    let cur
    try {
      cur = await drive.get(fileId, { fields: 'id,parents,appProperties' })
    } catch (e) {
      if (is404(e)) return (await forget(id, []), true)
      throw e
    }
    const ids = subtree(s, id)
    const local = new Set(await store.listIds())
    const pending = notesIn(s, ids)
    const toSend: string[] = []
    for (const n of pending) if (local.has(n) && (await unsent(n))) toSend.push(n)
    const already = cur.parents.includes(trashbin)
    const r = trashFolderRule({
      id,
      fileId,
      parentId: already ? 'trashbin' : f.parentId,
      parentFileId: cur.parents.filter((p) => p !== trashbin).join(','),
      trashbinFileId: trashbin,
      now: String(op.trashedAt),
      unsent: toSend.length > 0,
      online: true,
      pending: { trashedAt: String(op.trashedAt), from: (op.from as string | null) ?? null },
    })
    if ('error' in r) return true
    const steps = [...r.steps, ...(r.already ? ['removeLocal'] : [])]
    for (const step of steps) {
      if (step === 'upload') {
        for (const n of toSend) {
          await deps.upload(n)
          if (await unsent(n)) return false
        }
      } else if (step === 'move') {
        const q = r.request!
        await drive.update(fileId, { addParents: q.addParents, removeParents: q.removeParents, appProperties: q.appProperties })
      } else if (step === 'removeLocal') {
        s = await load()
        const kept: string[] = []
        for (const n of notesIn(s, ids)) if (local.has(n) && !(await removeLocal(n))) kept.push(n)
        await forget(id, kept)
      }
    }
    return true
  }

  /**
   * `trash.remoteTrashed`: another device moved a note this device has into `.trashbin`. Nothing unsent: the device
   * copy goes (not while an editor has it open: the next refresh). Unsent changes: the note is moved back to
   * `trashedFrom` (else the top level) and the revive notice is counted. This device's own pending delete wins.
   */
  async function remoteTrashed(hidden: string[], hiddenFolders: Set<string>, local: Set<string>, files: Map<string, DriveFileLike>, folders: Map<string, DriveFileLike>, root: string): Promise<Map<string, string>> {
    const revived = new Map<string, string>() // note id -> its folder's kkeujeokId again
    for (const id of hidden) {
      const file = files.get(id)
      if (!local.has(id) || !file) continue
      if (isTrashMark((await store.readSync(id)).info.extra.pendingTrash)) continue
      try {
        if (!(await unsent(id))) {
          if (await deps.isOpen?.(id)) continue // next refresh
          await api.forgetNote(id)
          await removeLocal(id)
          continue
        }
        const from = file.appProperties.trashedFrom
        const origin = from === undefined ? undefined : folders.get(from)
        // An origin that is itself in the trash is no destination.
        const target = !origin || hiddenFolders.has(from!) ? root : origin.id
        await drive.update(file.id, { addParents: target, removeParents: file.parents.join(',') })
        revived.set(id, target === root ? 'root' : from!)
        await device.update((d) => ({ ...d, extra: { ...d.extra, revivedCount: (typeof d.extra.revivedCount === 'number' ? d.extra.revivedCount : 0) + 1 } }))
      } catch (e) {
        if (!(e instanceof DriveError)) throw e // the next refresh repeats it
      }
    }
    return revived
  }

  /** True when the entry is done and may leave the queue. */
  async function send(op: DriveOp, root: string): Promise<boolean> {
    try {
      const s = await load()
      switch (op.kind) {
        case 'renameFolder': {
          if (!folderOf(s, String(op.id))) return true
          const fileId = await ensureFolder(String(op.id))
          if (fileId) await drive.update(fileId, { name: String(op.name) })
          return true
        }
        case 'moveFolder': {
          const to = String(op.addParent)
          if (!folderOf(s, String(op.id)) || (to !== 'root' && !folderOf(s, to))) return true
          await moveTo(await ensureFolder(String(op.id)), to === 'root' ? root : await ensureFolder(to))
          return true
        }
        case 'moveNote': {
          const to = String(op.addParent)
          const noteId = String(op.noteId)
          // No local Drive file id (not uploaded, or a card not received yet): look it up by `kkeujeokId`.
          // A note Drive does not have is put in its folder by its upload.
          const fileId = (await store.readSync(noteId)).info.fileId ?? (await all(kkeujeokIdQuery(noteId), 'id,createdTime'))[0]?.id ?? null
          if (!fileId || (to !== 'root' && !folderOf(s, to))) return true
          await moveTo(fileId, to === 'root' ? root : await ensureFolder(to))
          return true
        }
        case 'trashFolder':
          return await trash(op, root)
        default:
          return true
      }
    } catch (e) {
      if (is404(e)) return true
      throw e
    }
  }

  /**
   * Sends what waits, in order: missing folders first, then the queue. An entry leaves the queue when Drive confirms
   * it (or the target is gone, HTTP 404). The first failure stops the run. False when something is left.
   */
  async function flushNow(): Promise<boolean> {
    try {
      if (!deps.allowed() || !deps.online()) return false
      const root = (await device.read()).rootFolderId
      if (!root) return false
      for (const f of (await load()).folders) if (f.fileId === null) await ensureFolder(f.id)
      for (const op of (await load()).ops) {
        if (!(await send(op, root))) return false
        await mutate((s) => void (s.ops = s.ops.filter((e) => keyOf(e) !== keyOf(op))))
      }
      return true
    } catch {
      return false
    }
  }
  const flush = () => run(flushNow)
  const flushSoon = () => void flush()

  type Change = { folders?: Folder[]; parentId?: string; drive: DriveOp | null; inverse: DriveOp | null }
  async function apply(op: string, rule: (s: State) => Change | RuleError, onOk?: (s: State, r: Change) => void): Promise<FolderResult> {
    let out: FolderResult = {}
    await mutate((s) => {
      const r = rule(s)
      if ('error' in r) return void (out = { error: r.error })
      onOk?.(s, r)
      if (r.drive) enqueue(s.ops, { ...r.drive })
      out = { ...(r.drive?.id !== undefined && { id: String(r.drive.id) }), inverse: r.inverse }
    })
    if (out.id) logOp(op, out.id)
    return out
  }
  const syncFolders = (s: State, r: Change) => {
    for (const f of s.folders) {
      const n = r.folders?.find((x) => x.id === f.id)
      if (n) ((f.name = n.name), (f.parentId = n.parentId))
    }
  }
  const changed = async (p: Promise<FolderResult>) => {
    const r = await p
    flushSoon()
    return r
  }

  const api = {
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    /** What the library shows now, from the device record only. */
    view: async () => viewOf(await load()),
    /** Whether a Drive-only change still waits to be sent. */
    async hasPending() {
      const s = await load()
      return s.ops.length > 0 || s.folders.some((f) => f.fileId === null)
    },
    /** The Drive folder file id a note belongs in; null = the root. A folder not in Drive yet is created first. */
    async parentFileId(noteId: string): Promise<string | null> {
      const s = await load()
      const p = s.noteParents[noteId]
      if (!p || p === 'root') return null
      const f = folderOf(s, p)
      return f ? (f.fileId ?? (await ensureFolder(p))) : null
    },
    /** The note is created in `parentId`: its upload will put it there. Nothing is queued, the note has no Drive file yet. */
    async assignNote(noteId: string, parentId: string) {
      if (parentId === 'root') return
      await mutate((s) => void (folderOf(s, parentId) && (s.noteParents[noteId] = parentId)))
    },
    /** The `kkeujeokId` of the folder the note is in (`root` = top level). */
    async parentIdOf(noteId: string): Promise<string> {
      return (await load()).noteParents[noteId] ?? 'root'
    },
    /** The Drive id of `.trashbin`, created when missing (Story 14.1); null while the root is not known. */
    async trashbinFileId(): Promise<string | null> {
      const root = (await device.read()).rootFolderId
      return root ? ensureItem('trashbin', '.trashbin', root) : null
    },
    /** How many notes another device deleted although this one had unsent changes, revived since the last call (the notice). */
    async takeRevived(): Promise<number> {
      let n = 0
      await device.update((d) => {
        const v = d.extra.revivedCount
        n = typeof v === 'number' ? v : 0
        return n === 0 ? d : { ...d, extra: { ...d.extra, revivedCount: 0 } }
      })
      return n
    },
    /** A deleted note's device copy is gone: its parent entry and any queued change of it are dropped. */
    forgetNote: (noteId: string) =>
      mutate((s) => {
        delete s.noteParents[noteId]
        s.ops = s.ops.filter((o) => !(o.kind === 'moveNote' && o.noteId === noteId))
      }),

    createFolder(name: string, parentId: string) {
      const id = makeId()
      return changed(
        run(() =>
          apply(
            'create',
            (s) => libraryCreateFolder({ folders: visible(s), id, name, parentId }),
            (s, r) => void s.folders.push({ id, fileId: null, name: String(r.drive!.name), parentId }),
          ),
        ),
      )
    },
    renameFolder: (id: string, name: string) => changed(run(() => apply('rename', (s) => libraryRenameFolder({ folders: visible(s), id, name }), syncFolders))),
    moveFolder: (id: string, targetParentId: string) => changed(run(() => apply('move', (s) => libraryMoveFolder({ folders: visible(s), id, targetParentId }), syncFolders))),
    /** `noteId` moves to `targetParentId`; the note file is not touched. */
    moveNote: (noteId: string, targetParentId: string) =>
      changed(
        run(() =>
          apply(
            'moveNote',
            (s) => libraryMoveNote({ folders: visible(s), note: { noteId, parentId: s.noteParents[noteId] ?? 'root' }, targetParentId }),
            (s, r) => void (s.noteParents[noteId] = r.parentId!),
          ),
        ),
      ),
    /** Deletes `id` with everything in it: hidden at once, moved to `.trashbin` when online (`trash.trashFolder`). */
    async deleteFolder(id: string): Promise<FolderResult> {
      const trashedAt = now().toISOString()
      let out: FolderResult = {}
      await run(() =>
        mutate((s) => {
          const f = visible(s).find((x) => x.id === id)
          if (!f) return void (out = { error: 'folderNotFound' })
          enqueue(s.ops, { kind: 'trashFolder', id, trashedAt, from: f.parentId })
          out = { id }
        }),
      )
      if (!out.error) (logOp('delete', id), flushSoon())
      return out
    },
    /** Runs a stored inverse (the `inverse` of an earlier change). */
    undo(inverse: DriveOp): Promise<FolderResult> {
      switch (inverse.op) {
        case 'moveFolder':
          return api.moveFolder(String(inverse.id), String(inverse.targetParentId))
        case 'renameFolder':
          return api.renameFolder(String(inverse.id), String(inverse.name))
        case 'moveNote':
          return api.moveNote(String(inverse.noteId), String(inverse.targetParentId))
        case 'trashFolder':
          return api.deleteFolder(String(inverse.id))
        default:
          return Promise.resolve({ error: 'invalidInput' })
      }
    },
    flush,

    /**
     * Sends what waits, then reads the folders and the note parents from Drive into the cache (spec `library.tree`:
     * cycles repaired, trash hidden). Changes not sent yet are applied over what Drive says. False when offline or a
     * call failed (the cache is kept).
     */
    refresh: (): Promise<boolean> =>
      run(async () => {
        if (!deps.allowed() || !deps.online()) return false
        await flushNow()
        try {
          const root = (await device.read()).rootFolderId
          if (!root) return false
          const folderFiles = await all(FOLDERS_QUERY, 'id,name,parents,appProperties,createdTime')
          const noteFiles = await all(NOTE_FILES_QUERY, 'id,name,parents,appProperties')
          const kid = new Map<string, string>([[root, 'root']])
          for (const f of folderFiles) if (f.appProperties.kkeujeokId) kid.set(f.id, f.appProperties.kkeujeokId)
          const parentOf = (f: { parents: string[] }) => (f.parents[0] === undefined ? 'root' : (kid.get(f.parents[0]) ?? f.parents[0]))
          // The oldest folder of a kkeujeokId stays.
          const byKid = new Map<string, (typeof folderFiles)[number]>()
          const sorted = [...folderFiles].sort((a, b) => (a.createdTime ?? '~').localeCompare(b.createdTime ?? '~') || (a.id < b.id ? -1 : 1))
          for (const f of sorted) {
            const k = f.appProperties.kkeujeokId
            if (k && isLibraryFolderKey(k) && !byKid.has(k)) byKid.set(k, f)
          }
          const noteParentDrive = new Map<string, string>()
          for (const n of noteFiles) if (n.appProperties.kkeujeokId) noteParentDrive.set(n.appProperties.kkeujeokId, parentOf(n))
          const t = libraryTree({
            folders: [...byKid].map(([id, f]) => ({ id, parentId: parentOf(f) })),
            notes: [...noteParentDrive].map(([noteId, parentId]) => ({ noteId, parentId })),
          })
          // The repair write of a cycle: the smallest id goes to the top level.
          for (const r of t.repairs) {
            try {
              await moveTo(byKid.get(r.id)!.id, root)
            } catch (e) {
              if (!(e instanceof DriveError)) throw e // the next refresh repeats it; the tree is drawn repaired anyway
            }
          }
          const local = new Set(await store.listIds())
          const revived = await remoteTrashed(t.hidden.notes, new Set(t.hidden.folders), local, new Map(noteFiles.filter((n) => n.appProperties.kkeujeokId).map((n) => [n.appProperties.kkeujeokId!, n])), byKid, root)
          await mutate((s) => {
            const old = new Map(s.folders.map((f) => [f.id, f]))
            const folders: CacheFolder[] = [
              ...t.folders.map((v) => ({ id: v.id, fileId: byKid.get(v.id)!.id, name: byKid.get(v.id)!.name ?? '', parentId: v.parentId })),
              // created on this browser, not in Drive yet
              ...s.folders.filter((f) => f.fileId === null && !byKid.has(f.id)),
            ]
            const notes: Record<string, string> = Object.fromEntries(t.notes.map((n) => [n.noteId, n.folderId ?? 'root']))
            for (const n of t.hidden.notes) notes[n] = revived.get(n) ?? 'trashbin'
            // a note Drive does not have yet keeps its parent
            for (const [id, p] of Object.entries(s.noteParents)) if (local.has(id) && !noteParentDrive.has(id)) notes[id] = p
            // Drive-only changes not sent yet win over what Drive says.
            for (const o of s.ops) {
              if (o.kind === 'renameFolder') folders.filter((f) => f.id === o.id).forEach((f) => (f.name = String(o.name)))
              else if (o.kind === 'moveFolder') folders.filter((f) => f.id === o.id).forEach((f) => (f.parentId = String(o.addParent)))
              else if (o.kind === 'moveNote') {
                if (String(o.noteId) in notes || local.has(String(o.noteId))) notes[String(o.noteId)] = String(o.addParent)
              } else if (o.kind === 'trashFolder' && !folders.some((f) => f.id === o.id) && old.has(String(o.id))) {
                folders.push(old.get(String(o.id))!) // still in Drive's tree: kept for the move
              }
            }
            for (const f of folders) {
              const o = old.get(f.id)
              if (!o || o.name !== f.name || o.parentId !== f.parentId) logOp('remote', f.id)
            }
            s.folders = folders
            s.noteParents = notes
          })
          return true
        } catch (e) {
          if (e instanceof DriveError) return false
          throw e
        }
      }),
  }
  return api
}
