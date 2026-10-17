// Applies a merge for the uploader and the receiver (sync.md steps 1 and 3, "Triggers"): the merged note
// becomes the working copy. An open note takes it through the editor (history, repaint, save queue); a
// closed one is written to the store. A merge that raised conflicts first makes the losing pages durable
// (sidecar records + `conflicts` in sync.json, Story 3.20) and only then lets the merged note in:
// closed note = one transaction guarded on the stored working copy; open note = record, then the
// editor applies exactly what was recorded.
import type { Note } from '../model/note'
import { applyMergeToSession } from '../ops/sessionHistories'
import type { NoteStore } from '../storage/noteStore'
import { type Recorded, noRecorded, sidecarKey } from './conflicts'
import { type MergeCtx } from './merge'
import { mergeStep } from './mergeStep'
import { type OpenNote, getOpenNote } from './openNotes'

export type MergeOutcome =
  /** `conflicts`: the `rev` of every sidecar the merge raised (for the state event and the log). */
  | { result: 'merged'; conflicts?: string[] }
  | { result: 'unsupportedVersion' }
  | { result: 'error'; reason: string }

export type MergeIo = {
  merge(a: { noteId: string; base: Note | null; remote: Note }): Promise<MergeOutcome>
}

/** How often a merge is tried again when the note moved under it. */
const TRIES = 3

export function createMergeIo(d: {
  store: Pick<NoteStore, 'loadNote' | 'commitMerge' | 'recordConflicts'>
  editedBy: () => string
  now: () => string
  newId: () => string
  open?: (noteId: string) => OpenNote | undefined
}): MergeIo {
  const open = d.open ?? getOpenNote
  const ctx = (): MergeCtx => ({ now: d.now(), orderRev: d.newId(), rev: d.newId(), editedBy: d.editedBy(), lastSeenRemoteSeq: 0 })
  const merged = (revs: string[]): MergeOutcome => (revs.length > 0 ? { result: 'merged', conflicts: revs } : { result: 'merged' })

  async function closed(noteId: string, base: Note | null, remote: Note): Promise<MergeOutcome> {
    for (let tries = 0; tries < TRIES; tries++) {
      const local = (await d.store.loadNote(noteId))?.note ?? null
      if (!local) return { result: 'error', reason: 'workingMissing' }
      const r = mergeStep({ base, local, remote: { result: 'ok', writable: true, note: remote }, ctx: ctx() })
      if (r.result === 'unsupportedVersion') return { result: 'unsupportedVersion' }
      if (r.result !== 'merged') return { result: 'error', reason: String(r.error) }
      const raised = r.conflicts.length > 0 || r.sidecars.length > 0
      if (!raised && JSON.stringify(r.note) === JSON.stringify(local)) return { result: 'merged' } // nothing to write
      // One transaction, only while the stored working copy still is the one merged from.
      if (!(await d.store.commitMerge(noteId, local, r.note, { conflicts: r.conflicts, sidecars: r.sidecars }))) continue
      applyMergeToSession(noteId, r.note, r.undoDrop)
      return merged(r.sidecars.map((s) => s.rev))
    }
    return { result: 'error', reason: 'workingMoved' }
  }

  async function inEditor(entry: OpenNote, noteId: string, base: Note | null, remote: Note): Promise<MergeOutcome> {
    let supersedes: Recorded = noRecorded()
    for (let tries = 0; tries < TRIES; tries++) {
      // No await between reading the editor's note and applying: nothing is drawn in between.
      let local = entry.current()
      let c = ctx()
      let r = mergeStep({ base, local, remote: { result: 'ok', writable: true, note: remote }, ctx: c })
      if (r.result === 'unsupportedVersion') return { result: 'unsupportedVersion' }
      if (r.result !== 'merged') return { result: 'error', reason: String(r.error) }
      let ended: string | null = null
      if (r.conflicts.length > 0 || r.sidecars.length > 0) {
        // A page is about to be taken from this device. A stroke in progress is received to its end first
        // (it belongs to the version that is kept), then the merge is looked at again with it in.
        ended = (await entry.strokeEnd?.()) ?? null
        local = entry.current()
        c = ctx()
        r = mergeStep({ base, local, remote: { result: 'ok', writable: true, note: remote }, ctx: c })
        if (r.result === 'unsupportedVersion') return { result: 'unsupportedVersion' }
        if (r.result !== 'merged') return { result: 'error', reason: String(r.error) }
      }
      if (r.conflicts.length === 0 && r.sidecars.length === 0) {
        if (JSON.stringify(r.note) === JSON.stringify(local)) return { result: 'merged' } // nothing to write
        const a = entry.applyMerge({ base, localAtStart: local, remote, ctx: c })
        if (a.result !== 'merged') return { result: 'error', reason: 'applyFailed' }
        await entry.flush()
        return { result: 'merged' }
      }
      // The losing pages are durable before the editor drops them.
      const added = await d.store.recordConflicts(noteId, { conflicts: r.conflicts, sidecars: r.sidecars, supersedes })
      const a = entry.applyMerge({ base, localAtStart: local, remote, ctx: c, expect: r.sidecars.map(sidecarKey), held: ended })
      if (a.result === 'stale') {
        supersedes = added // the editor moved: what this try recorded is replaced by the next one
        continue
      }
      if (a.result !== 'merged') return { result: 'error', reason: 'applyFailed' }
      await entry.flush()
      return merged(r.sidecars.map((s) => s.rev))
    }
    return { result: 'error', reason: 'applyFailed' }
  }

  return {
    merge({ noteId, base, remote }) {
      const entry = open(noteId)
      return entry ? inEditor(entry, noteId, base, remote) : closed(noteId, base, remote)
    },
  }
}
