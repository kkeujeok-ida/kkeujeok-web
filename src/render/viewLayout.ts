// Where each page of a note sits in the document, per page view (pure; document points, top-left origin). Spec page-view pageview.layout.
import type { PageViewMode } from '../storage/viewMode'

/** Space between two units (page points). */
export const PAGE_GAP = 24
/** Space between the two pages of a pair. */
export const SPINE_GAP = 4

export type PageSize = { width: number; height: number }
/** `unit`: index in `units` of the unit the page belongs to. */
export type PlacedPage = { index: number; unit: number; x: number; y: number }
/** The pages `first..last` that are shown together, and their box. */
export type Unit = { first: number; last: number; x: number; y: number; w: number; h: number }
export type DocLayout = { list: PlacedPage[]; units: Unit[]; w: number; h: number }

/** Page indices grouped into units: with 2 pages a pair of two portrait pages in a row, else one page alone. */
function groups(pages: readonly PageSize[], per: 1 | 2): number[][] {
  const out: number[][] = []
  const portrait = (p: PageSize) => p.width <= p.height
  for (let i = 0; i < pages.length; i++) {
    if (per === 2 && i + 1 < pages.length && portrait(pages[i]!) && portrait(pages[i + 1]!)) out.push([i, ++i])
    else out.push([i])
  }
  return out
}

/** `mode.pages` is used as given: the caller applies `effectiveView` for a phone. */
export function layoutSlots(pages: readonly PageSize[], mode: PageViewMode): DocLayout {
  const gs = groups(pages, mode.pages)
  const list: PlacedPage[] = pages.map((_, index) => ({ index, unit: 0, x: 0, y: 0 }))
  const sizes = gs.map((g) => ({ w: g.reduce((s, i) => s + pages[i]!.width, 0) + (g.length - 1) * SPINE_GAP, h: Math.max(...g.map((i) => pages[i]!.height)) }))
  const vertical = mode.direction === 'vertical'
  const cross = Math.max(0, ...sizes.map((s) => (vertical ? s.w : s.h)))
  const units: Unit[] = []
  let at = 0
  for (const [u, g] of gs.entries()) {
    const s = sizes[u]!
    const ux = vertical ? (cross - s.w) / 2 : at
    const uy = vertical ? at : (cross - s.h) / 2
    let x = ux
    for (const i of g) {
      list[i] = { index: i, unit: u, x, y: uy + (s.h - pages[i]!.height) / 2 }
      x += pages[i]!.width + SPINE_GAP
    }
    units.push({ first: g[0]!, last: g[g.length - 1]!, x: ux, y: uy, w: s.w, h: s.h })
    at += (vertical ? s.h : s.w) + PAGE_GAP
  }
  const main = Math.max(0, at - PAGE_GAP)
  return { list, units, w: vertical ? cross : main, h: vertical ? main : cross }
}
