// Which notes have changes Drive does not have (spec `sync.hasUnsent`), for the
// account-mismatch gate and the logout / disconnect warning (Story 3.8).
import { openNoteStore, type NoteStore } from '../storage/noteStore'
import { getOpenNote, openNoteIds } from './openNotes'

export type UnsentStore = Pick<NoteStore, 'listIds' | 'readSync'>

/** Waits until every open editor's save queue is on disk; a failure only means the snapshot is still queued. */
export async function flushOpenNotes(): Promise<void> {
  try {
    await Promise.all(openNoteIds().map((id) => getOpenNote(id)?.flush()))
  } catch {
    // counted from what is on disk
  }
}

/**
 * Ids of the notes with unsent changes. Null when the notes cannot be listed:
 * the caller must then warn without a number instead of assuming nothing is lost.
 * `readSync` never throws; a note it cannot read counts as unsent.
 */
export async function countUnsent(store: UnsentStore, flush: () => Promise<void> = flushOpenNotes): Promise<string[] | null> {
  try {
    await flush()
    const ids = await store.listIds()
    const unsent: string[] = []
    for (const id of ids) if ((await store.readSync(id)).hasUnsent) unsent.push(id)
    return unsent
  } catch {
    return null
  }
}

let shared: NoteStore | undefined
/** The real note store of this page, opened on first use. */
export const defaultUnsentStore = (): NoteStore => (shared ??= openNoteStore())
