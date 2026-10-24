// spec/text.md: constants, normal form of runs, text.layout (port of the Android lib/model/text_layout.dart).
import { round2 } from './number'
import { fontAdvances } from './textMetrics'

export const SIZE_MIN = 8, SIZE_MAX = 96, SIZE_DEFAULT = 16
export const SIZE_STEPS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 96] as const
export const COLOR_DEFAULT = '#000000'
export const LINE_HEIGHT = 1.4, BASELINE = 1.1, ITALIC_SKEW = 0.2, WIDTH_MIN = 20

type Obj = Record<string, unknown>
export type Run = { start: number; end: number; size?: number; color?: string; bold?: boolean; italic?: boolean; [k: string]: unknown }
export type LineBox = { start: number; end: number; width: number; top: number; baseline: number; height: number }
export type TextLayout = { height: number; lines: LineBox[] }

const cpSet = (s: string) => new Set([...s].map((c) => c.codePointAt(0)!))
const FORBID_START = cpSet('.,!?:;)]}%、。，．）」』…”’》〕')
const NO_BREAK_AFTER = cpSet('([{「『“‘《〔')

export const isZeroWidth = (c: number) => (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef)

const isCjk = (c: number) =>
  (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0x3130 && c <= 0x318f) ||
  (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3) ||
  (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x2fa1f)

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const cpLen = (s: string) => [...s].length

// The trim set of note.title (spec/ops.md "Text box operations").
const BLANK = new Set([0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i)])
export const isBlankText = (t: string) => [...t].every((c) => BLANK.has(c.codePointAt(0)!))

/** `\r\n` and a lone `\r` become `\n`. */
export const normalizeNewlines = (t: string) => t.replace(/\r\n?/g, '\n')

export function validRuns(runs: unknown): boolean {
  if (!Array.isArray(runs)) return false
  return runs.every(
    (r) =>
      isObj(r) &&
      Number.isInteger(r.start) && Number.isInteger(r.end) &&
      (r.size === undefined || (finite(r.size) && round2(r.size) >= SIZE_MIN && round2(r.size) <= SIZE_MAX)) &&
      (r.color === undefined || (typeof r.color === 'string' && /^#[0-9a-f]{6}$/.test(r.color))) &&
      (r.bold === undefined || typeof r.bold === 'boolean') &&
      (r.italic === undefined || typeof r.italic === 'boolean'),
  )
}

// Deep structural equality ignoring key order.
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.keys(v).sort().map((k) => [k, canon(v[k])]) : v)
const stable = (o: unknown) => JSON.stringify(canon(o))

// Code point i gets the merge of every run covering it, later runs winning.
export function styleList(runs: readonly unknown[], n: number): Obj[] {
  const st: Obj[] = Array.from({ length: n }, () => ({}))
  for (const r of runs) {
    const { start, end, ...attrs } = r as Run
    if (typeof attrs.size === 'number') attrs.size = round2(attrs.size)
    for (let i = Math.max(0, start); i < Math.min(n, end); i++) Object.assign(st[i]!, structuredClone(attrs))
  }
  return st
}

/** `normalizeRuns(runs, n)` of spec/text.md. */
export function normalizeRuns(runs: readonly unknown[], n: number): Run[] {
  const st = styleList(runs, n)
  const out: { start: number; end: number; attrs: Obj }[] = []
  for (let i = 0; i < n; i++) {
    const a = st[i]!
    if (!Object.keys(a).length) continue
    const last = out[out.length - 1]
    if (last && last.end === i && stable(last.attrs) === stable(a)) last.end = i + 1
    else out.push({ start: i, end: i + 1, attrs: a })
  }
  return out.map(({ start, end, attrs }) => {
    const o: Run = { start, end }
    for (const k of Object.keys(attrs).sort()) o[k] = attrs[k]
    return o
  })
}

const fixSize = (v: unknown) => (finite(v) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)) : SIZE_DEFAULT)
const textOf = (e: Obj) => (typeof e.text === 'string' ? e.text : '')

/** Per code point size and bold after the clamps of spec/text.md, and the element's default size. */
export function textStyles(e: Obj) {
  const n = cpLen(textOf(e))
  const base = fixSize(e.size)
  const st = styleList(Array.isArray(e.runs) ? e.runs : [], n)
  return {
    base,
    size: st.map((s) => (s.size === undefined ? base : fixSize(s.size))),
    bold: st.map((s) => (typeof s.bold === 'boolean' ? s.bold : e.bold === true)),
  }
}

/** `text.layout` of a text element. */
export function layoutText(e: Obj): TextLayout {
  const cps = [...textOf(e)].map((c) => c.codePointAt(0)!)
  const n = cps.length
  const { base, size, bold } = textStyles(e)
  const W = finite(e.width) ? Math.max(WIDTH_MIN, e.width) : WIDTH_MIN
  const adv = (i: number) => {
    const c = cps[i]!
    if (isZeroWidth(c)) return 0
    const f = fontAdvances(bold[i]!)
    return (f.advance(c) * size[i]!) / f.upm
  }
  const canBreakAfter = (i: number) => {
    const c = cps[i]!, d = cps[i + 1]!
    if (NO_BREAK_AFTER.has(c)) return false
    if (d === 0x20 || d === 0x0a || FORBID_START.has(d)) return false
    if (c === 0x20 || c === 0x2d) return true
    return isCjk(c) || isCjk(d)
  }
  const lines: LineBox[] = []
  let s = 0, top = 0
  for (;;) {
    let x = 0, hasContent = false, lastBreak = -1, end = n, forced = false
    for (let i = s; i < n; i++) {
      if (cps[i] === 0x0a) { end = i; forced = true; break }
      const a = adv(i)
      if (cps[i] === 0x20) {
        x += a
        if (hasContent && i < n - 1 && canBreakAfter(i)) lastBreak = i + 1
        continue
      }
      if (hasContent && x + a > W) { end = lastBreak >= 0 ? lastBreak : i; break }
      x += a
      hasContent = true
      if (i < n - 1 && canBreakAfter(i)) lastBreak = i + 1
    }
    let acc = 0, trimmed = 0
    let max: number | undefined
    for (let k = s; k < end; k++) {
      acc += adv(k)
      if (cps[k] !== 0x20) trimmed = acc
      max = max === undefined ? size[k]! : Math.max(max, size[k]!)
    }
    if (forced) max = max === undefined ? size[end]! : Math.max(max, size[end]!)
    max ??= base
    const lh = max * LINE_HEIGHT
    lines.push({ start: s, end, width: round2(trimmed), top: round2(top), baseline: round2(top + max * BASELINE), height: round2(lh) })
    top += lh
    if (end >= n && !forced) break
    s = forced ? end + 1 : end
  }
  return { height: round2(top), lines }
}

export const textHeight = (e: Obj) => layoutText(e).height
