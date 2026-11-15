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

// --- Page turn snap (spec page-view pageview.snap); screen px along the direction axis. ---
export type AxisUnit = { start: number; size: number }
/** A flick at least this fast (px/s) turns one unit. */
export const FLICK_SPEED = 600
export const TURN_MS = 250

/** The unit whose center is nearest the viewport center; a tie goes to the earlier one. */
export function nearestUnit(units: readonly AxisUnit[], viewport: number, offset: number): number {
  const mid = offset + viewport / 2
  let best = 0
  for (let i = 1; i < units.length; i++) {
    if (Math.abs(units[i]!.start + units[i]!.size / 2 - mid) < Math.abs(units[best]!.start + units[best]!.size / 2 - mid)) best = i
  }
  return best
}

/** Final offset for `target`: a unit that fits is centered; a longer one keeps `offset` clamped (current) or shows its near edge. */
export function turnOffset(units: readonly AxisUnit[], viewport: number, target: number, current: number, offset: number): number {
  const u = units[target]!
  if (u.size <= viewport) return u.start + u.size / 2 - viewport / 2
  const last = u.start + u.size - viewport
  if (target === current) return Math.min(last, Math.max(u.start, offset))
  return target > current ? u.start : last
}

export function pageSnap(units: readonly AxisUnit[], viewport: number, offset: number, velocity: number, current: number): { target: number; offset: number } {
  if (units.length === 0) return { target: 0, offset }
  const c = units[current]!
  if (c.size > viewport && offset >= c.start && offset <= c.start + c.size - viewport) return { target: current, offset }
  const target = Math.abs(velocity) >= FLICK_SPEED ? Math.min(units.length - 1, Math.max(0, current + (velocity > 0 ? 1 : -1))) : nearestUnit(units, viewport, offset)
  return { target, offset: turnOffset(units, viewport, target, current, offset) }
}

/** CSS `cubic-bezier(0, 0, 0.58, 1)` (ease-out): progress for time `t` in 0..1. */
export function easeOutCurve(t: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const s = (lo + hi) / 2
    const x = 3 * (1 - s) * s * s * 0.58 + s * s * s
    if (x < t) lo = s
    else hi = s
  }
  const s = (lo + hi) / 2
  return 3 * (1 - s) * s * s + s * s * s
}

/** Wheel lock of a turned view: one turn, then locked 400 ms and while events come less than 120 ms apart (trackpad inertia). */
export class WheelLock {
  private locked = false
  private from = 0
  private last = 0
  /** True when this wheel event (axis delta in px, `now` in ms) turns one unit. */
  hit(now: number, delta: number): boolean {
    if (this.locked) {
      if (now - this.from < 400 || now - this.last < 120) {
        this.last = now
        return false
      }
      this.locked = false
    }
    if (!(Math.abs(delta) >= 4)) return false
    this.locked = true
    this.from = this.last = now
    return true
  }
}
