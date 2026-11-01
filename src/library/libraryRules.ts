// Spec `library` (folders, tree, moveNote) and `trash` (trashNote, trashFolder): pure rules,
// output equal to the fixture JSON. Operations never change their input.
import { driveFileNameRule } from '../drive/noteSummary'
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
