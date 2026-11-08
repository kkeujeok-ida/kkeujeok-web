// "Range -> PDF Blob" (spec/export.md). No UI here, so print (Story 8.4) can reuse it. It draws `exportPlan` from the
// working copy of the note, with the same outline / layout functions as the screen. Nothing is read from Drive.
import { PDFDocument, PDFHexString, PDFName, type PDFEmbeddedPage, type PDFFont, type PDFImage, type PDFOperator } from 'pdf-lib'
import {
  appendBezierCurve, beginText, clip, closePath, concatTransformationMatrix, drawObject, endPath, endText, fill, lineTo, moveTo,
  popGraphicsState, pushGraphicsState, rectangle, setFillingRgbColor, setFontAndSize, setGraphicsState, setLineWidth,
  setStrokingRgbColor, setTextMatrix, showText, stroke,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { COLOR_DEFAULT, ITALIC_SKEW, WIDTH_MIN, cpLen, isZeroWidth, layoutText, normalizeRuns, textStyles } from '../model/textLayout'
import { isPdfBackground, patternOf } from '../model/pdfRules'
import { fontAdvances } from '../model/textMetrics'
import { highlighterOutline, windAlike } from '../render/highlighterOutline'
import { pageBackground } from '../render/pageBackground'
import { pencilDensity } from '../render/pencilTexture'
import { meanPressure, strokeOutlineFor } from '../render/strokeOutline'
import { exportPlan, type PlanInput, type PlanResult, type RangeError } from './exportRules'

type El = Record<string, any>
export type PdfFonts = { regular: Uint8Array; semibold: Uint8Array }
export type AssetSource = { get(hash: string): Promise<{ ext: string; bytes: Uint8Array } | null> }

export type PdfJob = {
  note: PlanInput['note']
  range: PlanInput['range']
  assets: AssetSource
  /** The Pretendard files (OTF/TTF/WOFF2); read only when a text box needs them. */
  fonts: () => Promise<PdfFonts>
  /** WebP is not a PDF image type: the client turns it into PNG bytes. */
  webpToPng?: (bytes: Uint8Array) => Promise<Uint8Array>
  /** PNG bytes of a tape page at w x h px (spec "Answer tape"); none makes a tape page fail. */
  rasterPage?: (page: El, w: number, h: number, assets: AssetSource) => Promise<Uint8Array | null>
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}
export type PdfResult =
  | { ok: true; blob: Blob; fileName: string; pages: number }
  | { ok: false; error: RangeError | 'assetMissing'; assets?: string[]; pdfAssets?: string[] }

export class ExportCancelled extends Error {
  constructor() {
    super('export cancelled')
    this.name = 'ExportCancelled'
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/
const rgb = (c: unknown): [number, number, number] => {
  const s = typeof c === 'string' && HEX.test(c) ? c : COLOR_DEFAULT
  return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255]
}
const fillRgb = (c: unknown) => setFillingRgbColor(...rgb(c))

/** `cm` that turns about (cx, cy) clockwise by `deg` in the page's y-down space (the canvas `rotate`). */
function turn(cx: number, cy: number, deg: number): PDFOperator {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return concatTransformationMatrix(c, s, -s, c, cx - cx * c + cy * s, cy - cx * s - cy * c)
}

function polygon(ops: PDFOperator[], pts: readonly (readonly number[])[]): void {
  pts.forEach((p, i) => ops.push(i === 0 ? moveTo(p[0]!, p[1]!) : lineTo(p[0]!, p[1]!)))
  ops.push(closePath())
}

function circle(ops: PDFOperator[], x: number, y: number, r: number): void {
  const k = 0.5522847498 * r
  ops.push(moveTo(x + r, y), appendBezierCurve(x + r, y + k, x + k, y + r, x, y + r), appendBezierCurve(x - k, y + r, x - r, y + k, x - r, y),
    appendBezierCurve(x - r, y - k, x - k, y - r, x, y - r), appendBezierCurve(x + k, y - r, x + r, y - k, x + r, y), closePath())
}

// shortcut: reaches into pdf-lib's embedder (fontkit font), pinned at 1.17.1. The whole font is embedded (about
// 0.8 MB deflated per weight): the fontkit subsetter writes a broken glyf table for Pretendard. pdf-lib's own encodeText
// runs fontkit's Hangul shaper, which splits a syllable into jamo glyphs we do not position; the canvas and the layout
// widths use one glyph per code point, so the PDF does too. Re-check both when pdf-lib / fontkit change.
async function embedFont(doc: PDFDocument, data: Uint8Array): Promise<PDFFont> {
  const font = await doc.embedFont(data, { subset: false })
  const e = (font as unknown as { embedder: Record<string, any> }).embedder
  e.encodeText = (text: string) =>
    PDFHexString.of([...text].map((c) => (e.font.glyphForCodePoint(c.codePointAt(0)!).id as number).toString(16).padStart(4, '0')).join(''))
  return font
}

/**
 * `cm` that puts the original PDF page (PDF user space) on the output page [0 0 width height], y up: the inverse of
 * `pdf.pageMatrix`, so the visible box fills the page exactly and element coordinates share the same ground.
 */
export function groundMatrix(box: number[], rotate: number, userUnit: number, height: number): number[] {
  const [x0, y0, x1, y1] = box as [number, number, number, number]
  const u = userUnit, H = height
  if (rotate === 90) return [0, -u, u, 0, -y0 * u, H + x0 * u]
  if (rotate === 180) return [-u, 0, 0, -u, x1 * u, H + y0 * u]
  if (rotate === 270) return [0, u, -u, 0, y1 * u, H - x1 * u]
  return [u, 0, 0, u, -x0 * u, H - y1 * u]
}

const EMBED_CHUNK = 25 // original pages copied per call; the tab gets its turn between calls
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export async function buildPdf(job: PdfJob): Promise<PdfResult> {
  const gone = () => {
    if (job.signal?.aborted) throw new ExportCancelled()
  }
  gone()
  // Pass 1 with no local assets only lists the assets the range needs (or ends on a range error / needs none).
  let plan: PlanResult = exportPlan({ ...job, localAssets: [] })
  const bytes = new Map<string, { ext: string; bytes: Uint8Array }>()
  if ('error' in plan && plan.error === 'assetMissing') {
    for (const h of plan.assets) {
      const rec = await job.assets.get(h)
      if (rec) bytes.set(h, rec)
      gone()
    }
    plan = exportPlan({ ...job, localAssets: bytes.keys() })
  }
  if ('error' in plan) return { ok: false, error: plan.error, ...('assets' in plan && { assets: plan.assets }), ...('pdfAssets' in plan && { pdfAssets: plan.pdfAssets }) }

  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setProducer('Kkeujeok')
  doc.setCreator('Kkeujeok')
  const fonts: { regular?: PDFFont; semibold?: PDFFont } = {}
  if (plan.fonts.length) {
    const f = await job.fonts()
    gone()
    if (plan.fonts.includes('Pretendard-Regular')) fonts.regular = await embedFont(doc, f.regular)
    if (plan.fonts.includes('Pretendard-SemiBold')) fonts.semibold = await embedFont(doc, f.semibold)
  }
  const images = new Map<string, PDFImage>()
  for (const h of plan.assets) {
    const rec = bytes.get(h)!
    let data = rec.bytes
    if (rec.ext === 'webp') {
      if (!job.webpToPng) throw new Error('webp needs a decoder')
      data = await job.webpToPng(data)
    }
    images.set(h, rec.ext === 'jpg' || rec.ext === 'jpeg' ? await doc.embedJpg(data) : await doc.embedPng(data))
    gone()
  }
  // Original PDF pages: each source file is loaded once; the pages the range uses are copied in chunks (no rasterising).
  const srcDocs = new Map<string, PDFDocument>()
  const grounds = new Map<string, PDFEmbeddedPage>()
  const wanted = plan.pages.flatMap((pp) => {
    const bg = job.note.pages[pp.number - 1]!.background
    return isPdfBackground(bg) && pp.pdf ? [bg] : [] // a tape page draws its PDF into the raster
  })
  const embedFrom = async (i: number) => {
    const first = wanted[i]!
    let src = srcDocs.get(first.asset)
    if (!src) srcDocs.set(first.asset, (src = await PDFDocument.load(bytes.get(first.asset)!.bytes, { updateMetadata: false })))
    const pick = new Map<string, (typeof wanted)[number]>()
    for (let k = i; k < wanted.length && pick.size < EMBED_CHUNK; k++) {
      const w = wanted[k]!
      const key = `${w.asset}:${w.page}`
      if (w.asset === first.asset && !grounds.has(key)) pick.set(key, w)
    }
    const entries = [...pick]
    const srcPages = entries.map(([, w]) => {
      if (w.page >= src!.getPageCount()) throw new Error('pdf page missing')
      return src!.getPage(w.page)
    })
    const ident = entries.map((): [number, number, number, number, number, number] => [1, 0, 0, 1, 0, 0])
    const boxes = entries.map(([, w]) => ({ left: w.box[0]!, bottom: w.box[1]!, right: w.box[2]!, top: w.box[3]! }))
    const emb = await doc.embedPages(srcPages, boxes, ident)
    entries.forEach(([key], k) => grounds.set(key, emb[k]!))
    await tick()
    gone()
  }
  let nextGround = 0
  const multiply = doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: 0.4, ca: 0.4, BM: 'Multiply' }))

  let done = 0
  job.onProgress?.(0, plan.pages.length)
  for (const pp of plan.pages) {
    const np = job.note.pages[pp.number - 1] as El
    const page = doc.addPage([pp.width, pp.height])
    const first = pp.elements[0]
    if (first?.kind === 'raster') {
      // one flat picture, nothing else
      const png = await job.rasterPage?.(np, first.width_px, first.height_px, job.assets)
      gone()
      if (!png) throw new Error(`raster of page ${pp.number} failed`)
      page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: pp.width, height: pp.height })
      job.onProgress?.(++done, plan.pages.length)
      await tick()
      gone()
      continue
    }
    const fontName = new Map<PDFFont, PDFName>()
    const nameOf = (f: PDFFont) => fontName.get(f) ?? (fontName.set(f, page.node.newFontDictionary(f.name, f.ref)), fontName.get(f)!)
    const gs = page.node.newExtGState('Mul', multiply)
    const keep = new Map(pp.elements.flatMap((e) => (e.kind === 'raster' ? [] : [[e.id, e] as const])))
    // Everything below is in the note's y-down space; the clip is the page.
    const ops: PDFOperator[] = []
    const ref = isPdfBackground(np.background) ? np.background : null
    if (ref) {
      const key = `${ref.asset}:${ref.page}`
      if (!grounds.has(key)) await embedFrom(nextGround)
      nextGround++
      const [a, b, c, d, e, f] = groundMatrix(ref.box, ref.rotate, ref.userUnit, pp.height) as [number, number, number, number, number, number]
      ops.push(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f), drawObject(page.node.newXObject('Pdf', grounds.get(key)!.ref)), popGraphicsState())
    }
    ops.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, pp.height), rectangle(0, 0, pp.width, pp.height), clip(), endPath())
    // a PDF page has no paper: the original page is the ground
    if (!ref) ops.push(fillRgb('#ffffff'), rectangle(0, 0, pp.width, pp.height), fill())
    const bg = ref ? { lines: [], dots: [], lineColor: '', lineWidth: 0, dotColor: '', dotRadius: 0 } : pageBackground(patternOf(np.background), pp.width, pp.height)
    if (bg.lines.length) {
      ops.push(setStrokingRgbColor(...rgb(bg.lineColor)), setLineWidth(bg.lineWidth))
      for (const [x1, y1, x2, y2] of bg.lines) ops.push(moveTo(x1!, y1!), lineTo(x2!, y2!))
      ops.push(stroke())
    }
    if (bg.dots.length) {
      ops.push(fillRgb(bg.dotColor))
      for (const [x, y] of bg.dots) circle(ops, x!, y!, bg.dotRadius)
      ops.push(fill())
    }
    for (const e of np.elements as El[]) {
      const pe = keep.get(e.id)
      if (!pe) continue
      if (pe.kind === 'pen' || pe.kind === 'fountain' || pe.kind === 'pencil') {
        const poly = strokeOutlineFor(e.tool, e.width, e.usePressure, e.points, 'normal') // a file does not depend on a device setting
        if (poly.length) {
          // pencil: one path at the mean density alpha, never cells (spec "Pencil")
          const a = pe.kind === 'pencil' ? pencilDensity(meanPressure(e.usePressure, e.points, 'normal')).density : 1
          ops.push(pushGraphicsState())
          if (a !== 1) ops.push(setGraphicsState(page.node.newExtGState('Pc', doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: a })))))
          ops.push(fillRgb(e.color))
          polygon(ops, poly)
          ops.push(fill(), popGraphicsState())
        }
      } else if (pe.kind === 'highlighter') {
        // all rectangles of one stroke are one layer: one fill, one alpha
        ops.push(pushGraphicsState(), setGraphicsState(gs), fillRgb(e.color))
        for (const rect of windAlike(highlighterOutline(e.width, e.points))) polygon(ops, rect)
        ops.push(fill(), popGraphicsState())
      } else if (pe.kind === 'text') {
        drawText(ops, e, fonts, nameOf)
      } else {
        const img = images.get(pe.asset)!
        const name = page.node.newXObject('Img', img.ref)
        ops.push(pushGraphicsState())
        if (pe.rotation) ops.push(turn(pe.x + pe.width / 2, pe.y + pe.height / 2, pe.rotation))
        // the unit square, upright in y-down space
        ops.push(concatTransformationMatrix(pe.width, 0, 0, -pe.height, pe.x, pe.y + pe.height), drawObject(name), popGraphicsState())
      }
    }
    ops.push(popGraphicsState())
    page.pushOperators(...ops)
    job.onProgress?.(++done, plan.pages.length)
    await tick() // the tab gets its turn after every page
    gone()
  }
  const out = await doc.save({ useObjectStreams: false }) // pdf-lib yields to the event loop every 50 objects
  gone()
  return { ok: true, blob: new Blob([out as BlobPart], { type: 'application/pdf' }), fileName: plan.fileName, pages: plan.pages.length }
}

