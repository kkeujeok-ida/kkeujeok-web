// The notes open and writable in this tab (the editor holds their Web Lock). The
// uploader flushes them before reading, and merges into them so a merge never
// bypasses the editor's history and save queue.
import type { Note } from '../model/note'
import type { MergeCtx, RequeueResult } from './merge'

export type OpenNote = {
  /** Waits until the save queue is on disk; false = a snapshot is still unsaved. */
  flush(): Promise<boolean>
  /** The note as the editor has it right now. */
  current(): Note
  /** Merges `remote` into the editor's note (history, repaint, save). */
  applyMerge(a: { base: Note | null; localAtStart: Note; remote: Note; ctx: MergeCtx }): RequeueResult
}

const open = new Map<string, OpenNote>()

/** Registers `entry` for `noteId`; the returned function removes it (only if it is still the one registered). */
export function registerOpenNote(noteId: string, entry: OpenNote): () => void {
  open.set(noteId, entry)
  return () => {
    if (open.get(noteId) === entry) open.delete(noteId)
  }
}

export const getOpenNote = (noteId: string): OpenNote | undefined => open.get(noteId)
export const openNoteIds = (): string[] => [...open.keys()]
