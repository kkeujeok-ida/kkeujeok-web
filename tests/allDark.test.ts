import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import type { Page, Stroke } from '../src/model/note'
import { StrokePathCache, paintPage } from '../src/render/pagePainter'
import { THEME_KEY, applyTheme, readTheme } from '../src/storage/theme'

class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
  rect() {}
  addPath() {}
  arc() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath

const stroke = (tool: 'pen' | 'highlighter'): Stroke => ({
  id: tool, type: 'stroke', tool, color: tool === 'pen' ? '#000000' : '#ffe066', width: 10, usePressure: false, points: [[10, 10, 0.5, 0], [60, 10, 0.5, 1]],
})
const page = (background: unknown): Page =>
  ({ id: 'p', width: 100, height: 100, background, rev: 'r', seq: 0, editedAt: '', editedBy: '', elements: [stroke('pen'), stroke('highlighter')] }) as unknown as Page

// Colors set on fillStyle and composite ops, in order.
function paint(p: Page, allDark: boolean) {
  const fills: string[] = [], ops: string[] = []
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'getTransform' ? () => ({ a: 1 }) : typeof k === 'string' ? () => {} : undefined),
    set: (_t, k, v) => (k === 'fillStyle' ? fills.push(v) : k === 'globalCompositeOperation' && ops.push(v), true),
  }) as unknown as CanvasRenderingContext2D
  paintPage(ctx, p, { scale: 1, offsetX: 0, offsetY: 0 }, new StrokePathCache(), null, null, undefined, null, allDark)
  return { fills, ops }
}

describe('All Dark painting', () => {
  test('inverts paper, pen and highlighter blend', () => {
    const r = paint(page('plain'), true)
    expect(r.fills).toEqual(['#1b1c1f', '#ffffff', '#ffe066'])
    expect(r.ops).toEqual([])
  })
  test('Light and Dark keep the original colors and multiply', () => {
    const r = paint(page('plain'), false)
    expect(r.fills).toEqual(['#ffffff', '#000000', '#ffe066'])
    expect(r.ops).toEqual(['multiply'])
  })
  test('a PDF page inverts nothing', () => {
    const pdf = { type: 'pdf', asset: 'a'.repeat(64), page: 0, box: [0, 0, 100, 100], rotate: 0, userUnit: 1 }
    expect(paint(page(pdf), true)).toEqual(paint(page(pdf), false))
  })
})

describe('theme store', () => {
  test('reads light by default and for junk; applies attributes', () => {
    const mem = (v: string | null) => ({ getItem: () => v, setItem() {} })
    expect([null, 'x', 'dark', 'alldark'].map((v) => readTheme(mem(v)))).toEqual(['light', 'light', 'dark', 'alldark'])
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement
    applyTheme('alldark', root)
    expect(root.dataset).toEqual({ theme: 'dark', invert: 'true' })
    applyTheme('dark', root)
    expect(root.dataset).toEqual({ theme: 'dark' })
  })
  test('index.html script uses the stored key; export and print never read the theme', () => {
    expect(readFileSync('index.html', 'utf8')).toContain(`'${THEME_KEY}'`)
    for (const f of ['pdfExport', 'printPdf', 'exportRules']) expect(readFileSync(`src/export/${f}.ts`, 'utf8')).not.toMatch(/theme|invert/i)
  })
})
