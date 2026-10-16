// Applies a sync result to the note through the same serial path as an edit
// (AD-16): the merge runs synchronously against the history's note at that
// moment, so a stroke drawn while the network ran is merged, never overwritten.
import type { History } from '../ops/history'
import { type MergeCtx, type RequeueResult, mergeRequeue } from './merge'
import type { Note } from '../model/note'

/**
 * `localAtStart` is the note the sync started from. On `merged` the history
 * adopts the result and drops the undo records of `undoDrop`; the caller
 * saves `history.note`, stores the sidecars and `lastSeenRemoteSeq`, and merges
 * `requeue` again. On `unsupportedVersion` or an error the note is untouched.
 */
export function commitMerge(
  history: History,
  a: { base: Note | null; localAtStart: Note; remote: Note; ctx: MergeCtx },
): RequeueResult {
  const r = mergeRequeue({ base: a.base, localAtStart: a.localAtStart, localAtCommit: history.note, remote: a.remote, ctx: a.ctx })
  if (r.result === 'merged') history.applyMerged(r.note, r.undoDrop)
  return r
}
