// Spec ops.restoreNote / ops.restorePage: a restore is a new edit of the note, not an operation of the undo
// history (no inverse, `applyOp` answers unknownOp). Pure: inputs are deep-copied, none is changed, malformed
// input is `{error: 'invalidInput'}`, never a throw. Mirrors kkeujeok-client/lib/ops/restore.dart.
import type { Note, Page } from '../model/note'

type Json = Record<string, unknown>
export type RestoreCtx = { now: string; orderRev: string; editedBy: string; lastSeenRemoteSeq: number } & (
  | { revs: string[]; rev?: undefined }
  | { rev: string; revs?: undefined }
)
export type RestoreOk = { note: Note; inverse: null; undoDrop: string[]; conflicts: Json[] }
export type RestoreErrorCode = 'noteIdMismatch' | 'duplicatePageId' | 'pageIdMismatch' | 'invalidInput'
export type RestoreResult = RestoreOk | { error: RestoreErrorCode }

const BAD = { error: 'invalidInput' } as const
const LINEAGE_MAX = 16
const seqOf = (v: unknown) => (typeof v === 'number' ? Math.trunc(v) : 0)
const lineageOf = (p: Json): string[] => (Array.isArray(p.lineage) ? (p.lineage as string[]) : [])
const lineageFor = (basis: Json) => [basis.rev as string, ...lineageOf(basis)].slice(0, LINEAGE_MAX)

/** Every unresolved conflict that `pick` takes is resolved at `now`; the others are as they were. */
const resolveAll = (conflicts: Json[], now: unknown, pick: (c: Json) => boolean): Json[] =>
  conflicts.map((c) => (c.resolvedAt == null && pick(c) ? { ...c, resolvedAt: now } : c))

const safe = (run: () => RestoreResult): RestoreResult => {
  try {
    return run()
  } catch {
    return BAD
  }
}

export function restoreNote(note0: Note, op0: { op: 'restoreNote'; version: Note }, ctx0: RestoreCtx, conflicts0: Json[]): RestoreResult {
  return safe(() => {
    const note = structuredClone(note0) as Note
    const version = structuredClone(op0.version) as Note
    const ctx = structuredClone(ctx0) as RestoreCtx
    const conflicts = structuredClone(conflicts0)
    if (version.noteId !== note.noteId) return { error: 'noteIdMismatch' }
    const vpages = version.pages as Page[]
    const revs = ctx.revs
    if (!Array.isArray(vpages) || !Array.isArray(revs) || vpages.some((p) => typeof p.id !== 'string' || typeof p.rev !== 'string') || revs.length < vpages.length) return BAD
    const vids = vpages.map((p) => p.id)
    if (new Set(vids).size !== vids.length) return { error: 'duplicatePageId' }
    const cur = new Map(note.pages.map((p) => [p.id, p]))
    const lastSeen = seqOf(ctx.lastSeenRemoteSeq)
    note.pages = vpages.map((v, i) => {
      const c = cur.get(v.id)
      return {
        ...v,
        rev: revs[i]!,
        seq: Math.max(c ? seqOf(c.seq) : 0, seqOf(v.seq), lastSeen) + 1,
        editedAt: ctx.now,
        editedBy: ctx.editedBy,
        lineage: lineageFor(c ?? v),
      }
    })
    note.orderRev = ctx.orderRev
    note.orderSeq = Math.max(seqOf(note.orderSeq), lastSeen) + 1
    return {
      note,
      inverse: null,
      undoDrop: [...note0.pages.map((p) => p.id), ...vids.filter((id) => !cur.has(id))],
      conflicts: resolveAll(conflicts, ctx.now, () => true),
    }
  })
}

export function restorePage(
  note0: Note,
  op0: { op: 'restorePage'; pageId: string; page: Page; originalIndex: number },
  ctx0: RestoreCtx,
  conflicts0: Json[],
): RestoreResult {
  return safe(() => {
    const note = structuredClone(note0) as Note
    const page = structuredClone(op0.page) as Page
    const pageId = op0.pageId
    const ctx = structuredClone(ctx0) as RestoreCtx
    const conflicts = structuredClone(conflicts0)
    if (typeof pageId !== 'string' || typeof page.rev !== 'string' || !Number.isInteger(op0.originalIndex) || typeof ctx.rev !== 'string') return BAD
    if (page.id !== pageId) return { error: 'pageIdMismatch' }
    const idx = note.pages.findIndex((p) => p.id === pageId)
    const cur = note.pages[idx]
    const lastSeen = seqOf(ctx.lastSeenRemoteSeq)
    const restored: Page = {
      ...page,
      id: pageId,
      rev: ctx.rev,
      seq: Math.max(cur ? seqOf(cur.seq) : 0, seqOf(page.seq), lastSeen) + 1,
      editedAt: ctx.now,
      editedBy: ctx.editedBy,
      lineage: lineageFor(cur ?? page),
    }
    if (cur) note.pages[idx] = restored
    else {
      note.pages.splice(Math.min(Math.max(op0.originalIndex, 0), note.pages.length), 0, restored)
      note.orderRev = ctx.orderRev
      note.orderSeq = Math.max(seqOf(note.orderSeq), lastSeen) + 1
    }
    return { note, inverse: null, undoDrop: [pageId], conflicts: resolveAll(conflicts, ctx.now, (c) => c.pageId === pageId) }
  })
}
