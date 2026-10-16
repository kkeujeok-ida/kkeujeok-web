// The merge the uploader (Story 3.12) runs in sync.md step 1 (pre-merge) and
// step 3 (verify: each foreign revision). `remote` is what decodeKkj returned
// for the downloaded head; when the head equals the base, pass the base copy
// as `remote` (the merge still writes the lineage). `localAtStart` is given
// when the queue may have moved since the sync began (merge.requeue).
import type { Note, NoteReadResult } from '../model/note'
import { type MergeCtx, type MergeErrorCode, type MergeOk, type Requeue, merge, mergeRequeue } from './merge'

export type MergeStepResult =
  | (MergeOk & { requeue?: Requeue })
  | { result: 'unsupportedVersion' } // no merge, no write, no upload: note goes to error
  | { error: MergeErrorCode | 'parse'; result?: undefined }

export function mergeStep(a: {
  base: Note | null
  local: Note
  remote: NoteReadResult
  ctx: MergeCtx
  localAtStart?: Note
}): MergeStepResult {
  if (a.remote.result === 'unsupportedVersion') return { result: 'unsupportedVersion' }
  if (a.remote.result !== 'ok' || !a.remote.note) return { error: 'parse' }
  return a.localAtStart
    ? mergeRequeue({ base: a.base, localAtStart: a.localAtStart, localAtCommit: a.local, remote: a.remote.note, ctx: a.ctx })
    : merge(a.base, a.local, a.remote.note, a.ctx)
}
