// @vitest-environment jsdom
// Answer tape on the writing surface (spec/pen-kinds.md): tap toggles, a drag or a slow press is a stroke, select/eraser do not toggle.
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { defaultPen } from '../src/model/pen'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { Writer, type TapeNode } from '../src/ui/library/writer'

const tape = { id: 't1', type: 'stroke', tool: 'tape', color: '#FFEB3B', width: 20, usePressure: false, points: [[100, 100, 0.5, 0], [300, 100, 0.5, 10]] }

describe('Writer answer tape', () => {
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  const origCtx = proto.getContext
  let canvas: HTMLCanvasElement
  let nodes: TapeNode[]

  function make() {
    const r = createNote({ title: 't', existingTitles: [], background: 'plain', orientation: 'portrait', noteId: 'n', pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-11T00:00:00.000Z', editedBy: 'x' })
    if ('error' in r) throw new Error(r.error)
    r.note.pages[0]!.elements.push(structuredClone(tape))
    const w = new Writer(new History(r.note), { writeNote: async () => {}, close: () => {} } as never, () => defaultPen, () => {}, () => 'X')
    w.onTapes = (n) => (nodes = n)
    w.attach(canvas)
    return w
  }
  const ev = (name: string, x: number, y: number, _t: number, init: PointerEventInit = {}) =>
    canvas.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: name === 'pointerup' ? 0 : 1, ...init }))
  const press = (x: number, y: number, ms = 50, to: [number, number] = [x, y]) => {
    ev('pointerdown', x, y, 0)
    if (to[0] !== x || to[1] !== y) ev('pointermove', to[0], to[1], ms)
    ev('pointerup', to[0], to[1], ms)
  }
  const count = (w: Writer) => w.history.note.pages[0]!.elements.length

  beforeEach(() => {
    nodes = []
    proto.getBoundingClientRect = () => ({ width: 595, height: 842, left: 0, top: 0, right: 595, bottom: 842, x: 0, y: 0, toJSON() {} }) as DOMRect
    proto.getContext = (() => new Proxy({}, { get: (_t, k) => (k === 'canvas' ? undefined : () => undefined) })) as never
    canvas = document.createElement('canvas')
    document.body.append(canvas)
  })
  afterEach(() => {
    proto.getBoundingClientRect = origRect
    proto.getContext = origCtx
    canvas.remove()
  })

  test('a quick click toggles the tape open and closed and writes nothing', () => {
    const w = make()
    expect(nodes.map((n) => n.open)).toEqual([false])
    press(200, 100)
    expect(nodes.map((n) => n.open)).toEqual([true])
    expect(count(w)).toBe(1)
    press(200, 100)
    expect(nodes[0]!.open).toBe(false)
    expect(count(w)).toBe(1)
  })

  test('keyboard path: toggleTape(id)', () => {
    const w = make()
    w.toggleTape('t1')
    expect(nodes[0]!.open).toBe(true)
  })

  test('a move of 6 px or more is an ordinary stroke', () => {
    const w = make()
    press(200, 100, 50, [210, 100])
    expect(nodes[0]!.open).toBe(false)
    expect(count(w)).toBe(2)
  })

  test('a press outside the band is a stroke; select mode and eraser do not toggle', () => {
    const w = make()
    press(200, 200)
    expect(count(w)).toBe(2)
    w.setTool('lasso')
    press(200, 100)
    expect(nodes[0]!.open).toBe(false)
    w.setTool('eraser')
    press(200, 100)
    expect(count(w)).toBe(1) // the eraser took the tape whole; the dot from the first press is left
    expect(nodes).toEqual([])
  })

  test('a new Writer (note reopened) starts closed', () => {
    const w = make()
    w.toggleTape('t1')
    expect(make().history.note.pages[0]!.elements).toHaveLength(1)
    expect(nodes[0]!.open).toBe(false)
    void w
  })
})
