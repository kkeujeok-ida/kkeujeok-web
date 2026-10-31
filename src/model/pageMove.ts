// Where a block of pages lands in `movePages` (spec ops.md): the index is into the pages that stay.

/** The block dropped just before original position `before` (0..order.length). */
export function dropIndex(order: readonly string[], picked: ReadonlySet<string>, before: number): number {
  return order.slice(0, before).filter((id) => !picked.has(id)).length
}

/** Alt+Up / Alt+Down: one step for the block; null when it is already at that end. */
export function stepIndex(order: readonly string[], picked: ReadonlySet<string>, dir: -1 | 1): number | null {
  const first = order.findIndex((id) => picked.has(id))
  if (first < 0) return null
  const to = order.slice(0, first).filter((id) => !picked.has(id)).length + dir
  return to < 0 || to > order.filter((id) => !picked.has(id)).length ? null : to
}
