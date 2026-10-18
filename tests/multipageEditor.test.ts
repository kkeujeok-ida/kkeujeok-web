// @vitest-environment jsdom
// Story 3.22, a note with several pages in the writing screen: one vertical continuous scroll, each page named with
// `aria-current` on the current one, PgUp / PgDn / Home / End, strokes landing on the page under the pointer in that
// page's coordinates, a lock per page, the mouse wheel, pages off screen not painted. A single page is as before.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Note, Stroke } from '../src/model/note'
import { History } from '../src/ops/history'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { PAGE_GAP } from '../src/ui/library/writer'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { type Mounted, mountUi } from './syncUiHarness'
import { NID, PA, PB, mkNote, stroke } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PC = '01926f3a-0000-7000-8000-0000000000b3'
class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
const calls: string[] = []
const ctxProxy = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? (...a: unknown[]) => void calls.push(`${k}:${a.join(',')}`) : undefined), set: () => true })
HTMLCanvasElement.prototype.getContext = (() => ctxProxy) as never
let rect = { width: 0, height: 0 }
HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({ ...rect, top: 0, left: 0, right: rect.width, bottom: rect.height, x: 0, y: 0, toJSON() {} })) as never

let m: Mounted | undefined
let stores: NoteStore[] = []
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const openStore = () => {
  const s = openNoteStore()
  stores.push(s)
  return s
}
beforeEach(() => {
  clearSessionHistories()
  calls.length = 0
  rect = { width: 0, height: 0 }
})
afterEach(async () => {
  m?.unmount()
  m = undefined
  await savesSettled()
  stores.forEach((s) => s.close())
  stores = []
  location.hash = ''
  await deleteNoteDatabase()
})

const three = () => {
  const n = mkNote({ title: '여럿', pages: { [PA]: 'a1', [PB]: 'b1', [PC]: 'c1' } })
  return n
}
async function mount(note: Note, lang: 'ko' | 'en' = 'ko', lock?: string) {
  const s = openNoteStore()
  await s.writeNote(note)
  if (lock) {
    await s.recordConflicts(NID, {
      conflicts: [{ pageId: lock, kind: 'bothEdited', rev: 'x1', theirsRev: 't1', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null }],
      sidecars: [{ noteId: NID, pageId: lock, rev: 'x1', seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: note.pages[0]! }],
    })
  }
  s.close()
  m = mountUi(createElement(NoteEditor, { noteId: NID, openStore }), lang)
  await settle()
  await settle()
}
const canvas = () => m!.q<HTMLCanvasElement>('canvas.editor-canvas')!
const labels = () => m!.qa('ul.sr-only li').map((x) => x.textContent)
const current = () => m!.qa('ul.sr-only li').findIndex((x) => x.getAttribute('aria-current') === 'page')
const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  act(() => void document.dispatchEvent(e))
  return e
}
const focusCanvas = () => act(() => void canvas().focus())
let clock = 1000
const fire = (name: string, x: number, y: number, type = 'pen') => {
  const e = new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 1, pointerType: type, clientX: x, clientY: y, pressure: 0.5, button: 0, buttons: 1 })
  Object.defineProperty(e, 'timeStamp', { value: (clock += 10) })
  act(() => void canvas().dispatchEvent(e))
}
const draw = (x: number, y: number) => {
  fire('pointerdown', x, y)
  fire('pointermove', x + 10, y)
  fire('pointerup', x + 20, y)
}
const stored = async (): Promise<Note> => {
  await settle()
  await savesSettled()
  const s = openNoteStore()
  const r = await s.loadNote(NID)
  s.close()
  return r!.note!
}
const strokesOf = (n: Note, id: string) => n.pages.find((p) => p.id === id)!.elements as Stroke[]
const H = 842

