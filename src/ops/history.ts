// Undo/redo for one note (spec ops.undoRedo). Holds operations only; every
// undo or redo is applied as a new op, so rev and seq never go back.
import type { Note } from '../model/note'
import { type Ctx, type Op, applyOp } from './ops'

/** Every page id an op names: its own pageId, pageIds, and items[].pageId / items[].page.id (page-op inverses). */
export function touched(op: Op): string[] {
  const items = (Array.isArray(op.items) ? op.items : []) as { pageId?: unknown; page?: { id?: unknown } }[]
  return [op.pageId, ...(Array.isArray(op.pageIds) ? op.pageIds : []), ...items.flatMap((i) => [i?.pageId, i?.page?.id])].filter((x): x is string => typeof x === 'string')
}

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
  /** The next undo / redo record belongs to a locked page (it would be refused). */
  topLocked(kind: 'undo' | 'redo'): boolean {
    const s = kind === 'undo' ? this.undoStack : this.redoStack
    const top = s[s.length - 1]
    return !!top && this.touchesLocked(top)
  }
  private touchesLocked(op: Op): boolean {
    return touched(op).some((id) => this.locked.has(id))
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
    const keep = (op: Op) => !touched(op).some((id) => drop.has(id))
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
    // A null inverse (nothing changed) is not recorded.
    if (r.inverse) {
      this.undoStack.push(r.inverse)
      this.redoStack = []
    }
    return null
  }

  /** Folds the newest undo record into the one below it: a run of nudges becomes one undo step (replaceElements inverses restore the first state). */
  foldLastUndo(): void {
    if (this.undoStack.length > 1) this.undoStack.pop()
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
    if (r.inverse) to.push(r.inverse)
    return null
  }
}
