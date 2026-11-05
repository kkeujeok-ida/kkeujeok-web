// Spec rules of spec/pdf.md: pdf.pageBox, pdf.pageMatrix (+ pagePoint), pdf.import, pdf.pageDisplay and the PDF
// background checks. Pure (port of the Android lib/model/pdf_rules.dart).
import { assetState, isAssetHash } from './imageRules'
import { MAX_TITLE_LENGTH, trimTitle } from './noteTitle'
import { round2 } from './number'

export const PDF_MAX_BYTES = 104_857_600
export const PDF_MAX_PAGES = 500
/** First 5 bytes of a PDF (`%PDF-`) as hex. */
export const PDF_HEAD_HEX = '255044462d'

const PATTERNS = ['plain', 'lined', 'grid', 'dot']
type Obj = Record<string, unknown>
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const rect = (v: unknown): v is number[] => Array.isArray(v) && v.length === 4 && v.every(num)

/** A background object with `type: "pdf"`, well formed or not. */
export const isPdfRef = (bg: unknown): bg is Obj => typeof bg === 'object' && bg !== null && !Array.isArray(bg) && (bg as Obj).type === 'pdf'

/** A well-formed PDF reference; a malformed one is read as `plain`. */
export function isPdfBackground(bg: unknown): bg is Obj & { asset: string; page: number; box: number[]; rotate: number; userUnit: number } {
  if (!isPdfRef(bg)) return false
  const { asset, page, box, rotate, userUnit } = bg
  return (
    isAssetHash(asset) && typeof page === 'number' && Number.isInteger(page) && page >= 0 &&
    rect(box) && box[0]! < box[2]! && box[1]! < box[3]! &&
    (rotate === 0 || rotate === 90 || rotate === 180 || rotate === 270) &&
    num(userUnit) && userUnit > 0
  )
}

/** The pattern a page background draws as: the string when known, else `plain` (a PDF object is drawn plain until 9.5). */
export const patternOf = (bg: unknown): string => (typeof bg === 'string' && PATTERNS.includes(bg) ? bg : 'plain')

/** A background value a client reads: a pattern or a PDF object. */
export const isKnownBackground = (bg: unknown): boolean => (typeof bg === 'string' && PATTERNS.includes(bg)) || isPdfRef(bg)

function norm(r: unknown): number[] | null {
  if (!rect(r)) return null
  return [Math.min(r[0]!, r[2]!), Math.min(r[1]!, r[3]!), Math.max(r[0]!, r[2]!), Math.max(r[1]!, r[3]!)]
}

export type PageBoxIn = { mediaBox?: unknown; cropBox?: unknown; rotate?: unknown; userUnit?: unknown }
export type PageBox = { box: number[]; rotate: number; userUnit: number; width: number; height: number }

/** `pdf.pageBox`. */
export function pdfPageBox(i: PageBoxIn): PageBox | { error: 'corrupt' } {
  const m = norm(i.mediaBox)
  if (!m) return { error: 'corrupt' }
  const c = i.cropBox === undefined || i.cropBox === null ? m : norm(i.cropBox)
  if (!c) return { error: 'corrupt' }
  const b = [Math.max(c[0]!, m[0]!), Math.max(c[1]!, m[1]!), Math.min(c[2]!, m[2]!), Math.min(c[3]!, m[3]!)]
  if (!(b[2]! - b[0]! > 0 && b[3]! - b[1]! > 0)) return { error: 'corrupt' }
  const rv = i.rotate
  const rotate = num(rv) && rv % 90 === 0 ? (((rv % 360) + 360) % 360) : 0
  let u = num(i.userUnit) && i.userUnit > 0 ? round2(i.userUnit) : 1
  if (u <= 0) u = 1
  const w = b[2]! - b[0]!, h = b[3]! - b[1]!
  const swap = rotate === 90 || rotate === 270
  return { box: b.map(round2), rotate, userUnit: u, width: round2((swap ? h : w) * u), height: round2((swap ? w : h) * u) }
}

/** `pdf.pageMatrix`: a page point (pt, top-left origin) to PDF user space. */
export function pdfPageMatrix(box: number[], rotate: number, userUnit: number, [x, y]: number[]): number[] {
  const [x0, y0, x1, y1] = box as [number, number, number, number]
  const a = x! / userUnit, b = y! / userUnit
  const p = rotate === 90 ? [x0 + b, y0 + a] : rotate === 180 ? [x1 - a, y0 + b] : rotate === 270 ? [x1 - b, y1 - a] : [x0 + a, y1 - b]
  return p.map(round2)
}

/** Inverse of `pdfPageMatrix` (`pagePoint`). */
export function pdfPagePoint(box: number[], rotate: number, userUnit: number, [X, Y]: number[]): number[] {
  const [x0, y0, x1, y1] = box as [number, number, number, number]
  const [a, b] = rotate === 90 ? [Y! - y0, X! - x0] : rotate === 180 ? [x1 - X!, Y! - y0] : rotate === 270 ? [y1 - Y!, x1 - X!] : [X! - x0, y1 - Y!]
  return [round2(a * userUnit), round2(b * userUnit)]
}

/** The title of an imported file (spec `pdf.import` "Title"). */
export function pdfImportTitle(fileName: string): string {
  let s = fileName
  if (s.toLowerCase().endsWith('.pdf')) s = s.slice(0, -4)
  s = trimTitle(s)
  const cps = [...s]
  if (cps.length > MAX_TITLE_LENGTH) s = trimTitle(cps.slice(0, MAX_TITLE_LENGTH).join(''))
  return s === '' ? '이름 없는 노트' : s
}

export type ImportError = 'notPdf' | 'tooLarge' | 'encrypted' | 'corrupt' | 'tooManyPages'
export type PdfParse = { status: 'ok'; encrypted?: boolean; pages: PageBoxIn[] } | { status: 'corrupt' } | { status: 'encrypted' }
export type PdfImportIn = { fileName: string; size: number; head: string; sha256: string; parse: PdfParse }
export type PdfImportOut = { title: string; asset: string; pages: { width: number; height: number; background: Obj }[] }

/** `pdf.import`. */
export function pdfImport(i: PdfImportIn): PdfImportOut | { error: ImportError } {
  if (i.head !== PDF_HEAD_HEX) return { error: 'notPdf' }
  if (i.size > PDF_MAX_BYTES) return { error: 'tooLarge' }
  const p = i.parse
  if (p.status === 'encrypted' || (p.status === 'ok' && p.encrypted === true)) return { error: 'encrypted' }
  if (p.status !== 'ok' || !Array.isArray(p.pages) || p.pages.length === 0) return { error: 'corrupt' }
  if (p.pages.length > PDF_MAX_PAGES) return { error: 'tooManyPages' }
  const pages: PdfImportOut['pages'] = []
  for (const [n, src] of p.pages.entries()) {
    const g = pdfPageBox(src)
    if ('error' in g) return g
    pages.push({ width: g.width, height: g.height, background: { type: 'pdf', asset: i.sha256, page: n, box: g.box, rotate: g.rotate, userUnit: g.userUnit } })
  }
  return { title: pdfImportTitle(i.fileName), asset: i.sha256, pages }
}

/** `pdf.pageDisplay`. */
export function pdfPageDisplay(i: { page: { background?: unknown }; local: string[]; failed: string[] }) {
  const bg = i.page.background
  if (!isPdfBackground(bg)) return { layer: 'pattern', state: null }
  return { layer: 'pdf', state: assetState(bg.asset, i.local, i.failed), invertPdf: false, invertElements: false }
}
