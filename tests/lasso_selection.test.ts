// @vitest-environment jsdom
// Story 4.3: lasso selection on the writing surface (Writer), the selection bounds and the toolbar button.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { selectionBounds } from '../src/model/select'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { PenToolbar } from '../src/ui/library/PenToolbar'
import { Writer } from '../src/ui/library/writer'
import { defaultPen } from '../src/model/pen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const stroke = (id: string, pts: number[][]) => ({ id, type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: pts.map(([x, y]) => [x!, y!, 0.5, 0]) })
const A = stroke('a', [[50, 50], [60, 60]])
const B = stroke('b', [[300, 300], [310, 310]])

describe('selectionBounds', () => {
  test('union of strokes and a rotated box', () => {
    expect(selectionBounds([A, B])).toEqual({ left: 50, top: 50, right: 310, bottom: 310 })
    const box = { id: 'x', type: 'text', x: 0, y: 0, width: 10, height: 20, rotation: 90 }
    const b = selectionBounds([box])!
    expect([b.left, b.right, b.top, b.bottom].map((n) => Math.round(n))).toEqual([-5, 15, 5, 15])
    expect(selectionBounds([{ id: 'e', type: 'stroke', points: [] }])).toBeNull()
  })
})

describe('Writer selection', () => {
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  const origCtx = proto.getContext
  let canvas: HTMLCanvasElement
  let counts: number[]
  let id = 0

  function make(readOnly = false) {
    const r = createNote({ title: 't', existingTitles: [], background: 'plain', orientation: 'portrait', noteId: 'n', pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-11T00:00:00.000Z', editedBy: 'x' })
    if ('error' in r) throw new Error(r.error)
    r.note.pages[0]!.elements.push(A, B)
    const w = new Writer(new History(r.note), { writeNote: async () => {}, close: () => {} } as never, () => defaultPen, () => {}, () => 'X')
    w.readOnly = readOnly
    w.onSelection = (n) => counts.push(n)
    w.attach(canvas)
    return w
  }
  // The canvas is as big as the page, so (almost) client px = page pt.
  const ev = (name: string, x: number, y: number, init: PointerEventInit = {}) =>
    canvas.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: name === 'pointerup' ? 0 : 1, ...init }))
  const click = (x: number, y: number, init: PointerEventInit = {}) => {
    ev('pointerdown', x, y, init)
    ev('pointerup', x, y, init)
  }
  const drag = (pts: [number, number][], init: PointerEventInit = {}) => {
    ev('pointerdown', ...pts[0]!, init)
    for (const p of pts.slice(1)) ev('pointermove', ...p, init)
    ev('pointerup', ...pts.at(-1)!, init)
  }
  const around: [number, number][] = [[20, 20], [100, 20], [100, 100], [20, 100]]

  beforeEach(() => {
    counts = []
    id++
    proto.getBoundingClientRect = () => ({ width: 595, height: 842, left: 0, top: 0, right: 595, bottom: 842, x: 0, y: 0, toJSON() {} }) as DOMRect
    proto.getContext = (() => null) as never
    canvas = document.createElement('canvas')
    document.body.append(canvas)
  })
  afterEach(() => {
    proto.getBoundingClientRect = origRect
    proto.getContext = origCtx
    canvas.remove()
  })

  test('lasso drag selects, an empty drag or click clears', () => {
    const w = make()
    w.setTool('lasso')
    drag(around)
    expect(w.selectedCount).toBe(1)
    expect(counts.at(-1)).toBe(1)
    click(500, 700) // blank
    expect(w.selectedCount).toBe(0)
    expect(counts.at(-1)).toBe(0)
  })

  test('click selects one, Shift+click adds and removes, blank Shift+click keeps', () => {
    const w = make()
    w.setTool('lasso')
    click(55, 55)
    expect(w.selectedCount).toBe(1)
    click(305, 305, { shiftKey: true })
    expect(w.selectedCount).toBe(2)
    click(55, 55, { shiftKey: true })
    expect(w.selectedCount).toBe(1)
    click(500, 700, { shiftKey: true })
    expect(w.selectedCount).toBe(1)
  })

  test('Alt+drag selects by rectangle; Ctrl+A path selects all', () => {
    const w = make()
    w.setTool('lasso')
    drag([[20, 20], [100, 100]], { altKey: true })
    expect(w.selectedCount).toBe(1)
    w.selectAll()
    expect(w.selectedCount).toBe(2)
    expect(counts.at(-1)).toBe(2)
  })

  test('pen tool selects nothing; switching to the pen clears', () => {
    const w = make()
    click(55, 55)
    expect(w.selectedCount).toBe(0)
    w.setTool('lasso')
    click(55, 55)
    expect(w.selectedCount).toBe(1)
    w.setTool('pen')
    expect(w.selectedCount).toBe(0)
  })

  test('read-only: the lasso selects and does not pan', () => {
    const w = make(true)
    w.setTool('lasso')
    drag(around)
    expect(w.selectedCount).toBe(1)
    expect(w.busy()).toBe(false)
    expect(canvas.classList.contains('is-panning')).toBe(false)
  })

  test('undo that removes a selected element prunes it for good', () => {
    const w = make()
    w.history.doOp({ op: 'addStroke', pageId: w.history.note.pages[0]!.id, stroke: stroke('c', [[400, 400], [410, 410]]) as never }, { rev: 'r2', now: 'n', editedBy: 'X', lastSeenRemoteSeq: 0 })
    w.setTool('lasso')
    click(405, 405)
    expect(w.selectedCount).toBe(1)
    w.undo()
    expect(w.selectedCount).toBe(0)
    expect(counts.at(-1)).toBe(0)
    w.redo()
    expect(w.selectedCount).toBe(0)
  })

  test('selection never touches the note', () => {
    const w = make()
    const before = JSON.stringify(w.history.note)
    w.setTool('lasso')
    drag(around)
    expect(JSON.stringify(w.history.note)).toBe(before)
    expect(w.history.undoDepth).toBe(0)
    void id
  })
})

describe('lasso toolbar button', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => host.remove())

  test('pressed state, name, tooltip, toggles', () => {
    const tools: string[] = []
    const root = createRoot(host)
    const i18n = createI18n({ navigatorLanguage: 'ko-KR', storage: { getItem: () => null, setItem: () => {} } })
    const render = (tool: 'pen' | 'lasso') =>
      act(() =>
        root.render(
          createElement(
            I18nContext.Provider,
            { value: i18n },
            createElement(PenToolbar, { pens: [defaultPen], selected: 0, onSelect() {}, onEdit() {}, tool, onToolChange: (t) => tools.push(t), canUndo: false, canRedo: false, onUndo() {}, onRedo() {}, readOnly: true }),
          ),
        ),
      )
    render('pen')
    const b = host.querySelector<HTMLButtonElement>('button[data-tool="lasso"]')!
    expect(b.getAttribute('aria-label')).toBe('올가미')
    expect(b.title).toBe('올가미 (L)')
    expect(b.getAttribute('aria-pressed')).toBe('false')
    act(() => b.click())
    render('lasso')
    expect(host.querySelector('button[data-tool="lasso"]')!.getAttribute('aria-pressed')).toBe('true')
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="lasso"]')!.click())
    expect(tools).toEqual(['lasso', 'pen'])
    act(() => root.unmount())
  })
})
