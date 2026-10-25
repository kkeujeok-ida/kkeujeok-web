// Pure slot-list operations. Slots have no id: a selected / last-used index is
// carried through a change with indexAfterMove / indexAfterRemove.
import { MAX_PEN_SLOTS, type Pen, type PenTool } from './pen'

/** A copy of slot `i` at the end; the list itself when it is full. */
export function addSlot(list: readonly Pen[], i: number): Pen[] {
  const from = list[i]
  return from && list.length < MAX_PEN_SLOTS ? [...list, { ...from }] : [...list]
}

export function moveSlot(list: readonly Pen[], from: number, to: number): Pen[] {
  const next = [...list]
  if (!next[from] || to < 0 || to >= next.length) return next
  next.splice(to, 0, next.splice(from, 1)[0]!)
  return next
}

/** The list without slot `i`; the list itself when it has one slot. */
export function removeSlot(list: readonly Pen[], i: number): Pen[] {
  return list.length <= 1 || !list[i] ? [...list] : list.filter((_, k) => k !== i)
}

/** Where the slot that was at `i` is after moving `from` to `to`. */
export function indexAfterMove(i: number, from: number, to: number): number {
  if (i === from) return to
  if (from < to && i > from && i <= to) return i - 1
  if (from > to && i >= to && i < from) return i + 1
  return i
}

/** Where the slot that was at `i` is after removing `removed`; null when it is the removed one. */
export function indexAfterRemove(i: number, removed: number): number | null {
  return i === removed ? null : i > removed ? i - 1 : i
}

/** The last used slot of `tool` if it still is one, else the first slot of that tool; -1 when there is none. */
export function pickByTool(list: readonly Pen[], tool: PenTool, last: number | null | undefined): number {
  if (last != null && list[last]?.tool === tool) return last
  return list.findIndex((p) => p.tool === tool)
}
