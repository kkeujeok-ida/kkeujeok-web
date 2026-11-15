// Nib icon shapes (spec/tool-icons.md): absolute M L H V Z only, in a 20 x 36 box.
const D: Record<string, string> = {
  pen: 'M3 0V22.3L10 36L17 22.3V0M3 22.3H17',
  highlighter: 'M3 0V36L17 28V0M3 22.3H17',
  fountain: 'M3 0V18L10 36L17 18V0M3 18H17M10 18V26',
  pencil: 'M3 0V28L10 36L17 28V0ZM3 6H17M3 28H17',
  tape: 'M3 8H17V28H3ZM7 14H13M7 22H13',
}
export const penGlyphD = (tool: string): string => D[tool] ?? D.pen!

const RANGE: Record<string, [number, number]> = { pen: [0.5, 10], highlighter: [4, 30], fountain: [0.5, 8], pencil: [0.5, 6], tape: [8, 30] }
export const GRAIN_DOTS: readonly (readonly [number, number])[] = [[6, 20], [10, 21], [14, 20], [8, 25], [12, 25]]

/** Pen slot icon facts (spec/pen-icon.md, rule `pen.icon`). */
export function penIcon(tool: string, color: string, width: number, texture?: string) {
  const silhouette = tool in D ? tool : 'pen'
  const [lo, hi] = RANGE[silhouette]!
  const w = Math.min(hi, Math.max(lo, width))
  const bandStep = 1 + Math.min(4, Math.floor(((w - lo) * 5) / (hi - lo)))
  const resolved = texture === 'none' || texture === 'pencil' ? texture : silhouette === 'pencil' ? 'pencil' : 'none'
  const grain = resolved === 'pencil' && silhouette !== 'highlighter' && silhouette !== 'tape'
  return { silhouette, bodyColor: color, bandStep, grain }
}
