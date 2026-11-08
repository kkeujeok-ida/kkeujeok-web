// Spec `library` (folders, tree, moveNote) and `trash` (trashNote, trashFolder): pure rules,
// output equal to the fixture JSON. Operations never change their input.
import { MAX_COVER_BYTES, driveFileNameRule } from '../drive/noteSummary'
import type { Note } from '../model/note'
import { MAX_TITLE_LENGTH, normalizeTitle, trimTitle } from '../model/noteTitle'

export type Folder = { id: string; name: string; parentId: string }
export type DriveOp = Record<string, unknown>
export type RuleError = { error: string }
export type FolderChange = { folders: Folder[]; drive: DriveOp | null; inverse: DriveOp | null }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const hasParent = (folders: { id: string }[], id: string) => id === 'root' || folders.some((f) => f.id === id)

export function libraryFolderName({ name }: { name: string }): { ok: true; name: string } | { ok: false; reason: 'emptyName' | 'nameTooLong' } {
  const t = trimTitle(name)
  if (t === '') return { ok: false, reason: 'emptyName' }
  if ([...t].length > MAX_TITLE_LENGTH) return { ok: false, reason: 'nameTooLong' }
  return { ok: true, name: t }
}

/** `library.renameNote`: the note's title, `metaRev` and `metaSeq` renewed (spec library "renameNote"); `name` is the Drive file name. */
export function libraryRenameNote(i: { note: Note; op: { title: string }; existingTitles: string[]; ctx: { rev: string; lastSeenRemoteSeq: number } }) {
  const title = normalizeTitle(i.op.title, i.existingTitles)
  if (title === null) return { error: 'titleTooLong' } as RuleError
  const name = (driveFileNameRule({ title }) as { name: string }).name
  if (title === i.note.meta.title) return { note: i.note, inverse: null, name }
  return {
    note: { ...i.note, meta: { ...i.note.meta, title }, metaRev: i.ctx.rev, metaSeq: Math.max(i.note.metaSeq, i.ctx.lastSeenRemoteSeq) + 1 },
    inverse: { op: 'renameNote', title: i.note.meta.title },
    name,
  }
}

/** `library.setCover`: `meta.coverId` set or removed (never written as null); `metaRev` and `metaSeq` renewed. */
export function librarySetCover(i: { note: Note; op: { coverId: string | null }; ctx: { rev: string; lastSeenRemoteSeq: number } }) {
  const id = i.op.coverId
  if (id !== null && (typeof id !== 'string' || id === '' || new TextEncoder().encode(id).length > MAX_COVER_BYTES)) return { error: 'invalidCoverId' } as RuleError
  const old = typeof i.note.meta.coverId === 'string' ? i.note.meta.coverId : null
  if (id === old) return { note: i.note, inverse: null }
  const { coverId: _drop, ...rest } = i.note.meta
  return {
    note: { ...i.note, meta: id === null ? rest : { ...rest, coverId: id }, metaRev: i.ctx.rev, metaSeq: Math.max(i.note.metaSeq, i.ctx.lastSeenRemoteSeq) + 1 },
    inverse: { op: 'setCover', coverId: old },
  }
}

export type CoverEntry = { id: string; name: { ko: string; en: string }; file: string }
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''
/** The valid entries of a cover index, in order; first entry wins for a shared id. */
export function libraryCoverEntries(index: unknown): CoverEntry[] {
  const ix = index as { version?: unknown; covers?: unknown } | null
  if (typeof ix !== 'object' || ix === null || ix.version !== 1 || !Array.isArray(ix.covers)) return []
  const out: CoverEntry[] = []
  for (const e of ix.covers as Record<string, any>[]) {
    if (typeof e !== 'object' || e === null) continue
    if (typeof e.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(e.id) || out.some((o) => o.id === e.id)) continue
    if (!nonEmpty(e.name?.ko) || !nonEmpty(e.name?.en) || typeof e.file !== 'string' || !/^[a-z0-9][a-z0-9-]*\.svg$/.test(e.file)) continue
    out.push({ id: e.id, name: { ko: e.name.ko, en: e.name.en }, file: e.file })
  }
  return out
}

export function libraryCoverResolve(i: { coverId?: unknown; index: unknown }): { kind: 'none' } | { kind: 'cover'; id: string; file: string } {
  const e = typeof i.coverId === 'string' ? libraryCoverEntries(i.index).find((c) => c.id === i.coverId) : undefined
  return e ? { kind: 'cover', id: e.id, file: e.file } : { kind: 'none' }
}

