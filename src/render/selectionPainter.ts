// The lasso line and the selection box, in screen space over the pages (so both go on past the page edge).
// `box` and `lasso` are in document coordinates; `vp` maps them to CSS px of the canvas.
import type { Bounds } from '../model/select'
import type { PageViewport } from './pagePainter'

export const HANDLE_RADIUS = 6
export const ROTATE_GAP = 28 // px above the box top
const LINE = 1.5
const DASH = [4, 4]

/** The selection colors are design tokens, read from the element's computed style. */
export function selectionColors(el: Element) {
  const s = getComputedStyle(el)
  const v = (n: string) => s.getPropertyValue(n).trim()
  return {
    outline: v('--components-selection-outline'),
    fill: v('--components-selection-handle-fill'),
    border: v('--components-selection-handle-border'),
  }
}

export function paintSelection(
  ctx: CanvasRenderingContext2D,
  vp: PageViewport,
  box: Bounds | null,
  lasso: readonly (readonly [number, number])[] | null,
  colors: ReturnType<typeof selectionColors>,
  /** Degrees: the box is drawn turned about its center (rotate-drag preview). */
  angle = 0,
  /** Document points of the side handles of a single text box (they change its width). */
  widthHandles: readonly (readonly [number, number])[] = [],
): void {
  const sx = (x: number) => vp.offsetX + x * vp.scale
  const sy = (y: number) => vp.offsetY + y * vp.scale
  ctx.save()
  ctx.lineWidth = LINE
  ctx.strokeStyle = colors.outline
  if (lasso && lasso.length > 1) {
    ctx.beginPath()
    lasso.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(sx(x), sy(y)) : ctx.lineTo(sx(x), sy(y))))
    ctx.stroke()
  }
  if (box) {
    const l = sx(box.left), t = sy(box.top), r = sx(box.right), b = sy(box.bottom)
    const cx = (l + r) / 2
    if (angle) {
      ctx.translate(cx, (t + b) / 2)
      ctx.rotate((angle * Math.PI) / 180)
      ctx.translate(-cx, -(t + b) / 2)
    }
    ctx.setLineDash(DASH)
    ctx.strokeRect(l, t, r - l, b - t)
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(cx, t)
    ctx.lineTo(cx, t - ROTATE_GAP)
    ctx.stroke()
    for (const [x, y] of [[l, t], [r, t], [l, b], [r, b], [cx, t - ROTATE_GAP]] as const) {
      ctx.beginPath()
      ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = colors.fill
      ctx.fill()
      ctx.strokeStyle = colors.border
      ctx.stroke()
    }
  }
  for (const [x, y] of widthHandles) {
    ctx.beginPath()
    ctx.arc(sx(x), sy(y), HANDLE_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = colors.fill
    ctx.fill()
    ctx.strokeStyle = colors.border
    ctx.stroke()
  }
  ctx.restore()
}
