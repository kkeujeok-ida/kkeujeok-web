// Undo/redo for one note (spec ops.undoRedo). Holds operations only; every
// undo or redo is applied as a new op, so rev and seq never go back.
import type { Note } from '../model/note'
import { type Ctx, type Op, applyOp } from './ops'

export class History {
  private undoStack: Op[] = []
  private redoStack: Op[] = []
  constructor(public note: Note) {}

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
    const r = applyOp(this.note, top, ctx)
    if ('error' in r) return r.error
    this.note = r.note
    from.pop()
    to.push(r.inverse)
    return null
  }
}
