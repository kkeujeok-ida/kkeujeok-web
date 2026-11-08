// spec/pen-kinds.md "Answer tape": which tape a press lands on, and what a tap is.
import { inPolygon, type El } from './select'
import { strokeOutlineFor } from '../render/strokeOutline'

export const TAPE_TAP_MS = 400
export const TAPE_TAP_SLOP = 6 // CSS px

/** Id of the topmost tape whose polygon contains `p` (page pt), or null. */
export function tapeAt(elements: readonly El[], p: readonly [number, number]): string | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i]!
    if (e.type !== 'stroke' || e.tool !== 'tape' || typeof e.id !== 'string' || !Array.isArray(e.points) || typeof e.width !== 'number') continue
    const poly = strokeOutlineFor('tape', e.width, false, e.points)
    if (poly.length >= 3 && inPolygon(p, poly as unknown as [number, number][])) return e.id
  }
  return null
}

/** A tap: up within 400 ms and moved less than 6 CSS px. */
export const isTapeTap = (elapsedMs: number, moved: number): boolean => elapsedMs < TAPE_TAP_MS && moved < TAPE_TAP_SLOP