export function libraryMoveNote(i: { folders: Folder[]; note: { noteId: string; parentId: string }; targetParentId: string }) {
  const { note, targetParentId } = i
  if (!hasParent(i.folders, targetParentId)) return { error: 'folderNotFound' } as RuleError
  if (targetParentId === note.parentId) return { parentId: note.parentId, drive: null, inverse: null }
  return {
    parentId: targetParentId,
    drive: { kind: 'moveNote', noteId: note.noteId, addParent: targetParentId, removeParent: note.parentId },
    inverse: { op: 'moveNote', noteId: note.noteId, targetParentId: note.parentId },
  }
}

export function libraryCreateFolder(i: { folders: Folder[]; id: string; name: string; parentId: string }): FolderChange | RuleError {
  const n = libraryFolderName(i)
  if (!n.ok) return { error: n.reason }
  if (!hasParent(i.folders, i.parentId)) return { error: 'parentNotFound' }
  return {
    folders: [...i.folders.map((f) => ({ ...f })), { id: i.id, name: n.name, parentId: i.parentId }],
    drive: { kind: 'createFolder', id: i.id, name: n.name, parentId: i.parentId },
    inverse: { op: 'trashFolder', id: i.id },
  }
}

export function libraryRenameFolder(i: { folders: Folder[]; id: string; name: string }): FolderChange | RuleError {
  const f = i.folders.find((x) => x.id === i.id)
  if (!f) return { error: 'folderNotFound' }
  const n = libraryFolderName(i)
  if (!n.ok) return { error: n.reason }
  if (n.name === f.name) return { folders: i.folders.map((x) => ({ ...x })), drive: null, inverse: null }
  return {
    folders: i.folders.map((x) => (x.id === i.id ? { ...x, name: n.name } : { ...x })),
    drive: { kind: 'renameFolder', id: i.id, name: n.name },
    inverse: { op: 'renameFolder', id: i.id, name: f.name },
  }
}

export function libraryMoveFolder(i: { folders: Folder[]; id: string; targetParentId: string }): FolderChange | RuleError {
  const { folders, id, targetParentId } = i
  const f = folders.find((x) => x.id === id)
  if (!f) return { error: 'folderNotFound' }
  if (!hasParent(folders, targetParentId)) return { error: 'parentNotFound' }
  if (targetParentId === id) return { error: 'moveIntoSelf' }
  for (let p = targetParentId, guard = 0; p !== 'root' && guard <= folders.length; guard++) {
    if (p === id) return { error: 'moveIntoDescendant' }
    const pf = folders.find((x) => x.id === p)
    if (!pf) break
    p = pf.parentId
  }
  if (targetParentId === f.parentId) return { folders: folders.map((x) => ({ ...x })), drive: null, inverse: null }
  return {
    folders: folders.map((x) => (x.id === id ? { ...x, parentId: targetParentId } : { ...x })),
    drive: { kind: 'moveFolder', id, addParent: targetParentId, removeParent: f.parentId },
    inverse: { op: 'moveFolder', id, targetParentId: f.parentId },
  }
}

export type TreeResult = {
  folders: { id: string; parentId: string }[]
  notes: { noteId: string; folderId: string | null }[]
  hidden: { folders: string[]; notes: string[] }
  repairs: { id: string; parentId: 'root' }[]
}

