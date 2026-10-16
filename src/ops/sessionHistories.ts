// Undo/redo history per note for the life of this tab (spec 2.11). A reload
// drops the module and with it every history; logout/disconnect clear it.
import type { Note } from '../model/note'
import { History } from './history'

const histories = new Map<string, History>()

function same(a: unknown, b: unknown): boolean {
  if (a === b || Object.is(a, b)) return true // Object.is: NaN equals itself
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  // An undefined-valued key is the same as a missing one (JSON drops it).
  const defined = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined)
  const ka = defined(a)
  if (ka.length !== defined(b).length) return false
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * The history of `note`: the kept one when its note equals the saved `note`,
 * otherwise a fresh one (a failed save must not be "undone" back past the DB).
 */
export function sessionHistory(note: Note): History {
  const kept = histories.get(note.noteId)
  if (kept && same(kept.note, note)) {
    kept.note = note
    return kept
  }
  const h = new History(note)
  histories.set(note.noteId, h)
  return h
}

/** A merge changed a note whose editor is closed: its kept history follows (spec merge.undoDrop). */
export function applyMergeToSession(noteId: string, note: Note, undoDrop: readonly string[]): void {
  histories.get(noteId)?.applyMerged(note, undoDrop)
}

export const clearSessionHistories = () => histories.clear()
