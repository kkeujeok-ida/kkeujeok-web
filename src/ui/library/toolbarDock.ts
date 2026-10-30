import { DEFAULT_POS, type Dock, type ToolbarPos } from '../../storage/toolbarPosition'

/** A drop within this many CSS px of a snap outline docks there. */
export const SNAP_RADIUS = 48
/** The gap between a docked toolbar and the window edge (--spacing-3). */
export const MARGIN = 12
export type Size = { w: number; h: number }
export type Pt = { x: number; y: number }
export type Rect = { left: number; top: number; right: number; bottom: number }
export const DOCKS: readonly Dock[] = ['top', 'left', 'right', 'bottom']

/** The toolbar box turned to the vertical or horizontal shape (shortcut: the turned box is the measured one with w/h swapped; exact only while the item count is unchanged). */
export const sizeAt = (vertical: boolean, size: Size): Size => (vertical ? { w: Math.min(size.w, size.h), h: Math.max(size.w, size.h) } : { w: Math.max(size.w, size.h), h: Math.min(size.w, size.h) })

/** The outline rect at a snap point; `size` is the current toolbar box, `win` the window. */
export function dockRect(dock: Dock, size: Size, win: Size): Rect {
  const s = sizeAt(dock === 'left' || dock === 'right', size)
  const left = dock === 'left' ? MARGIN : dock === 'right' ? win.w - MARGIN - s.w : (win.w - s.w) / 2
  const top = dock === 'top' ? MARGIN : dock === 'bottom' ? win.h - MARGIN - s.h : (win.h - s.h) / 2
  return { left, top, right: left + s.w, bottom: top + s.h }
}

const gap = (c: Pt, r: Rect) => Math.hypot(Math.max(r.left - c.x, 0, c.x - r.right), Math.max(r.top - c.y, 0, c.y - r.bottom))

/** The first of top, left, right, bottom whose outline is within SNAP_RADIUS of the pointer, or null (float); same rule as Android `dockAtPointer`. */
export const dockAtPointer = (pointer: Pt, size: Size, win: Size): Dock | null => DOCKS.find((d) => gap(pointer, dockRect(d, size, win)) <= SNAP_RADIUS) ?? null

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Keeps a toolbar of `s` centred at `c` whole inside the window (display only). */
export function clampCenter(c: Pt, s: Size, win: Size): Pt {
  const fit = (v: number, len: number, total: number) => (len >= total ? total / 2 : clamp(v, len / 2, total - len / 2))
  return { x: fit(c.x, s.w, win.w), y: fit(c.y, s.h, win.h) }
}

/** The toolbar centre on screen for a stored position (`size` is its box in the stored orientation). */
export function centerOf(pos: ToolbarPos, size: Size, win: Size): Pt {
  if (pos.dock === 'float') return clampCenter({ x: pos.x * win.w, y: pos.y * win.h }, sizeAt(pos.vertical, size), win)
  const r = dockRect(pos.dock, size, win)
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
}

export const ratioOf = (c: Pt, win: Size): Pt => ({ x: win.w ? c.x / win.w : 0.5, y: win.h ? c.y / win.h : 0 })

/** Docking: left/right turn it vertical, top/bottom horizontal. */
export const applyDock = (_pos: ToolbarPos, dock: Dock): ToolbarPos => ({ ...DEFAULT_POS, dock, vertical: dock === 'left' || dock === 'right' })

/** The smallest move (dx, dy) of `el` that clears `bar` while staying in `area`, or null when they do not overlap. */
export function revealShift(el: Rect, bar: Rect, area: Rect): Pt | null {
  if (el.left >= bar.right || el.right <= bar.left || el.top >= bar.bottom || el.bottom <= bar.top) return null
  const opts: Pt[] = [
    { x: 0, y: bar.top - el.bottom }, // up
    { x: 0, y: bar.bottom - el.top }, // down
    { x: bar.left - el.right, y: 0 }, // left
    { x: bar.right - el.left, y: 0 }, // right
  ].filter((m) => el.left + m.x >= area.left && el.right + m.x <= area.right && el.top + m.y >= area.top && el.bottom + m.y <= area.bottom)
  opts.sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - (Math.abs(b.x) + Math.abs(b.y)))
  return opts[0] ?? null
}
