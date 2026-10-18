// The area of a page that the other version lacks, for the outline on the conflict previews: elements whose id is
// not in `other`, as one rectangle in page coordinates (a stroke counts with half its width around each point).
import { isValidStroke, type Page } from '../model/note'

export type Range = { x: number; y: number; w: number; h: number }

export function changedRange(page: Page, other: Page | null): Range | null {
  const have = new Set<unknown>((Array.isArray(other?.elements) ? other.elements : []).map((e) => (e as { id?: unknown } | null)?.id))
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const e of Array.isArray(page.elements) ? page.elements : []) {
    if (!isValidStroke(e) || have.has(e.id)) continue
    const half = e.width / 2
    for (const p of e.points) {
      x0 = Math.min(x0, p[0]! - half)
      y0 = Math.min(y0, p[1]! - half)
      x1 = Math.max(x1, p[0]! + half)
      y1 = Math.max(y1, p[1]! + half)
    }
  }
  return Number.isFinite(x0) && Number.isFinite(x1) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}
