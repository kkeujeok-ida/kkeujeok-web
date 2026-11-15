// spec rule `page.background` (page-background.md): the lines and dots of a
// page background. An unknown background draws as plain.
import { effectivePaper, type Paper } from '../model/note'
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

// spec page-background.md: paper, line and dot colors per paper color.
const COLORS: Record<Paper, { paper: string; line: string; dot: string }> = {
  white: { paper: '#ffffff', line: '#c5ced8', dot: '#a0aab5' },
  cream: { paper: '#fbf5df', line: '#d9d2b8', dot: '#b3ab8e' },
  black: { paper: '#16171a', line: '#3a3d44', dot: '#555963' },
}

function build(background: string, w: number, h: number, paper: Paper): PageBackground {
  const width = round2(w)
  const height = round2(h)
  const lines: number[][] = []
  const dots: number[][] = []
  switch (background) {
    case 'lined':
    case 'lined-wide': {
      const s = background === 'lined' ? STEP : 36
      for (let y = 56; y <= h - s; y += s) lines.push([0, y, width, y])
      break
    }
    case 'grid':
    case 'grid-s': {
      const s = background === 'grid' ? STEP : 14
      for (let x = s; x < w; x += s) lines.push([x, 0, x, height])
      for (let y = s; y < h; y += s) lines.push([0, y, width, y])
      break
    }
    case 'cornell': {
      const S = round2(h - 140)
      if (h > 56) lines.push([0, 56, width, 56])
      if (S > 56 && w > 140) lines.push([140, 56, 140, S])
      if (S > 56) lines.push([0, S, width, S])
      break
    }
    case 'dot':
      for (let y = STEP; y < h; y += STEP) for (let x = STEP; x < w; x += STEP) dots.push([x, y])
      break
  }
  const c = COLORS[paper]
  return { paper: c.paper, lineColor: c.line, lineWidth: 0.5, lines, dotColor: c.dot, dotRadius: 0.75, dots }
}

// Geometry per (background, w, h): thumbnails and every repaint ask again.
const memo = new Map<string, PageBackground>()
const MEMO_MAX = 64

/** Computed once per (background, w, h); treat the result as read-only. */
export function pageBackground(background: string, w: number, h: number, paper?: unknown): PageBackground {
  const p = effectivePaper(paper)
  const key = `${background}|${w}|${h}|${p}`
  let hit = memo.get(key)
  if (!hit) {
    if (memo.size >= MEMO_MAX) memo.clear()
    hit = build(background, w, h, p)
    memo.set(key, hit)
  }
  return hit
}
