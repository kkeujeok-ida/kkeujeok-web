// spec rule `page.background` (page-background.md): the lines and dots of a
// page background. An unknown background draws as plain.
import { round2 } from '../model/number'

export type PageBackground = {
  paper: string
  lineColor: string
  lineWidth: number
  lines: number[][]
  dotColor: string
  dotRadius: number
  dots: number[][]
}

const STEP = 28

function build(background: string, w: number, h: number): PageBackground {
  const width = round2(w)
  const height = round2(h)
  const lines: number[][] = []
  const dots: number[][] = []
  switch (background) {
    case 'lined':
      for (let y = 56; y <= h - STEP; y += STEP) lines.push([0, y, width, y])
      break
    case 'grid':
      for (let x = STEP; x < w; x += STEP) lines.push([x, 0, x, height])
      for (let y = STEP; y < h; y += STEP) lines.push([0, y, width, y])
      break
    case 'dot':
      for (let y = STEP; y < h; y += STEP) for (let x = STEP; x < w; x += STEP) dots.push([x, y])
      break
  }
  return { paper: '#ffffff', lineColor: '#c5ced8', lineWidth: 0.5, lines, dotColor: '#a0aab5', dotRadius: 0.75, dots }
}

// Geometry per (background, w, h): thumbnails and every repaint ask again.
const memo = new Map<string, PageBackground>()
const MEMO_MAX = 64

/** Computed once per (background, w, h); treat the result as read-only. */
export function pageBackground(background: string, w: number, h: number): PageBackground {
  const key = `${background}|${w}|${h}`
  let hit = memo.get(key)
  if (!hit) {
    if (memo.size >= MEMO_MAX) memo.clear()
    hit = build(background, w, h)
    memo.set(key, hit)
  }
  return hit
}