/** What the library shows: cycles repaired, trash hidden, a missing parent drawn at the top level. */
export function libraryTree(i: { folders: { id: string; parentId: string }[]; notes: { noteId: string; parentId: string }[] }): TreeResult {
  const byId = new Map(i.folders.map((f) => [f.id, f]))
  const done = new Set<string>()
  const repairIds = new Set<string>()
  for (const f of i.folders) {
    if (done.has(f.id)) continue
    const path: string[] = []
    const at = new Map<string, number>()
    let cur: { id: string; parentId: string } | undefined = f
    while (cur && !done.has(cur.id) && !at.has(cur.id)) {
      at.set(cur.id, path.length)
      path.push(cur.id)
      cur = byId.get(cur.parentId)
    }
    if (cur && at.has(cur.id)) repairIds.add(path.slice(at.get(cur.id)).sort(cmp)[0]!)
    path.forEach((x) => done.add(x))
  }
  const orphan = (f: { parentId: string }) => f.parentId !== 'root' && f.parentId !== 'trashbin' && !byId.has(f.parentId)
  const effParent = (f: { id: string; parentId: string }) => (repairIds.has(f.id) || orphan(f) ? 'root' : f.parentId)
  const memo = new Map<string, boolean>()
  const isHidden = (f: { id: string; parentId: string }): boolean => {
    const m = memo.get(f.id)
    if (m !== undefined) return m
    const p = effParent(f)
    const h = p === 'trashbin' ? true : p === 'root' ? false : isHidden(byId.get(p)!)
    memo.set(f.id, h)
    return h
  }
  const out: TreeResult = { folders: [], notes: [], hidden: { folders: [], notes: [] }, repairs: [] }
  for (const f of i.folders) {
    if (isHidden(f)) out.hidden.folders.push(f.id)
    else out.folders.push({ id: f.id, parentId: effParent(f) })
  }
  for (const n of i.notes) {
    const parent = byId.get(n.parentId)
    if (n.parentId === 'root') out.notes.push({ noteId: n.noteId, folderId: null })
    else if (n.parentId === 'trashbin') out.hidden.notes.push(n.noteId)
    else if (!parent) out.notes.push({ noteId: n.noteId, folderId: null })
    else if (isHidden(parent)) out.hidden.notes.push(n.noteId)
    else out.notes.push({ noteId: n.noteId, folderId: n.parentId })
  }
  out.repairs = [...repairIds].sort(cmp).map((id) => ({ id, parentId: 'root' as const }))
  return out
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type TrashInput = {
  /** `noteId` of a note in the fixture of `trashNote`. */
  id?: string
  noteId?: string
  fileId: string
  parentId: string
  parentFileId: string
  trashbinFileId: string
  now: string
  unsent: boolean
  online: boolean
  pending: { trashedAt: string; from: string | null } | null
}
export type TrashResult = {
  already: boolean
  pending: { trashedAt: string; from: string } | null
  steps: string[]
  request: { fileId: string; addParents: string; removeParents: string; appProperties: { trashedFrom: string; trashedAt: string } } | null
}

function trash(i: TrashInput, folder: boolean): TrashResult | RuleError {
  if (folder && !UUID.test(i.id ?? '')) return { error: 'notUserFolder' }
  if (i.parentId === 'trashbin') return { already: true, pending: null, steps: [], request: null }
  const trashedAt = i.pending ? i.pending.trashedAt : i.now
  const from = i.pending && i.pending.from !== null ? i.pending.from : i.parentId
  const pending = { trashedAt, from }
  if (!i.online) return { already: false, pending, steps: [], request: null }
  return {
    already: false,
    pending,
    steps: [...(i.unsent ? ['upload'] : []), 'move', 'removeLocal'],
    request: { fileId: i.fileId, addParents: i.trashbinFileId, removeParents: i.parentFileId, appProperties: { trashedFrom: from, trashedAt } },
  }
}
export const trashNoteRule = (i: TrashInput) => trash(i, false)
export const trashFolderRule = (i: TrashInput) => trash(i, true)

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const NOTE_MIME = 'application/vnd.kkeujeok.kkj'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export type RestoreInput = {
  item: { id?: string; fileId: string; parentFileId: string; parentId: string; trashed: boolean; appProperties?: Record<string, string> }
  trashbinFileId: string
  rootFileId: string
  origin: { fileId: string; inTrash: boolean } | null
}
export type RestoreResult =
  | { gone: true }
  | { already: true }
  | { destination: 'origin' | 'root'; rootFallback: boolean; request: { fileId: string; addParents: string; removeParents: string; appProperties: { trashedFrom: null; trashedAt: null } } }

/** `trash.restoreNote` and `trash.restoreFolder` (one rule). */
export function trashRestoreRule(i: RestoreInput): RestoreResult {
  const { item } = i
  if (item.trashed) return { gone: true }
  if (item.parentId !== 'trashbin') return { already: true }
  const tf = item.appProperties?.trashedFrom
  const from = typeof tf === 'string' && tf !== '' ? tf : 'root'
  let destination: 'origin' | 'root' = 'root'
  let rootFallback = false
  if (from === 'root') {
    // origin was the top level
  } else if (from !== 'trashbin' && i.origin && !i.origin.inTrash) destination = 'origin'
  else rootFallback = true
  return {
    destination,
    rootFallback,
    request: {
      fileId: item.fileId,
      addParents: destination === 'origin' ? i.origin!.fileId : i.rootFileId,
      removeParents: item.parentFileId,
      appProperties: { trashedFrom: null, trashedAt: null },
    },
  }
}

/** `trash.purgeItem`: `trashed=true`, never `files.delete`. */
export function trashPurgeRule({ item }: { item: { fileId: string; parentId: string; trashed: boolean } }): { request: { fileId: string; trashed: true } } | { already: true } | RuleError {
  if (item.trashed) return { already: true }
  if (item.parentId !== 'trashbin') return { error: 'notInTrash' }
  return { request: { fileId: item.fileId, trashed: true } }
}

/** `trash.emptyTrash` */
export function trashEmptyRule({ items, failed }: { items: { id: string; fileId: string; trashed: boolean }[]; failed: string[] }) {
  const requests: { id: string; fileId: string; trashed: true }[] = []
  const remaining: string[] = []
  const done: string[] = []
  for (const it of items) {
    if (!it.trashed) requests.push({ id: it.id, fileId: it.fileId, trashed: true })
    if (!it.trashed && failed.includes(it.id)) remaining.push(it.id)
    else done.push(it.id)
  }
  return { requests, remaining, done }
}

export type TrashListEntry = { kind: 'note' | 'folder'; id: string; fileId: string; trashedAt: string; trashedFrom: string | null; noteCount?: number }

/** `trash.list` */
export function trashListRule({ items, noteCounts }: { items: { id: string; mimeType?: string; modifiedTime?: string; appProperties?: Record<string, string> }[]; noteCounts: Record<string, number> }): { entries: TrashListEntry[] } {
  const out: TrashListEntry[] = []
  for (const f of items) {
    const p = f.appProperties ?? {}
    const kid = p.kkeujeokId
    if (typeof kid !== 'string' || kid === '') continue
    const kind = f.mimeType === NOTE_MIME ? 'note' : f.mimeType === FOLDER_MIME ? 'folder' : null
    if (!kind) continue
    const e: TrashListEntry = {
      kind,
      id: kid,
      fileId: f.id,
      trashedAt: typeof p.trashedAt === 'string' && TS.test(p.trashedAt) ? p.trashedAt : f.modifiedTime!,
      trashedFrom: typeof p.trashedFrom === 'string' && p.trashedFrom !== '' ? p.trashedFrom : null,
    }
    if (kind === 'folder') e.noteCount = noteCounts[kid] || 0
    out.push(e)
  }
  out.sort((a, b) => cmp(b.trashedAt, a.trashedAt) || cmp(a.id, b.id))
  return { entries: out }
}

const ACCESS: Record<string, string[]> = {
  library: ['edit', 'metaChange', 'upload', 'download'],
  pendingTrash: ['upload', 'download', 'restore'],
  trashed: ['download', 'restore', 'purge'],
}
const ACTIONS = ['edit', 'metaChange', 'upload', 'download', 'restore', 'purge']
/** `trash.access` */
export function trashAccessRule({ state, action }: { state: string; action: string }): { allowed: boolean } | RuleError {
  if (!Object.hasOwn(ACCESS, state) || !ACTIONS.includes(action)) return { error: 'invalidInput' }
  return { allowed: ACCESS[state]!.includes(action) }
}

/** `trash.remoteTrashed` */
export function trashRemoteRule({ unsent, open, pending }: { unsent: boolean; open: boolean; pending: boolean }) {
  if (pending) return { local: 'remove', restore: false, banner: false, notify: false }
  if (unsent) return { local: 'keep', restore: true, banner: false, notify: true }
  return { local: 'remove', restore: false, banner: open, notify: false }
}

/** `library.normalize` key: NFC, then each code point lower-cased on its own (no final-sigma context). */
export const libraryKey = (text: string): string => [...text.normalize('NFC')].map((c) => c.toLowerCase()).join('')
export const libraryNormalize = (i: { text: string }) => ({ key: libraryKey(i.text) })

const inRanges = (c: number, r: number[]) => r.some((lo, k) => k % 2 === 0 && c >= lo && c <= r[k + 1]!)
const SYMBOLS = [0, 0x2f, 0x3a, 0x40, 0x5b, 0x60, 0x7b, 0xbf, 0x2000, 0x206f, 0x3000, 0x303f]
const HANGUL = [0x1100, 0x11ff, 0x3130, 0x318f, 0xa960, 0xa97f, 0xac00, 0xd7ff]
const charClass = (c: number) =>
  c >= 0x30 && c <= 0x39 ? 1 : inRanges(c, SYMBOLS) ? 0 : inRanges(c, [0x61, 0x7a, 0xc0, 0x24f]) ? 2 : inRanges(c, HANGUL) ? 3 : 4

/** Token by token: digit runs by value, other code points by class then code point; a prefix comes first. */
function keyCompare(a: string, b: string): number {
  const x = [...a].map((s) => s.codePointAt(0)!)
  const y = [...b].map((s) => s.codePointAt(0)!)
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    const ca = charClass(x[i]!)
    const cb = charClass(y[j]!)
    if (ca !== cb) return ca - cb
    if (ca === 1) {
      let ie = i
      let je = j
      while (ie < x.length && charClass(x[ie]!) === 1) ie++
      while (je < y.length && charClass(y[je]!) === 1) je++
      const da = String.fromCodePoint(...x.slice(i, ie)).replace(/^0+/, '')
      const db = String.fromCodePoint(...y.slice(j, je)).replace(/^0+/, '')
      if (da.length !== db.length) return da.length - db.length
      const c = cmp(da, db)
      if (c) return c
      i = ie
      j = je
    } else {
      if (x[i] !== y[j]) return x[i]! - y[j]!
      i++
      j++
    }
  }
  return x.length - i - (y.length - j)
}

