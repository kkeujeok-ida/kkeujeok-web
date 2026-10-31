// spec rule page.outOfBounds (spec/page.md): port of the Android lib/model/page_bounds.dart.
import { round2 } from './number'
import { selectionBounds, type El } from './select'

const OUT_MARGIN = 2

/** Ids of the elements that extend past an edge of the page by more than 2 pt, in the order of `elements`. */
export function pageOutOfBounds(width: number, height: number, elements: readonly El[]): string[] {
  const ids: string[] = []
  for (const e of elements) {
    const b = selectionBounds([e])
    if (!b) continue // no box (an empty stroke) is never outside
    if (round2(b.left) < -OUT_MARGIN || round2(b.top) < -OUT_MARGIN || round2(b.right) > width + OUT_MARGIN || round2(b.bottom) > height + OUT_MARGIN) ids.push(e.id as string)
  }
  return ids
}
