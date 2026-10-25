// Where each page of a note sits in the document, per view mode (pure; document points, top-left origin).
import type { ViewMode } from '../storage/viewMode'

/** Space between two pages (page points). */
export const PAGE_GAP = 16
/** Space between two units of the two-page view. */
const UNIT_GAP = 3 * PAGE_GAP

export type PageSize = { width: number; height: number }
/** `unit`: index in `units` of the unit the page belongs to. */
export type PlacedPage = { index: number; unit: number; x: number; y: number }
/** The pages `first..last` that are shown together, and their box. */
export type Unit = { first: number; last: number; x: number; y: number; w: number; h: number }
export type DocLayout = { list: PlacedPage[]; units: Unit[]; w: number; h: number }

/** Page indices grouped into units: a pair of two portrait pages in a row, else one page alone. */
function groups(pages: readonly PageSize[], mode: ViewMode): number[][] {
  const out: number[][] = []
  for (let i = 0; i < pages.length; i++) {
    const portrait = (p: PageSize) => p.width <= p.height
    if (mode === 'twoPage' && i + 1 < pages.length && portrait(pages[i]!) && portrait(pages[i + 1]!)) out.push([i, ++i])
    else out.push([i])
  }
  return out
}

export function layoutSlots(pages: readonly PageSize[], mode: ViewMode): DocLayout {
  const gs = groups(pages, mode)
  const list: PlacedPage[] = pages.map((_, index) => ({ index, unit: 0, x: 0, y: 0 }))
  const units: Unit[] = []
  if (mode === 'vertical') {
    const w = Math.max(0, ...pages.map((p) => p.width))
    let y = 0
    for (const [u, g] of gs.entries()) {
      const p = pages[g[0]!]!
      list[g[0]!] = { index: g[0]!, unit: u, x: (w - p.width) / 2, y }
      units.push({ first: g[0]!, last: g[0]!, x: (w - p.width) / 2, y, w: p.width, h: p.height })
      y += p.height + PAGE_GAP
    }
    return { list, units, w, h: Math.max(0, y - PAGE_GAP) }
  }
  const h = Math.max(0, ...pages.map((p) => p.height))
  let x = 0
  for (const [u, g] of gs.entries()) {
    const uh = Math.max(...g.map((i) => pages[i]!.height))
    const uy = (h - uh) / 2
    let ux = x
    for (const i of g) {
      list[i] = { index: i, unit: u, x: ux, y: uy + (uh - pages[i]!.height) / 2 }
      ux += pages[i]!.width + PAGE_GAP
    }
    const uw = ux - PAGE_GAP - x
    units.push({ first: g[0]!, last: g[g.length - 1]!, x, y: uy, w: uw, h: uh })
    x += uw + (mode === 'twoPage' ? UNIT_GAP : PAGE_GAP)
  }
  return { list, units, w: Math.max(0, x - (mode === 'twoPage' ? UNIT_GAP : PAGE_GAP)), h }
}