/** Name order of two notes (`library.sort`); `desc` reverses only the key comparison. */
export function libraryNameCompare(a: { noteId: string; title: string }, b: { noteId: string; title: string }, desc = false): number {
  const k = keyCompare(libraryKey(a.title), libraryKey(b.title))
  return k ? (desc ? -k : k) : cmp(a.title, b.title) || cmp(a.noteId, b.noteId)
}

type SortInput = { by: string; items: { noteId: string; title: string; editedAt: string | null }[] }
/** `library.sort` */
export function librarySort({ by, items }: SortInput): { noteIds: string[] } {
  const created = (id: string) => {
    const h = id.replaceAll('-', '').slice(0, 12)
    return /^[0-9a-fA-F]{12}$/.test(h) ? parseInt(h, 16) : null
  }
  const desc = by.endsWith('Desc')
  const dated = <T extends string | number>(a: T | null, b: T | null) => (a === null || b === null ? (a === b ? 0 : a === null ? 1 : -1) : desc ? (b < a ? -1 : b > a ? 1 : 0) : a < b ? -1 : a > b ? 1 : 0)
  const c = (a: SortInput['items'][number], b: SortInput['items'][number]) =>
    by.startsWith('name') ? libraryNameCompare(a, b, desc)
    : (by.startsWith('edited') ? dated(a.editedAt, b.editedAt) : dated(created(a.noteId), created(b.noteId))) || cmp(a.noteId, b.noteId)
  return { noteIds: [...items].sort(c).map((i) => i.noteId) }
}

