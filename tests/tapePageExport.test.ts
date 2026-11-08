import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, test } from 'vitest'
import { buildPdf } from '../src/export/pdfExport'

// 1x1 PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

describe('tape page export (Story 24.8)', () => {
  test('a tape page is exactly one image: no text, no paths, size from the plan', async () => {
    const page = {
      id: 'p', width: 100.2, height: 50, background: 'plain',
      elements: [
        { id: 't', type: 'stroke', tool: 'tape', color: '#222222', width: 20, usePressure: false, points: [[10, 10, 0.5, 0], [60, 10, 0.5, 10]] },
        { id: 'x', type: 'text', x: 5, y: 5, width: 80, text: 'secret', color: '#000000' },
      ],
    }
    const asked: number[][] = []
    const r = await buildPdf({
      note: { meta: { title: 't' }, pages: [page] } as never, range: { mode: 'all', current: 1 },
      assets: { get: async () => null }, fonts: async () => { throw new Error('no fonts for a tape page') },
      rasterPage: async (_p, w, h) => (asked.push([w, h]), PNG),
    })
    if (!r.ok) throw new Error(r.error)
    expect(asked).toEqual([[251, 125]])
    const out = await PDFDocument.load(new Uint8Array(await r.blob.arrayBuffer()))
    const streams = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o): o is PDFRawStream => o instanceof PDFRawStream)
    const isImage = (o: PDFRawStream) => o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
    // an RGBA PNG also brings its alpha plane (/SMask, DeviceGray): not a second picture
    expect(streams.filter((o) => isImage(o) && o.dict.get(PDFName.of('ColorSpace')) !== PDFName.of('DeviceGray'))).toHaveLength(1)
    const ops = streams.filter((o) => !isImage(o)).map((o) => Buffer.from(decodePDFRawStream(o).decode()).toString('latin1')).join(' ')
    expect(ops).toContain(' Do')
    expect(ops).not.toMatch(/\b(BT|re|f|l|m)\b/)
    expect(Buffer.from(await r.blob.arrayBuffer()).toString('latin1')).not.toMatch(/\/Type\s*\/Font\b/)
  })
})
