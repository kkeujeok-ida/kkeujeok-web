// The notes open and writable in this tab (the editor holds their Web Lock). The
// uploader flushes them before reading, and merges into them so a merge never
// bypasses the editor's history and save queue.
import type { Note } from '../model/note'
import type { MergeCtx, RequeueResult } from './merge'

export type OpenNote = {
  /** Waits until the save queue is on disk; false = a snapshot is still unsaved. */
  flush(): Promise<boolean>
  /** A stroke is being drawn or a save is not on disk yet (the tab-close warning asks this synchronously). */
  unsaved?(): boolean
  /** The note as the editor has it right now. */
  current(): Note
  /**
   * Merges `remote` into the editor's note (history, repaint, save). With `expect` (the sidecar keys already
   * recorded, Story 3.20) the merge is NOT applied and `stale` is answered when it would raise another sidecar
   * or a stroke has begun. `held`: the page of a stroke that ended just before; it stays on screen.
   */
  applyMerge(a: { base: Note | null; localAtStart: Note; remote: Note; ctx: MergeCtx; expect?: readonly string[]; held?: string | null }): RequeueResult | { result: 'stale' }
  /** Resolves when no stroke is in progress; the value is the page id of a stroke that ended meanwhile, else null. */
  strokeEnd?(): Promise<string | null>
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
