// Draws a text box line by line from the spec layout (spec/text.md): the glyphs of a style group start where the
// layout widths put them, bold is Pretendard SemiBold (600), italic is a shear of `italicSkew` at the baseline.
import { COLOR_DEFAULT, ITALIC_SKEW, WIDTH_MIN, cpLen, isZeroWidth, layoutText, normalizeRuns, textStyles } from '../model/textLayout'
import { fontAdvances } from '../model/textMetrics'

type El = Record<string, unknown>
const COLOR = /^#[0-9a-f]{6}$/

/** A text element that can be drawn. */
export const drawableText = (e: unknown): e is El => !!e && typeof e === 'object' && (e as El).type === 'text' && typeof (e as El).text === 'string'

/** Paints `e` with its top-left (before rotation) at the page origin of `ctx`; it turns about the box center. */
export function paintTextBox(ctx: CanvasRenderingContext2D, e: El): void {
  const lay = layoutText(e)
  const cps = [...(e.text as string)].map((c) => c.codePointAt(0)!)
  const { size, bold } = textStyles(e)
  const italic = new Array<boolean>(cps.length).fill(e.italic === true)
  const color = new Array<string>(cps.length).fill(typeof e.color === 'string' && COLOR.test(e.color) ? e.color : COLOR_DEFAULT)
  for (const r of normalizeRuns(Array.isArray(e.runs) ? e.runs : [], cpLen(e.text as string))) {
    for (let i = r.start; i < r.end; i++) {
      if (typeof r.italic === 'boolean') italic[i] = r.italic
      if (typeof r.color === 'string' && COLOR.test(r.color)) color[i] = r.color
    }
  }
  const key = (i: number) => `${italic[i] ? 'i' : 'n'}|${size[i]}|${bold[i]}|${color[i]}`
  const x = e.x as number, y = e.y as number
  const w = Math.max(WIDTH_MIN, Number.isFinite(e.width) ? (e.width as number) : WIDTH_MIN)
  const rot = typeof e.rotation === 'number' ? e.rotation : 0
  ctx.save()
  try {
    if (rot) {
      const cx = x + w / 2, cy = y + lay.height / 2
      ctx.translate(cx, cy)
      ctx.rotate((rot * Math.PI) / 180)
      ctx.translate(-cx, -cy)
    }
    ctx.textBaseline = 'alphabetic'
    for (const line of lay.lines) {
      let gx = x
      let i = line.start
      while (i < line.end) {
        let j = i
        let width = 0
        while (j < line.end && key(j) === key(i)) {
          if (!isZeroWidth(cps[j]!)) {
            const f = fontAdvances(bold[j]!)
            width += (f.advance(cps[j]!) * size[j]!) / f.upm
          }
          j++
        }
        const group = String.fromCodePoint(...cps.slice(i, j))
        if (group.trim() !== '') {
          ctx.save()
          ctx.translate(gx, y + line.baseline)
          if (italic[i]) ctx.transform(1, 0, -ITALIC_SKEW, 1, 0, 0)
          ctx.font = `${bold[i] ? 600 : 400} ${size[i]}px Pretendard, system-ui, sans-serif`
          ctx.fillStyle = color[i]!
          ctx.fillText(group, 0, 0)
          ctx.restore()
        }
        gx += width
        i = j
      }
    }
  } finally {
    ctx.restore()
  }
}
