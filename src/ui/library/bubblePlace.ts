export type Side = 'down' | 'up' | 'left' | 'right'
export type Box = { left: number; top: number; right: number; bottom: number }
export type Placement = { side: Side; left: number; top: number; tail: number | null }

export const BUBBLE_GAP = 12 // bar to bubble; the tail takes 8 of it
export const BUBBLE_MARGIN = 12 // bubble to window edge

export const TAIL_EDGE = 16 // tail centre to the bubble's corners, at the least

/**
 * The rules of spec/toolbar-orientation.md. Horizontal bar: the bubble opens below it, above when the bar is in the lower half.
 * Vertical bar: beside it, on the side away from the window's nearer edge. The bubble is pulled inside the window; `tail` is the
 * tool's centre along the bubble's edge (from its left or top), kept TAIL_EDGE off the corners; null (no tail) when the pulled
 * bubble covers the bar or the tail would leave the window.
 */
export function placeBubble(bar: Box, tool: Box, size: { w: number; h: number }, win: { w: number; h: number }): Placement {
  const fit = (v: number, s: number, max: number) => Math.max(BUBBLE_MARGIN, Math.min(v, max - BUBBLE_MARGIN - s))
  const w = Math.min(size.w, win.w - BUBBLE_MARGIN * 2)
  const vertical = bar.bottom - bar.top > bar.right - bar.left
  let side: Side, left: number, top: number, tail: number
  if (vertical) {
    side = (bar.left + bar.right) / 2 < win.w / 2 ? 'right' : 'left'
    top = fit((tool.top + tool.bottom) / 2 - size.h / 2, size.h, win.h)
    left = fit(side === 'right' ? bar.right + BUBBLE_GAP : bar.left - BUBBLE_GAP - w, w, win.w)
    tail = (tool.top + tool.bottom) / 2 - top
  } else {
    side = (bar.top + bar.bottom) / 2 > win.h / 2 ? 'up' : 'down'
    left = fit((tool.left + tool.right) / 2 - w / 2, w, win.w)
    top = fit(side === 'down' ? bar.bottom + BUBBLE_GAP : bar.top - BUBBLE_GAP - size.h, size.h, win.h)
    tail = (tool.left + tool.right) / 2 - left
  }
  const len = vertical ? size.h : w
  const tip = { down: top - 8, up: top + size.h + 8, right: left - 8, left: left + w + 8 }[side]
  const covered = left < bar.right && left + w > bar.left && top < bar.bottom && top + size.h > bar.top
  const out = tip < 0 || tip > (vertical ? win.w : win.h)
  return { side, left, top, tail: covered || out ? null : Math.max(TAIL_EDGE, Math.min(tail, len - TAIL_EDGE)) }
}
