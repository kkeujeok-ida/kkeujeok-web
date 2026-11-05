import { readFileSync } from 'node:fs'
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, test } from 'vitest'
import { buildPdf, groundMatrix } from '../src/export/pdfExport'
import { pdfPageBox, pdfPagePoint } from '../src/model/pdfRules'

type Sample = { sha256: string; pages: { width: number; height: number; box: number[]; rotate: number; userUnit: number; text: string }[] }
const manifest = JSON.parse(readFileSync(new URL('../../test/pdf/manifest.json', import.meta.url), 'utf8')) as Record<string, Sample>
const file = (n: string) => new Uint8Array(readFileSync(new URL(`../../test/pdf/${n}`, import.meta.url)))
const fonts = async () => {
  throw new Error('no text on these pages')
}
const pen = { id: 'e', type: 'stroke', tool: 'pen', color: '#ff0000', width: 4, usePressure: false, points: [[10, 10, 0.5, 0], [60, 40, 0.5, 10]] }

describe('PDF background export (Story 9.7)', () => {
  test.each(['a4.pdf', 'mixed.pdf', 'rotated90.pdf', 'cropOffset.pdf', 'userUnit2.pdf'])('%s: original pages + overlay', async (name) => {
    const m = manifest[name]!
    const pages = m.pages.map((p, i) => ({
      id: `p${i}`, width: p.width, height: p.height, elements: [pen],
      background: { type: 'pdf', asset: m.sha256, page: i, box: p.box, rotate: p.rotate, userUnit: p.userUnit },
    }))
    const bytes = file(name)
    const r = await buildPdf({
      note: { meta: { title: 't' }, pages } as never, range: { mode: 'all', current: 1 }, fonts,
      assets: { get: async (h) => (h === m.sha256 ? { ext: 'pdf', bytes } : null) },
    })
    if (!r.ok) throw new Error(r.error)
    const out = await PDFDocument.load(new Uint8Array(await r.blob.arrayBuffer()))
    expect(out.getPages().map((p) => p.getSize())).toEqual(m.pages.map((p) => ({ width: p.width, height: p.height })))
    // the original page is a form XObject (not an image) and its content stream still holds the text; the ink is on top
    const streams = [...out.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream)
    const text = streams.map(([, o]) => Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString('latin1')).join('\n')
    for (const p of m.pages) expect(text).toContain(`(${p.text})`)
    const raw = Buffer.from(await r.blob.arrayBuffer()).toString('latin1')
    expect(raw).not.toContain('/Subtype /Image')
    // the page draws the original (Do) first, then the ink over it
    const content = streams.map(([, o]) => Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString('latin1')).find((t) => t.includes('1 0 0 rg')) ?? ''
    expect(content.indexOf(' Do')).toBeGreaterThan(-1)
    expect(content.indexOf(' Do')).toBeLessThan(content.indexOf('1 0 0 rg'))
  })

  test('groundMatrix is the inverse of pdf.pageMatrix for every turn', () => {
    for (const name of ['a4.pdf', 'rotated90.pdf', 'rotated270.pdf', 'cropOffset.pdf', 'userUnit2.pdf']) {
      const p = manifest[name]!.pages[0]!
      const g = pdfPageBox({ mediaBox: p.box, rotate: p.rotate, userUnit: p.userUnit })
      if ('error' in g) throw new Error('box')
      const mx = groundMatrix(g.box, g.rotate, g.userUnit, g.height) as [number, number, number, number, number, number]
      const [x0, y0, x1, y1] = g.box as [number, number, number, number]
      for (const [X, Y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
        const [px, py] = pdfPagePoint(g.box, g.rotate, g.userUnit, [X, Y]) as [number, number]
        expect([mx[0] * X + mx[2] * Y + mx[4], mx[1] * X + mx[3] * Y + mx[5]].map((v) => Math.round(v * 100) / 100)).toEqual([px, Math.round((g.height - py) * 100) / 100])
      }
    }
  })
})
