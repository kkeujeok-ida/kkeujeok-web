// spec/canvas.md: canvas.kind and canvas.size (port of the Android lib/model/canvas_rules.dart).
import type { Note } from './note'

export const CANVAS_MIN_SIDE = 64
export const CANVAS_MAX_SIDE = 4096 // draft until Story 33.8
export const CANVAS_PRESETS: readonly (readonly [number, number])[] = [[1080, 1080], [1920, 1080], [595, 842]]
export type CanvasMode = 'note' | 'canvas' | 'readOnly'
export type CanvasSizeOut = { ok: true } | { ok: false; side: 'width' | 'height'; reason: 'invalid' | 'notInteger' | 'tooSmall' | 'tooLarge' }

/** Width is judged first, then height. */
export function canvasSize(width: unknown, height: unknown): CanvasSizeOut {
  for (const [side, v] of [['width', width], ['height', height]] as const) {
    const reason =
      typeof v !== 'number' || !Number.isFinite(v) ? 'invalid' : !Number.isInteger(v) ? 'notInteger' : v < CANVAS_MIN_SIDE ? 'tooSmall' : v > CANVAS_MAX_SIDE ? 'tooLarge' : null
    if (reason) return { ok: false, side, reason }
  }
  return { ok: true }
}

/** `"transparent"` or `{type: "color", value: "#rrggbb"}` (lowercase). */
export const validCanvasBackground = (b: unknown): boolean => {
  if (b === 'transparent') return true
  const o = b as { type?: unknown; value?: unknown } | null
  return typeof o === 'object' && o !== null && o.type === 'color' && typeof o.value === 'string' && /^#[0-9a-f]{6}$/.test(o.value)
}

export function canvasModeOf(kind: unknown, pages: readonly { width?: unknown; height?: unknown; background?: unknown }[]): CanvasMode {
  if (kind === undefined || kind === null || kind === 'note') return 'note'
  if (kind !== 'canvas' || pages.length !== 1) return 'readOnly'
  const p = pages[0]!
  return canvasSize(p.width, p.height).ok && validCanvasBackground(p.background) ? 'canvas' : 'readOnly'
}

export const canvasMode = (n: Note): CanvasMode => canvasModeOf(n.meta.kind, n.pages)
