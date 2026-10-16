// Spec merge.resolve: settles one conflict. Pure, no undo record (the one edit
// with no inverse). Inputs are deep-copied; unknown fields travel with pages.
import { v5 } from 'uuid'
import type { Note, Page } from '../model/note'
import type { Conflict, MergeCtx, Sidecar } from '../sync/merge'

export const PAGE_ID_NAMESPACE = 'b3a1f1a0-6f0e-4d57-9a53-5c1d2e7f9a10'
export type ResolveErrorCode = 'alreadyResolved' | 'invalidChoice' | 'pageNotFound' | 'identicalVersions'
export type ResolveResult =
  | { result: 'resolved'; note: Note; conflict: Conflict; undoDrop: string[] }
  | { error: ResolveErrorCode; result?: undefined }

const CHOICES: Record<string, readonly string[]> = {
  bothEdited: ['mine', 'theirs', 'both'],
  localDeleted: ['remove', 'keep'],
  remoteDeleted: ['remove', 'keep'],
}
const lineageOf = (p: Page): string[] => (Array.isArray(p.lineage) ? (p.lineage as string[]) : [])

export function resolveConflict(
  note0: Note,
  conflict0: Conflict,
  sidecar0: Sidecar,
  choice: unknown,
  ctx0: MergeCtx,
): ResolveResult {
  const note = structuredClone(note0)
  const conflict = structuredClone(conflict0)
  const side = structuredClone(sidecar0.page)
  const ctx = structuredClone(ctx0)
  const pageId = conflict.pageId

  if (conflict.resolvedAt !== null) return { error: 'alreadyResolved' }
  const set = CHOICES[conflict.kind]
  if (typeof choice !== 'string' || !set || !set.includes(choice)) return { error: 'invalidChoice' }
  const idx = note.pages.findIndex((p) => p.id === pageId)
  const cur: Page | undefined = note.pages[idx]
  if (!cur && conflict.kind !== 'remoteDeleted') return { error: 'pageNotFound' }
  if (choice === 'both' && cur && cur.rev === sidecar0.rev) return { error: 'identicalVersions' }

  const basis = cur ?? side
  const fresh = (s: Page): Page => ({
    ...s,
    id: pageId,
    rev: ctx.rev,
    seq: Math.max(basis.seq, ctx.lastSeenRemoteSeq) + 1,
    editedAt: ctx.now,
    editedBy: ctx.editedBy,
    lineage: [basis.rev, ...lineageOf(basis)].slice(0, 16),
  })
  const renewOrder = () => {
    note.orderRev = ctx.orderRev
    note.orderSeq = Math.max(note.orderSeq, ctx.lastSeenRemoteSeq) + 1
  }
  let undoDrop = [pageId]

  if (conflict.kind === 'bothEdited') {
    if (choice === 'mine') note.pages[idx] = fresh(side)
    else if (choice === 'theirs') note.pages[idx] = fresh(cur!)
    else {
      const hi = cur!.rev > side.rev ? cur! : side
      const newId = v5(`${pageId}:${(hi === cur ? side : cur!).rev}`, PAGE_ID_NAMESPACE)
      const mine = hi === side ? side : { ...side, id: newId }
      const theirs = hi === cur ? cur! : { ...cur!, id: newId }
      note.pages.splice(idx, 1)
      const k = Math.min(conflict.originalIndex, note.pages.length)
      const have = new Set(note.pages.map((p) => p.id))
      note.pages.splice(k, 0, ...[mine, theirs].filter((p) => !have.has(p.id)))
      renewOrder()
      undoDrop = [pageId, newId]
    }
  } else if (conflict.kind === 'localDeleted') {
    if (choice === 'remove') {
      note.pages.splice(idx, 1)
      renewOrder()
    } else note.pages[idx] = fresh(cur!)
  } else if (choice === 'keep' && !cur) {
    note.pages.splice(Math.min(conflict.originalIndex, note.pages.length), 0, fresh(side))
    renewOrder()
  }

  return { result: 'resolved', note, conflict: { ...conflict, resolvedAt: ctx.now }, undoDrop }
}