function drawText(ops: PDFOperator[], e: El, fonts: { regular?: PDFFont; semibold?: PDFFont }, nameOf: (f: PDFFont) => PDFName): void {
  const lay = layoutText(e)
  const cps = [...(e.text as string)].map((c) => c.codePointAt(0)!)
  const { size, bold } = textStyles(e)
  const italic = new Array<boolean>(cps.length).fill(e.italic === true)
  const color = new Array<string>(cps.length).fill(typeof e.color === 'string' && HEX.test(e.color) ? e.color : COLOR_DEFAULT)
  for (const r of normalizeRuns(Array.isArray(e.runs) ? e.runs : [], cpLen(e.text))) {
    for (let i = r.start; i < r.end; i++) {
      if (typeof r.italic === 'boolean') italic[i] = r.italic
      if (typeof r.color === 'string' && HEX.test(r.color)) color[i] = r.color
    }
  }
  const key = (i: number) => `${italic[i] ? 'i' : 'n'}|${size[i]}|${bold[i]}|${color[i]}`
  const w = Math.max(WIDTH_MIN, Number.isFinite(e.width) ? e.width : WIDTH_MIN)
  ops.push(pushGraphicsState())
  if (e.rotation) ops.push(turn(e.x + w / 2, e.y + lay.height / 2, e.rotation))
  for (const line of lay.lines) {
    let gx = e.x
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
      const group = String.fromCodePoint(...cps.slice(i, j).filter((c) => !isZeroWidth(c) && c >= 0x20 && c !== 0x7f))
      const font = bold[i] ? fonts.semibold : fonts.regular
      if (group.trim() !== '' && font) {
        // text matrix: y flipped back so the glyphs stand upright; italic shears along x at the baseline
        ops.push(pushGraphicsState(), fillRgb(color[i]), beginText(), setFontAndSize(nameOf(font), size[i]!),
          setTextMatrix(1, 0, italic[i] ? ITALIC_SKEW : 0, -1, gx, e.y + line.baseline), showText(font.encodeText(group)), endText(), popGraphicsState())
      }
      gx += width
      i = j
    }
  }
  ops.push(popGraphicsState())
}