/** `library.search`: titles whose key contains the key of the trimmed query, in input order. */
export function librarySearch({ query, titles }: { query: string; titles: { noteId: string; title: string }[] }): { noteIds: string[] } {
  const q = libraryKey(trimTitle(query))
  return { noteIds: titles.filter((t) => libraryKey(t.title).includes(q)).map((t) => t.noteId) }
}

/**
 * Multi-select (Story 23.10): what a bulk move or delete acts on. Only folders and notes that still exist;
 * a folder below another selected folder, and a note inside a selected folder, go along with that folder.
 */
export function librarySelection(i: {
  folders: { id: string; parentId: string }[]
  selectedFolders: Iterable<string>
  selectedNotes: Iterable<string>
  noteFolder: Readonly<Record<string, string | null>>
}): { folderIds: string[]; noteIds: string[] } {
  const parent = new Map(i.folders.map((f) => [f.id, f.parentId]))
  const inside = (id: string | null | undefined, anc: string) => {
    for (let n = 0, p = id; p != null && p !== 'root' && n <= parent.size; n++, p = parent.get(p)) if (p === anc) return true
    return false
  }
  const live = [...i.selectedFolders].filter((id) => parent.has(id))
  return {
    folderIds: live.filter((id) => !live.some((o) => o !== id && inside(id, o))),
    noteIds: [...i.selectedNotes].filter((id) => id in i.noteFolder && !live.some((f) => inside(i.noteFolder[id], f))),
  }
}
