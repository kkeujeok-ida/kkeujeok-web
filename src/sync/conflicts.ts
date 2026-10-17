// Conflict records of one note (Story 3.20): how the entries a merge raised are put into
// `sync.json` (`conflicts`, `unsentSidecars`) and which sidecar records go to / leave the
// sidecar store. Pure; the state of the note is not touched here (callers give the event).
import type { JsonMap, SyncInfo } from '../storage/syncInfo'
import type { Conflict, Sidecar } from './merge'

export type SidecarRef = { pageId: string; rev: string }
/** What one `recordInto` added: a retry of the same merge removes exactly this first. */
export type Recorded = { conflicts: SidecarRef[]; sidecars: SidecarRef[] }
export const noRecorded = (): Recorded => ({ conflicts: [], sidecars: [] })

export const sidecarKey = (s: SidecarRef) => `${s.pageId}:${s.rev}`
/** The entries nobody has resolved yet. */
export const unresolvedOf = (i: Pick<SyncInfo, 'conflicts'>): JsonMap[] => i.conflicts.filter((c) => c.resolvedAt == null)

const same = (a: SidecarRef, b: JsonMap) => a.pageId === b.pageId && a.rev === b.rev

export type RecordResult = {
  info: SyncInfo
  /** Sidecar records to put into the store. */
  store: Sidecar[]
  /** Sidecar records to delete from the store (superseded, not uploaded yet). */
  drop: SidecarRef[]
  added: Recorded
}

/**
 * Puts the conflicts of a merge into `info`.
 * - `supersedes` (what an earlier try of the same merge call recorded) is removed first.
 * - A page that already has an unresolved entry keeps it: only `kind` and `theirsRev` follow the
 *   new detection and the new sidecar is not stored (its page came from Drive; the entry's `rev`
 *   is the device version that must be kept).
 * - Any other conflict is appended, its sidecar is stored and listed in `unsentSidecars`.
 */
export function recordInto(
  info: SyncInfo,
  add: { conflicts: readonly Conflict[]; sidecars: readonly Sidecar[] },
  supersedes: Recorded = noRecorded(),
): RecordResult {
  const conflicts = info.conflicts.filter((c) => !(c.resolvedAt == null && supersedes.conflicts.some((s) => same(s, c))))
  const gone = info.unsentSidecars.filter((u) => supersedes.sidecars.some((s) => same(s, u)))
  const unsent = info.unsentSidecars.filter((u) => !gone.includes(u))
  const store: Sidecar[] = []
  const added = noRecorded()
  for (const e of add.conflicts) {
    const at = conflicts.findIndex((c) => c.pageId === e.pageId && c.resolvedAt == null)
    if (at >= 0) {
      conflicts[at] = { ...conflicts[at]!, kind: e.kind, theirsRev: e.theirsRev }
      continue
    }
    conflicts.push({ ...e })
    added.conflicts.push({ pageId: e.pageId, rev: e.rev })
    const s = add.sidecars.find((x) => x.pageId === e.pageId && x.rev === e.rev)
    if (!s) continue
    store.push(s)
    added.sidecars.push({ pageId: s.pageId, rev: s.rev })
    if (!unsent.some((u) => same(s, u))) unsent.push({ pageId: s.pageId, rev: s.rev })
  }
  return {
    info: { ...info, conflicts, unsentSidecars: unsent },
    store,
    drop: gone.map((g) => ({ pageId: String(g.pageId), rev: String(g.rev) })),
    added,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Fields of one `conflictFound` log entry: the sidecar `rev` when it is a UUID (the log never holds anything else). */
export const conflictLogFields = (noteId: string, rev: string) => ({ noteId, ...(UUID.test(rev) && { rev }) })
