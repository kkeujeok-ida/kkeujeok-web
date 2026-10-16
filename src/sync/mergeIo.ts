// Applies a merge for the uploader (sync.md steps 1 and 3): the merged note
// becomes the working copy. An open note takes it through the editor (history,
// repaint, save queue); a closed one is written to the store. A merge that would
// need a conflict sidecar is not applied at all (Story 3.19/3.20 own sidecars).
import type { Note } from '../model/note'
import { applyMergeToSession } from '../ops/sessionHistories'
import type { NoteStore } from '../storage/noteStore'
import { type MergeCtx } from './merge'
import { mergeStep } from './mergeStep'
import { type OpenNote, getOpenNote } from './openNotes'

export type MergeOutcome =
  | { result: 'merged' }
  | { result: 'unsupportedVersion' }
  | { result: 'conflict' }
  | { result: 'error'; reason: string }

export type MergeIo = {
  merge(a: { noteId: string; base: Note | null; remote: Note }): Promise<MergeOutcome>
}

export function createMergeIo(d: {
  store: Pick<NoteStore, 'loadNote' | 'writeNote'>
  editedBy: () => string
  now: () => string
  newId: () => string
  open?: (noteId: string) => OpenNote | undefined
}): MergeIo {
  const open = d.open ?? getOpenNote
  return {
    async merge({ noteId, base, remote }) {
      const entry = open(noteId)
      // No await between reading the editor's note and applying: nothing is drawn in between.
      const local = entry ? entry.current() : ((await d.store.loadNote(noteId))?.note ?? null)
      if (!local) return { result: 'error', reason: 'workingMissing' }
      const ctx: MergeCtx = { now: d.now(), orderRev: d.newId(), rev: d.newId(), editedBy: d.editedBy(), lastSeenRemoteSeq: 0 }
      const r = mergeStep({ base, local, remote: { result: 'ok', writable: true, note: remote }, ctx })
      if (r.result === 'unsupportedVersion') return { result: 'unsupportedVersion' }
      if (r.result !== 'merged') return { result: 'error', reason: String(r.error) }
      if (r.conflicts.length > 0 || r.sidecars.length > 0) return { result: 'conflict' }
      if (JSON.stringify(r.note) === JSON.stringify(local)) return { result: 'merged' } // nothing to write
      if (entry) {
        const a = entry.applyMerge({ base, localAtStart: local, remote, ctx })
        if (a.result !== 'merged') return { result: 'error', reason: 'applyFailed' }
        await entry.flush()
      } else {
        await d.store.writeNote(r.note)
        applyMergeToSession(noteId, r.note, r.undoDrop)
      }
      return { result: 'merged' }
    },
  }
}
