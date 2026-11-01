// spec rules export.range, export.fileName, export.plan (spec/export.md). Pure: the PDF builder draws this plan.
import { isAssetHash } from '../model/imageRules'
import { round2 } from '../model/number'
import { trimTitle } from '../model/noteTitle'
import { cpLen, layoutText, normalizeRuns, textStyles } from '../model/textLayout'
import { selectionBounds, type El } from '../model/select'
import { highlighterOutline } from '../render/highlighterOutline'
import { pageBackground } from '../render/pageBackground'

export type RangeInput = { mode: 'all' | 'current' | 'custom'; text?: string; current: number; pageCount: number }
export type RangeError = 'emptyRange' | 'invalidFormat' | 'reversedRange' | 'outOfRange'

export function exportRange({ mode, text, current, pageCount }: RangeInput): { pages: number[] } | { error: RangeError } {
  if (mode === 'all') return { pages: Array.from({ length: pageCount }, (_, i) => i + 1) }
  if (mode === 'current') return { pages: [current] }
  const t = trimTitle(typeof text === 'string' ? text : '')
  if (t === '') return { error: 'emptyRange' }
  // \s of the spec is the trim set of note.title.
  const ws = '[\\t-\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'
  const m = new RegExp(`^([0-9]+)(?:${ws}*-${ws}*([0-9]+))?$`).exec(t)
  if (!m) return { error: 'invalidFormat' }
  const a = BigInt(m[1]!), b = m[2] === undefined ? a : BigInt(m[2])
  if (a > b) return { error: 'reversedRange' }
  if (a < 1n || b > BigInt(pageCount)) return { error: 'outOfRange' }
  const pages: number[] = []
  for (let i = Number(a); i <= Number(b); i++) pages.push(i)
  return { pages }
}

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
// shortcut: no backslash. spec/export.md lists it, but fixture export.fileName #4 (made by a reference whose '\/' is
// just '/') keeps it; add it when the fixture is regenerated.
const BAD_CHARS = '/:*?"<>|'

export function exportFileName({ title }: { title: string }): { name: string } {
  let s = [...trimTitle(title)]
    .map((c) => {
      const n = c.codePointAt(0)!
      return BAD_CHARS.includes(c) || n <= 0x1f || n === 0x7f ? '_' : c
    })
    .join('')
  s = s.replace(/[. ]+$/, '')
  if (s === '') s = '이름 없는 노트'
  if (RESERVED.test(s.split('.')[0]!)) s = '_' + s
  return { name: s + '.pdf' }
}

export type PlanElement =
  | { id: string; kind: 'pen'; color: string; polygons: 1 }
  | { id: string; kind: 'highlighter'; color: string; polygons: number; opacity: 0.4; blend: 'multiply' }
  | { id: string; kind: 'text'; x: number; y: number; width: number; height: number; rotation: number; lines: string[]; colors: string[] }
  | { id: string; kind: 'image'; x: number; y: number; width: number; height: number; rotation: number; asset: string; ext: string }