describe('names and the current page', () => {
  test('every page is named "N페이지 / M, 세로"; aria-current on the first at the start; the canvas names the current page', async () => {
    await mount(three())
    expect(labels()).toEqual(['1페이지 / 3, 세로', '2페이지 / 3, 세로', '3페이지 / 3, 세로'])
    expect(current()).toBe(0)
    expect(m!.qa('ul.sr-only li[aria-current]')).toHaveLength(1)
    expect(canvas().getAttribute('aria-label')).toBe('1페이지 / 3, 세로')
    expect(m!.q('.editor-page-area')!.getAttribute('aria-label')).toBe('필기 영역: 1페이지 / 3, 세로')
  })

  test('English; a landscape page says so', async () => {
    const n = three()
    n.pages[1] = { ...n.pages[1]!, width: 842, height: 595 }
    await mount(n, 'en')
    expect(labels()).toEqual(['Page 1 of 3, Portrait', 'Page 2 of 3, Landscape', 'Page 3 of 3, Portrait'])
  })

  test('a single page note looks as before: no list, one name, and the page keys do nothing', async () => {
    await mount(mkNote({ title: '하나' }))
    expect(m!.qa('ul.sr-only')).toHaveLength(0)
    expect(canvas().getAttribute('aria-label')).toBe('1페이지 / 1, 세로')
    focusCanvas()
    expect(key('PageDown').defaultPrevented).toBe(false)
    expect(key('End').defaultPrevented).toBe(false)
  })
})

