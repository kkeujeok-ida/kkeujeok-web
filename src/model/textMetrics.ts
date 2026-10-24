// Advance widths of the two bundled Pretendard files (spec/text.md "Font"). The table is generated from the
// OTF files of spec/decisions/text-font.md (scripts/gen-font-advances.mjs refuses any other SHA-256).
import { FONT_ADVANCES, type FontTable } from './fontAdvances.generated'

class FontAdvances {
  readonly upm: number
  private map = new Map<number, number>()
  private notdef: number
  constructor(t: FontTable) {
    this.upm = t.upm
    this.notdef = t.notdef
    for (const [start, advs] of t.runs) advs.forEach((a, i) => this.map.set(start + i, a))
  }
  /** `hmtx` advance (font units) of the glyph the `cmap` gives for `cp`; `.notdef` when absent. */
  advance(cp: number): number {
    return this.map.get(cp) ?? this.notdef
  }
}

let regular: FontAdvances | undefined
let bold: FontAdvances | undefined

export const fontAdvances = (isBold: boolean): FontAdvances =>
  isBold ? (bold ??= new FontAdvances(FONT_ADVANCES.bold)) : (regular ??= new FontAdvances(FONT_ADVANCES.regular))