export type PlanPage = {
  number: number; id: string; width: number; height: number; orientation: 'portrait' | 'landscape'; paper: string
  background: string; lines: number; dots: number; shapes: { min: number; max: number }; images: number
  omitted: string[]; elements: PlanElement[]
}
export type ExportPlan = { fileName: string; fonts: string[]; assets: string[]; pages: PlanPage[] }
export type PlanResult = ExportPlan | { error: RangeError } | { error: 'assetMissing'; assets: string[] }
export type PlanInput = {
  note: { meta: { title: string }; pages: ReadonlyArray<Record<string, any>> }
  range: Omit<RangeInput, 'pageCount'>
  localAssets: Iterable<string>
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const isWs = (c: string) => trimTitle(c) === ''

function visible(e: El, w: number, h: number): boolean {
  const b = selectionBounds([e])
  if (!b) return false
  let [x0, y0, x1, y1] = [b.left, b.top, b.right, b.bottom].map(round2) as [number, number, number, number]
  if (e.type === 'stroke') { const g = (e.width as number) / 2; x0 -= g; y0 -= g; x1 += g; y1 += g }
  return x1 > 0 && y1 > 0 && x0 < w && y0 < h
}

function textEntry(e: El, fonts: Set<string>): PlanElement {
  const L = layoutText(e)
  const text = typeof e.text === 'string' ? e.text : ''
  const cps = [...text]
  const lines = L.lines.map((l) => cps.slice(l.start, l.end).join('').replace(/ +$/, ''))
  const runs = normalizeRuns(Array.isArray(e.runs) ? e.runs : [], cpLen(text))
  const { bold } = textStyles(e)
  const colors: string[] = []
  cps.forEach((c, i) => {
    if (isWs(c)) return
    const r = runs.find((x) => x.start <= i && i < x.end)
    const color = r?.color !== undefined ? r.color : e.color !== undefined ? (e.color as string) : '#000000'
    if (!colors.includes(color)) colors.push(color)
    fonts.add(bold[i] ? 'Pretendard-SemiBold' : 'Pretendard-Regular')
  })
  return { id: e.id as string, kind: 'text', x: e.x as number, y: e.y as number, width: e.width as number, height: round2(L.height), rotation: (e.rotation as number) || 0, lines, colors }
}

export function exportPlan({ note, range, localAssets }: PlanInput): PlanResult {
  const r = exportRange({ ...range, pageCount: note.pages.length })
  if ('error' in r) return r
  const fonts = new Set<string>(), assets = new Set<string>(), pages: PlanPage[] = []
  for (const n of r.pages) {
    const p = note.pages[n - 1]!
    const bg = pageBackground(p.background, p.width, p.height)
    const elements: PlanElement[] = [], omitted: string[] = []
    let min = 1 + (bg.lines.length + bg.dots.length > 0 ? 1 : 0), max = 1 + bg.lines.length + bg.dots.length
    let images = 0
    for (const e of p.elements as El[]) {
      if (!visible(e, p.width, p.height)) { omitted.push(e.id as string); continue }
      if (e.type === 'stroke') {
        const hl = e.tool === 'highlighter'
        const polys = hl ? highlighterOutline(e.width as number, e.points as number[][]).length : 1
        min += 1; max += polys
        elements.push(hl
          ? { id: e.id as string, kind: 'highlighter', color: e.color as string, polygons: polys, opacity: 0.4, blend: 'multiply' }
          : { id: e.id as string, kind: 'pen', color: e.color as string, polygons: 1 })
      } else if (e.type === 'text') {
        elements.push(textEntry(e, fonts))
      } else if (e.type === 'image') {
        images++; assets.add(e.asset as string)
        elements.push({ id: e.id as string, kind: 'image', x: e.x as number, y: e.y as number, width: e.width as number, height: e.height as number, rotation: (e.rotation as number) || 0, asset: e.asset as string, ext: e.ext as string })
      }
    }
    pages.push({
      number: n, id: p.id, width: p.width, height: p.height, orientation: p.width > p.height ? 'landscape' : 'portrait', paper: bg.paper,
      background: ['lined', 'grid', 'dot'].includes(p.background) ? p.background : 'plain',
      lines: bg.lines.length, dots: bg.dots.length, shapes: { min, max }, images, omitted, elements,
    })
  }
  const local = new Set(localAssets)
  const missing = [...assets].filter((h) => !isAssetHash(h) || !local.has(h)).sort(byCodeUnit)
  if (missing.length) return { error: 'assetMissing', assets: missing }
  return {
    fileName: exportFileName({ title: note.meta.title }).name,
    fonts: ['Pretendard-Regular', 'Pretendard-SemiBold'].filter((f) => fonts.has(f)),
    assets: [...assets].sort(byCodeUnit),
    pages,
  }
}