describe('PgUp / PgDn / Home / End', () => {
  test('they move between the pages and the current page follows', async () => {
    await mount(three())
    focusCanvas()
    expect(key('PageDown').defaultPrevented).toBe(true)
    expect(current()).toBe(1)
    expect(canvas().getAttribute('aria-label')).toBe('2페이지 / 3, 세로')
    key('PageDown')
    expect(current()).toBe(2)
    key('PageDown') // the end
    expect(current()).toBe(2)
    key('PageUp')
    expect(current()).toBe(1)
    key('Home')
    expect(current()).toBe(0)
    key('PageUp')
    expect(current()).toBe(0)
    key('End')
    expect(current()).toBe(2)
  })

  test('with a modifier, or off the canvas, they are not ours', async () => {
    await mount(three())
    focusCanvas()
    expect(key('PageDown', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key('PageDown', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(current()).toBe(0)
    act(() => void (document.activeElement as HTMLElement).blur())
    expect(key('PageDown').defaultPrevented).toBe(false)
    expect(current()).toBe(0)
  })

  test('the page a key moved to starts the view, so a stroke there lands on that page', async () => {
    await mount(three())
    focusCanvas()
    key('PageDown')
    draw(100, 40)
    const n = await stored()
    expect(strokesOf(n, PA)).toHaveLength(0)
    expect(strokesOf(n, PB)).toHaveLength(1)
    expect(strokesOf(n, PB)[0]!.points[0]!.slice(0, 2)).toEqual([100, 40])
  })
})

describe('strokes land on the page under the pointer, in that page\'s coordinates', () => {
  test('page 1, page 2 (below the gap), page 3, and nothing between pages', async () => {
    await mount(three())
    draw(100, 100)
    draw(100, H + PAGE_GAP + 50)
    draw(100, 2 * (H + PAGE_GAP) + 70)
    draw(100, H + 5) // in the gap
    const n = await stored()
    expect(strokesOf(n, PA).map((s) => s.points[0]!.slice(0, 2))).toEqual([[100, 100]])
    expect(strokesOf(n, PB).map((s) => s.points[0]!.slice(0, 2))).toEqual([[100, 50]])
    expect(strokesOf(n, PC).map((s) => s.points[0]!.slice(0, 2))).toEqual([[100, 70]])
  })

  test('a narrower page is centered: its x starts where the page starts', async () => {
    const n = three()
    n.pages[2] = { ...n.pages[2]!, width: 842, height: 595 } // the document is 842 wide, the others 595
    await mount(n)
    const x0 = (842 - 595) / 2
    draw(x0 + 30, 100)
    expect(strokesOf(await stored(), PA)[0]!.points[0]!.slice(0, 2)).toEqual([30, 100])
    draw(5, 100) // left of the page, inside the document: nothing
    expect(strokesOf(await stored(), PA)).toHaveLength(1)
  })

  test('a stroke goes on with the page it began on even when it moves over the next one', async () => {
    await mount(three())
    fire('pointerdown', 100, H - 10)
    fire('pointermove', 110, H + 40)
    fire('pointerup', 120, H + PAGE_GAP + 30)
    const n = await stored()
    expect(strokesOf(n, PA)).toHaveLength(1)
    expect(strokesOf(n, PB)).toHaveLength(0)
    expect(strokesOf(n, PA)[0]!.points.at(-1)!.slice(0, 2)).toEqual([120, H + PAGE_GAP + 30])
  })

  test('the mouse wheel scrolls the continuous view', async () => {
    await mount(three())
    act(() => void canvas().dispatchEvent(new WheelEvent('wheel', { deltaY: H + PAGE_GAP, bubbles: true, cancelable: true })))
    draw(100, 60)
    const n = await stored()
    expect(strokesOf(n, PA)).toHaveLength(0)
    expect(strokesOf(n, PB)[0]!.points[0]!.slice(0, 2)).toEqual([100, 60])
  })
})

describe('a lock is per page', () => {
  test('page 2 with a conflict refuses strokes, the others take them', async () => {
    await mount(three(), 'ko', PB)
    draw(100, 100)
    draw(100, H + PAGE_GAP + 100)
    draw(100, 2 * (H + PAGE_GAP) + 100)
    const n = await stored()
    expect([PA, PB, PC].map((id) => strokesOf(n, id).length)).toEqual([1, 0, 1])
    expect(m!.qa('[role="alert"]').map((x) => x.textContent)).toContain('읽기 전용 페이지예요')
  })

  test('the canvas description names the read-only state of the CURRENT page only', async () => {
    await mount(three(), 'ko', PB)
    const desc = () => m!.q(`#${canvas().getAttribute('aria-describedby')}`)!.textContent
    expect(desc()).toBe('손글씨')
    focusCanvas()
    key('PageDown')
    expect(desc()).toBe('손글씨. 읽기 전용, 두 기기에서 고친 페이지')
  })

  test('History: the undo record of a locked page is refused whichever page is current; others still undo', () => {
    const h = new History(three())
    const ctx = { rev: 'r', now: '2026-10-12T00:00:00.000Z', editedBy: 'C', lastSeenRemoteSeq: 0 }
    h.doOp({ op: 'addStroke', pageId: PB, stroke: stroke('s1') }, { ...ctx, rev: 'rb' })
    h.doOp({ op: 'addStroke', pageId: PA, stroke: stroke('s2') }, { ...ctx, rev: 'ra' })
    expect(h.topLocked('undo')).toBe(false)
    h.setLocked([PA])
    expect(h.topLocked('undo')).toBe(true)
    expect(h.undo(ctx)).toBe('pageReadOnly')
    h.setLocked([PB])
    expect(h.topLocked('undo')).toBe(false)
    expect(h.undo(ctx)).toBeNull()
    expect(h.topLocked('undo')).toBe(true) // the next record is page B's
  })
})

describe('fit page', () => {
  test('after moving to page 2, "페이지 맞춤" fits page 2: a stroke in the middle of the view lands on it and it stays current', async () => {
    rect = { width: 595, height: 600 }
    await mount(three())
    focusCanvas()
    key('PageDown')
    act(() => void m!.q<HTMLButtonElement>('button[aria-label="더 보기"]')!.click())
    act(() => void [...m!.qa<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === '페이지 맞춤')!.click())
    expect(current()).toBe(1)
    draw(300, 300)
    const n = await stored()
    expect(strokesOf(n, PA)).toHaveLength(0)
    expect(strokesOf(n, PB)).toHaveLength(1)
    expect(strokesOf(n, PC)).toHaveLength(0)
    expect(current()).toBe(1)
  })
})

describe('pages off screen are not painted', () => {
  const papers = () => calls.filter((c) => c.startsWith('fillRect:0,0,595,842')).length

  test('with the first page in view only it is painted; after PgDn only the second', async () => {
    rect = { width: 595, height: 600 }
    await mount(three())
    calls.length = 0
    act(() => void window.dispatchEvent(new Event('resize')))
    expect(papers()).toBe(1)
    focusCanvas()
    calls.length = 0
    key('PageDown')
    expect(papers()).toBe(1)
    const translates = calls.filter((c) => c.startsWith('translate:')).map((c) => Number(c.split(',')[1]))
    expect(translates).toHaveLength(1)
    expect(translates[0]!).toBeGreaterThanOrEqual(0) // the page that is painted starts inside the view
  })

  test('every page in view is painted', async () => {
    rect = { width: 595, height: 1800 } // all three pages in view
    await mount(three())
    calls.length = 0
    act(() => void window.dispatchEvent(new Event('resize')))
    expect(papers()).toBe(3)
  })
})
