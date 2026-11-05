// @vitest-environment jsdom
// Story 9.5: the render size, the byte LRU, the placeholder of each asset state, the PDF page in the overview.
// pdf.js's real render needs a canvas backend that jsdom lacks, so the render itself is judged by the unit pieces
// (size fit, LRU) and in the browser, not here.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { ByteLru, createPdfPages, pdfRenderSize } from '../src/render/pdfPages'
import { PageOverview } from '../src/ui/library/PageOverview'
import { mkNote, PA, PB } from './uploadHarness'
import { mountUi, type Mounted } from './syncUiHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
HTMLCanvasElement.prototype.getContext = (() => null) as never

const H = 'a'.repeat(64)
const bg = { type: 'pdf', asset: H, page: 0, box: [0, 0, 100, 200], rotate: 0, userUnit: 1 }
let m: Mounted | undefined
afterEach(() => (m?.unmount(), (m = undefined)))

describe('pdf render size and LRU', () => {
  test('whole page and tile sizes', () => {
    expect(pdfRenderSize(100, 200, null, 2)).toEqual({ bw: 200, bh: 400, sx: 0, sy: 0, fw: 200, fh: 400 })
    expect(pdfRenderSize(100, 200, { x0: 10, y0: 20, x1: 60, y1: 120 }, 2)).toEqual({ bw: 100, bh: 200, sx: -20, sy: -40, fw: 200, fh: 400 })
  })
  test('over budget drops the oldest not recently touched, keeps the newest', () => {
    let t = 0
    const out: string[] = []
    const lru = new ByteLru<{ bytes: number; n: string }>(100, (v) => out.push(v.n), () => t, 500)
    lru.put('a', { bytes: 60, n: 'a' })
    t = 1000
    lru.put('b', { bytes: 60, n: 'b' })
    expect(out).toEqual(['a'])
    t = 2000
    lru.put('c', { bytes: 60, n: 'c' })
    expect(out).toEqual(['a', 'b'])
    expect(lru.size).toBe(1)
  })
})

describe('pdf placeholder by state', () => {
  const calls: string[] = []
  const ctx = new Proxy({}, { get: (_, k) => (k === 'fillText' ? (s: string) => calls.push(s) : () => {}), set: () => true }) as unknown as CanvasRenderingContext2D
  const layerFor = (local: string[], failed: string[]) => {
    const p = createPdfPages({ store: {} as never, sync: { local: () => new Set(local), failed: () => new Set(failed) } as never, changed: () => {} })
    p.layer.labels = { downloading: 'DL', failed: 'FAIL' }
    return p.layer
  }
  const page = { width: 100, height: 200, background: bg }
  test('downloading, failed, other pages', () => {
    calls.length = 0
    layerFor([], []).paint(ctx, page, { x0: 0, y0: 0, x1: 100, y1: 200 }, 1)
    layerFor([], [H]).paint(ctx, page, { x0: 0, y0: 0, x1: 100, y1: 200 }, 1)
    expect(calls).toEqual(['DL', 'FAIL'])
    expect(layerFor([], []).state({ background: 'plain' })).toBeNull()
    expect(layerFor([H], []).state(page)).toBe('ready')
  })
})

describe('overview of a PDF page', () => {
  test('named PDF page, background and orientation disabled', () => {
    const pages = mkNote({ title: 'x', pages: { [PA]: 'a1', [PB]: 'b1' } }).pages
    pages[0]!.background = bg as never
    m = mountUi(createElement(PageOverview, { id: 'p', pages, current: 0, conflicted: new Set(), side: 'right', overlay: false, onGo: () => {}, onClose: () => {} }), 'ko')
    const o = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(o[0]!.getAttribute('aria-label')).toContain('PDF 페이지')
    expect(o[1]!.getAttribute('aria-label')).not.toContain('PDF')
    act(() => document.querySelector<HTMLElement>('.po-item button[aria-label="페이지 메뉴"]')?.click())
    const items = [...document.querySelectorAll<HTMLElement>('.po-menu [role="menuitem"]')]
    expect(items.filter((i) => i.getAttribute('aria-disabled') === 'true').length).toBe(2)
  })
})
