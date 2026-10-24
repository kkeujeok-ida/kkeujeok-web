// Run bookkeeping of a text box being edited (Story 4.10): a typed change keeps the formats of the text around it,
// a format change applies to a code point range. Offsets are code points. Pure, over the spec/text.md normal form.
import { COLOR_DEFAULT, SIZE_DEFAULT, cpLen, normalizeRuns, styleList, type Run } from './textLayout'

type Obj = Record<string, unknown>

export type TextFormat = { size: number | null; bold: boolean; italic: boolean; color: string | null }

/** Maps a UTF-16 index of `text` to a code point index (an index inside a surrogate pair rounds down). */
export const cpIndex = (text: string, utf16: number): number => [...text.slice(0, Math.max(0, utf16))].length

/** The reverse. */
export const utf16Index = (text: string, cp: number): number => [...text].slice(0, Math.max(0, cp)).join('').length

/**
 * The runs of `next` after the text changed from `prev`: the common prefix and suffix keep their formats, the
 * changed part takes the format of the code point before it (else after it) with `typed` laid over.
 */
export function retextRuns(prev: string, next: string, runs: readonly unknown[], typed: Obj = {}, caret?: number): Run[] {
  const a = [...prev], b = [...next]
  const old = styleList(runs, a.length)
  // The change ends at the caret: a suffix longer than the text after it would put the edit on the wrong equal neighbour ("aa").
  const maxS = caret === undefined ? Infinity : Math.max(0, b.length - caret)
  let s = 0
  while (s < a.length && s < b.length && s < maxS && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  let p = 0
  while (p < a.length - s && p < b.length - s && a[p] === b[p]) p++
  // Replacing text (an IME composition) keeps the format of what it replaces, typed format included.
  const inherit = (a.length - s > p ? old[p] : old[p - 1] ?? old[p]) ?? {}
  const out: Obj[] = []
  for (let i = 0; i < p; i++) out.push(old[i]!)
  for (let i = p; i < b.length - s; i++) out.push({ ...structuredClone(inherit), ...typed })
  for (let i = a.length - s; i < a.length; i++) out.push(old[i]!)
  return normalizeRuns(out.map((attrs, i) => ({ ...attrs, start: i, end: i + 1 })), b.length)
}

/** `props` laid over the code points `[start, end)`. */
export function formatRange(runs: readonly unknown[], n: number, start: number, end: number, props: Obj): Run[] {
  return normalizeRuns([...runs, { ...props, start, end }], n)
}

/** The format shown by the bar: of the selection when all agree, else of the code point before the caret; `pending` wins at a caret. */
export function formatAt(el: Obj, text: string, runs: readonly unknown[], sel: readonly [number, number], pending: Obj | null): TextFormat {
  const n = cpLen(text)
  const st = styleList(runs, n)
  const base = {
    size: typeof el.size === 'number' ? el.size : SIZE_DEFAULT,
    bold: el.bold === true,
    italic: el.italic === true,
    color: typeof el.color === 'string' ? el.color : COLOR_DEFAULT,
  }
  const of = (i: number) => ({
    size: typeof st[i]?.size === 'number' ? (st[i]!.size as number) : base.size,
    bold: typeof st[i]?.bold === 'boolean' ? (st[i]!.bold as boolean) : base.bold,
    italic: typeof st[i]?.italic === 'boolean' ? (st[i]!.italic as boolean) : base.italic,
    color: typeof st[i]?.color === 'string' ? (st[i]!.color as string) : base.color,
  })
  const [a, b] = sel[0] <= sel[1] ? sel : [sel[1], sel[0]]
  if (a === b) {
    const f = a > 0 ? of(Math.min(a, n) - 1) : n > 0 ? of(0) : base
    return { ...f, ...(pending as Partial<TextFormat> | null) }
  }
  const all = Array.from({ length: Math.min(b, n) - a }, (_, k) => of(a + k))
  if (all.length === 0) return base
  const same = <K extends keyof TextFormat>(k: K) => (all.every((f) => f[k] === all[0]![k]) ? all[0]![k] : null)
  return { size: same('size'), bold: all.every((f) => f.bold), italic: all.every((f) => f.italic), color: same('color') }
}
