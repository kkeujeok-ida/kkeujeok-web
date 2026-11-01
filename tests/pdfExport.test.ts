import { readFileSync } from 'node:fs'
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, test } from 'vitest'
import { buildPdf, ExportCancelled } from '../src/export/pdfExport'
import { sha256Hex } from '../src/util/sha256'

const font = (n: string) => new Uint8Array(readFileSync(new URL(`../public/fonts/Pretendard-${n}.ttf`, import.meta.url)))
const fonts = async () => ({ regular: font('Regular'), semibold: font('SemiBold') })

// 1x1 PNG
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))

const stroke = (id: string, tool: 'pen' | 'highlighter') => ({
  id, type: 'stroke', tool, color: '#ff0000', width: 4, usePressure: false, points: [[10, 10, 0.5, 0], [60, 40, 0.5, 10], [90, 20, 0.5, 20]],
})
const text = (id: string) => ({ id, type: 'text', x: 20, y: 100, width: 200, text: '안녕 hello', size: 16, color: '#112233', rotation: 10 })
const page = (id: string, elements: unknown[], w = 595, h = 842) => ({ id, width: w, height: h, background: 'lined', elements })
const noteOf = (pages: unknown[]) => ({ meta: { title: '수학 노트' }, pages }) as never
const none = { get: async () => null }

describe('buildPdf', () => {
  test('pages, sizes, file name, fonts, progress', async () => {
    const note = noteOf([page('p1', [stroke('a', 'pen'), stroke('b', 'highlighter'), text('t')]), page('p2', [], 842, 595), page('p3', [])])
    const seen: string[] = []
    const r = await buildPdf({ note, range: { mode: 'custom', text: '1-2', current: 1 }, assets: none, fonts, onProgress: (d, t) => seen.push(`${d}/${t}`) })
    if (!r.ok) throw new Error(r.error)
    expect(r.fileName).toBe('수학 노트.pdf')
    expect(seen).toEqual(['0/2', '1/2', '2/2'])
    const bytes = new Uint8Array(await r.blob.arrayBuffer())
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPages().map((p) => p.getSize())).toEqual([{ width: 595, height: 842 }, { width: 842, height: 595 }])
    const raw = Buffer.from(bytes).toString('latin1')
    expect(raw).toContain('/BM /Multiply')
    expect(raw).toContain('/BaseFont /Pretendard-Regular') // the font is in the file
    // real text: its glyphs map back to the code points of "안녕 hello" (search, select, copy)
    const maps = [...doc.context.enumerateIndirectObjects()]
      .filter(([, o]) => o instanceof PDFRawStream)
      .map(([, o]) => Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString('latin1'))
      .filter((t) => t.includes('beginbfchar'))
    expect(maps.some((m) => m.includes('<C548>') && m.includes('<B155>') && m.includes('<0068>'))).toBe(true)
  })

  test('range errors and assetMissing end without a PDF', async () => {
    const img = { id: 'i', type: 'image', x: 0, y: 0, width: 50, height: 50, asset: 'a'.repeat(64), ext: 'png' }
    const note = noteOf([page('p1', [img])])
    expect(await buildPdf({ note, range: { mode: 'custom', text: '2', current: 1 }, assets: none, fonts })).toEqual({ ok: false, error: 'outOfRange' })
    expect(await buildPdf({ note, range: { mode: 'all', current: 1 }, assets: none, fonts })).toEqual({ ok: false, error: 'assetMissing', assets: ['a'.repeat(64)] })
  })

  test('an image asset is embedded as it is', async () => {
    const hash = await sha256Hex(PNG)
    const note = noteOf([page('p1', [{ id: 'i', type: 'image', x: 0, y: 0, width: 50, height: 50, asset: hash, ext: 'png', rotation: 30 }])])
    const r = await buildPdf({ note, range: { mode: 'all', current: 1 }, assets: { get: async () => ({ ext: 'png', bytes: PNG }) }, fonts })
    if (!r.ok) throw new Error(r.error)
    expect(Buffer.from(await r.blob.arrayBuffer()).toString('latin1')).toContain('/Subtype /Image')
  })

  test('cancel stops with no result; a 100 page note reports every page', async () => {
    const note = noteOf(Array.from({ length: 100 }, (_, i) => page(`p${i}`, [stroke('a', 'pen')])))
    const ac = new AbortController()
    const p = buildPdf({ note, range: { mode: 'all', current: 1 }, assets: none, fonts, signal: ac.signal, onProgress: (d) => d === 3 && ac.abort() })
    await expect(p).rejects.toBeInstanceOf(ExportCancelled)
    let last = 0
    const r = await buildPdf({ note, range: { mode: 'all', current: 1 }, assets: none, fonts, onProgress: (d) => (last = d) })
    expect(r.ok && r.pages).toBe(100)
    expect(last).toBe(100)
  })
})
