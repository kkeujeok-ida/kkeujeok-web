// @vitest-environment jsdom
// Story 4.5: move, resize and rotate of a selection (Writer), arrow-key nudges and the floating menu.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { defaultPen } from '../src/model/pen'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { SelectionMenu } from '../src/ui/library/SelectionMenu'
import { Writer, hitSelection } from '../src/ui/library/writer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const stroke = (id: string, pts: number[][]) => ({ id, type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: pts.map(([x, y]) => [x!, y!, 0.5, 0]) })

describe('hitSelection', () => {
  test('handles, inside, and a small box is grabbed inside first', () => {
    expect(hitSelection(100, 100, 300, 300, 200, 200)).toBe('move')
    expect(hitSelection(100, 100, 300, 300, 300, 300)).toBe(3)
    expect(hitSelection(100, 100, 300, 300, 200, 72)).toBe('rotate')
    expect(hitSelection(100, 100, 300, 300, 50, 50)).toBeNull()
    // 20 x 20 box: a corner handle (24 px) would cover everything.
    expect(hitSelection(100, 100, 120, 120, 118, 118)).toBe('move')
  })
})

describe('Writer transform', () => {
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  const origCtx = proto.getContext
  let canvas: HTMLCanvasElement

  function make(readOnly = false) {
    const r = createNote({ title: 't', existingTitles: [], background: 'plain', orientation: 'portrait', noteId: 'n', pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-11T00:00:00.000Z', editedBy: 'x' })
    if ('error' in r) throw new Error(r.error)
    r.note.pages[0]!.elements.push(stroke('a', [[100, 100], [200, 200]]))
    const w = new Writer(new History(r.note), { writeNote: async () => {}, close: () => {} } as never, () => defaultPen, () => {}, () => 'X')
    w.attach(canvas)
    w.setTool('lasso')
    ev('pointerdown', 100, 100)
    ev('pointerup', 100, 100) // click picks the stroke: box (100,100)-(200,200)
    w.readOnly = readOnly
    return w
  }
  const ev = (name: string, x: number, y: number, init: PointerEventInit = {}) =>
    canvas.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: name === 'pointerup' ? 0 : 1, ...init }))
  const drag = (from: [number, number], to: [number, number], init: PointerEventInit = {}) => {
    ev('pointerdown', ...from, init)
    ev('pointermove', ...to, init)
    ev('pointerup', ...to, init)
  }
  const pts = (w: Writer) => (w.history.note.pages[0]!.elements[0] as { points: number[][] }).points.map((p) => [p[0]!, p[1]!])

  beforeEach(() => {
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

  test('dragging inside moves: one op, one undo step', () => {
    const w = make()
    drag([150, 150], [170, 160])
    expect(pts(w)).toEqual([[120, 110], [220, 210]])
    expect(w.history.undoDepth).toBe(1)
    expect(w.undo()).toBe(true)
    expect(pts(w)).toEqual([[100, 100], [200, 200]])
  })

  test('a drag that ends where it began makes no op', () => {
    const w = make()
    drag([150, 150], [150, 150])
    expect(w.history.undoDepth).toBe(0)
  })

  test('corner resize keeps the ratio', () => {
    const w = make()
    drag([200, 200], [300, 300])
    expect(pts(w)).toEqual([[100, 100], [300, 300]])
    expect(w.history.undoDepth).toBe(1)
  })

  test('Shift frees the ratio for the drag', () => {
    const w = make()
    drag([200, 200], [300, 250], { shiftKey: true })
    expect(pts(w)).toEqual([[100, 100], [300, 250]])
  })

  test('the lock toggle off frees it, and Shift then keeps it', () => {
    const w = make()
    w.ratioLock = false
    drag([200, 200], [300, 250])
    expect(pts(w)).toEqual([[100, 100], [300, 250]])
    w.undo()
    drag([200, 200], [300, 300], { shiftKey: true })
    expect(pts(w)).toEqual([[100, 100], [300, 300]])
  })

  test('resize is never below 0.05', () => {
    const w = make()
    drag([200, 200], [0, 0])
    expect(pts(w)[1]).toEqual([105, 105])
  })

  test('the rotate handle turns about the selection center', () => {
    const w = make()
    drag([150, 72], [250, 150])
    expect(pts(w)).toEqual([[200, 100], [100, 200]])
    expect(w.history.undoDepth).toBe(1)
  })

  test('pointercancel changes nothing', () => {
    const w = make()
    ev('pointerdown', 150, 150)
    ev('pointermove', 190, 190)
    ev('pointercancel', 190, 190)
    expect(pts(w)).toEqual([[100, 100], [200, 200]])
    expect(w.history.undoDepth).toBe(0)
  })

  test('arrow nudges: 1 pt and 10 pt, a run is one undo step', () => {
    const w = make()
    expect(w.nudge(1, 0)).toBe(true)
    expect(w.nudge(10, 0)).toBe(true)
    expect(pts(w)[0]).toEqual([111, 100])
    expect(w.history.undoDepth).toBe(1)
    w.undo()
    expect(pts(w)[0]).toEqual([100, 100])
  })

  test('nudge, undo, another edit, nudge: the last nudge does not fold into the other edit', () => {
    const w = make()
    w.nudge(1, 0)
    w.undo()
    w.scaleSelection(1.25)
    w.nudge(1, 0)
    expect(w.history.undoDepth).toBe(2)
  })

  test('a press inside the box on an unselected element selects it instead of moving', () => {
    const w = make()
    ;(w.history.note.pages[0]!.elements as unknown[]).push(stroke('b', [[140, 150], [160, 150]]))
    ev('pointerdown', 150, 150)
    ev('pointerup', 150, 150)
    expect(w.history.undoDepth).toBe(0)
    expect(w.selectedCount).toBe(1)
    drag([150, 150], [160, 150])
    expect((w.history.note.pages[0]!.elements[1] as { points: number[][] }).points[0]![0]).toBe(150)
  })

  test('step buttons: larger, smaller, 90 degrees', () => {
    const w = make()
    expect(w.scaleSelection(1.25)).toBe(true)
    expect(pts(w)).toEqual([[87.5, 87.5], [212.5, 212.5]])
    expect(w.rotateSelection(90)).toBe(true)
    expect(w.history.undoDepth).toBe(2)
    w.undo()
    w.undo()
    expect(pts(w)).toEqual([[100, 100], [200, 200]])
  })

  test('read-only: drag, nudge and step buttons do nothing', () => {
    const w = make(true)
    drag([150, 150], [170, 160])
    expect(w.nudge(1, 0)).toBe(false)
    expect(w.scaleSelection(1.25)).toBe(false)
    expect(pts(w)).toEqual([[100, 100], [200, 200]])
    expect(w.history.undoDepth).toBe(0)
  })

  test('an element moved off the page stays', () => {
    const w = make()
    drag([150, 150], [-250, 150])
    expect(pts(w)[0]).toEqual([-300, 100])
  })
})

describe('SelectionMenu', () => {
  const box = { left: 100, top: 300, right: 200, bottom: 400, w: 595, h: 842 }
  function mount(b = box) {
    const calls: string[] = []
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const i18n = createI18n({ navigatorLanguage: 'ko' })
    act(() =>
      root.render(
        createElement(I18nContext.Provider, { value: i18n }, createElement(SelectionMenu, { box: b, origin: { x: 0, y: 0 }, ratioLock: true, onRatioLock: () => calls.push('lock'), onScale: (f: number) => calls.push(`s${f}`), onRotate: () => calls.push('r'), onLeave: () => calls.push('leave') })),
      ),
    )
    return { host, calls, done: () => (act(() => root.unmount()), host.remove()) }
  }

  test('buttons, names and the toggle state', () => {
    const m = mount()
    const btns = [...m.host.querySelectorAll('button')]
    expect(btns.map((b) => b.textContent)).toEqual(['비율 잠금', '크게', '작게', '90° 회전'])
    expect(btns[0]!.getAttribute('aria-pressed')).toBe('true')
    act(() => btns.forEach((b) => b.click()))
    expect(m.calls).toEqual(['lock', 's1.25', 's0.8', 'r'])
    m.done()
  })

  test('Esc leaves for the canvas; above the box, below when there is no room, hidden off screen', () => {
    const m = mount()
    const menu = m.host.querySelector<HTMLElement>('[data-selection-menu]')!
    act(() => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(m.calls).toEqual(['leave'])
    expect(parseFloat(menu.style.top)).toBeLessThan(300)
    m.done()
    const low = mount({ ...box, top: 20, bottom: 60 })
    expect(parseFloat(low.host.querySelector<HTMLElement>('[data-selection-menu]')!.style.top)).toBeGreaterThan(60)
    low.done()
    const off = mount({ ...box, top: 900, bottom: 950 })
    expect(off.host.querySelector('[data-selection-menu]')).toBeNull()
    off.done()
  })
})
