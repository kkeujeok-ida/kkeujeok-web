// Undo/redo for one note (spec ops.undoRedo). Holds operations only; every
// undo or redo is applied as a new op, so rev and seq never go back.
import type { Note } from '../model/note'
import { type Ctx, type Op, applyOp } from './ops'

export class History {
  private undoStack: Op[] = []
  private redoStack: Op[] = []
  /** Pages with an unresolved conflict (Story 3.20): no op touches them and undo/redo of their records is refused. */
  private locked = new Set<string>()
  constructor(public note: Note) {}

  /** Replaces the locked pages. */
  setLocked(ids: Iterable<string>): void {
    this.locked = new Set(ids)
  }
  /** Locks more pages; never unlocks. */
  lockPages(ids: Iterable<string>): void {
    for (const id of ids) this.locked.add(id)
  }
  isLocked(pageId: string): boolean {
    return this.locked.has(pageId)
  }
  private touchesLocked(op: Op): boolean {
    return typeof op.pageId === 'string' && this.locked.has(op.pageId)
  }

  get undoDepth() {
    return this.undoStack.length
  }
  get redoDepth() {
    return this.redoStack.length
  }

  /**
   * A merge changed the note (spec merge.undoDrop, AD-16): adopt it and forget
   * every undo and redo record of the pages in `dropPages`. Records of other
   * pages (and ones without a page) stay; ops of different pages commute.
   */
  applyMerged(note: Note, dropPages: readonly string[]): void {
    const drop = new Set(dropPages)
    const keep = (op: Op) => !(typeof op.pageId === 'string' && drop.has(op.pageId))
    this.note = note
    this.undoStack = this.undoStack.filter(keep)
    this.redoStack = this.redoStack.filter(keep)
  }

  /** Error code, or null on success. A failure changes nothing. */
  doOp(op: Op, ctx: Ctx): string | null {
    if (this.touchesLocked(op)) return 'pageReadOnly'
    const r = applyOp(this.note, op, ctx)
    if ('error' in r) return r.error
    this.note = r.note
    this.undoStack.push(r.inverse)
    this.redoStack = []
    return null
  }

  undo(ctx: Ctx) {
    return this.replay(this.undoStack, this.redoStack, ctx)
  }
  redo(ctx: Ctx) {
    return this.replay(this.redoStack, this.undoStack, ctx)
  }

  private replay(from: Op[], to: Op[], ctx: Ctx): string | null {
    const top = from[from.length - 1]
    if (!top) return null
    if (this.touchesLocked(top)) return 'pageReadOnly'
    const r = applyOp(this.note, top, ctx)
    if ('error' in r) return r.error
    this.note = r.note
    from.pop()
    to.push(r.inverse)
    return null
  }
}
