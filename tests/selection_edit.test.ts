// @vitest-environment jsdom
// Story 4.7: color, width, copy / cut / delete / paste of a selection (Writer) and the tab clipboard.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { elementClipboard } from '../src/model/elementClipboard'
import { defaultPen } from '../src/model/pen'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { Writer } from '../src/ui/library/writer'

const stroke = (id: string, pts: number[][]) => ({ id, type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: pts.map(([x, y]) => [x!, y!, 0.5, 0]) })

describe('Writer selection edit', () => {
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  const origCtx = proto.getContext
  let canvas: HTMLCanvasElement
  const ev = (name: string, x: number, y: number) =>
    canvas.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: name === 'pointerup' ? 0 : 1 }))

  function make(readOnly = false, noteId = 'n') {
    const r = createNote({ title: 't', existingTitles: [], background: 'plain', orientation: 'portrait', noteId, pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-11T00:00:00.000Z', editedBy: 'x' })
    if ('error' in r) throw new Error(r.error)
    r.note.pages[0]!.elements.push(stroke('a', [[100, 100], [200, 200]]))
    const w = new Writer(new History(r.note), { writeNote: async () => {}, close: () => {} } as never, () => defaultPen, () => {}, () => 'X')
    w.attach(canvas)
    w.setTool('lasso')
    ev('pointerdown', 100, 100)
    ev('pointerup', 100, 100)
    w.readOnly = readOnly
    return w
  }
  const els = (w: Writer) => w.history.note.pages[0]!.elements as { id: string; color: string; width: number; points: number[][] }[]

  beforeEach(() => {
    elementClipboard.set([])
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

  test('an image copies, pastes (same asset, new id) and deletes like any element', () => {
    const w = make()
    const img = { id: 'img1', type: 'image', x: 300, y: 300, width: 100, height: 80, rotation: 0, asset: 'a'.repeat(64), ext: 'png', pxWidth: 200, pxHeight: 160 }
    w.history.note.pages[0]!.elements.push(img as never)
    w.clearSelection()
    w.setTool('lasso')
    ev('pointerdown', 350, 340)
    ev('pointerup', 350, 340)
    expect(w.selectedCount).toBe(1)
    expect(w.copySelection()).toBe(true)
    expect(w.pasteClipboard()).toBe(true)
    const copies = (w.history.note.pages[0]!.elements as { id: string; type: string; asset?: string }[]).filter((e) => e.type === 'image')
    expect(copies).toHaveLength(2)
    expect(copies[1]!.asset).toBe(copies[0]!.asset)
    expect(copies[1]!.id).not.toBe('img1')
    expect(w.deleteSelection()).toBe(true)
  })

  test('color and width: one op each, one undo step', () => {
    const w = make()
    expect(w.setSelectionColor('#ff0000')).toBe(true)
    expect(w.setSelectionWidth(3.04)).toBe(true)
    expect(els(w)[0]).toMatchObject({ color: '#ff0000', width: 3 })
    expect(w.history.undoDepth).toBe(2)
    w.undo()
    expect(els(w)[0]!.width).toBe(2)
    w.undo()
    expect(els(w)[0]!.color).toBe('#000000')
    expect(w.setSelectionWidth(11)).toBe(false) // invalidWidth
  })

  test('copy then paste (also in another note) uses new ids, centered on the view, and selects the copy', () => {
    const clip = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip, readText: clip, write: clip, read: clip }, configurable: true })
    const a = make()
    expect(a.copySelection()).toBe(true)
    expect(a.history.undoDepth).toBe(0)
    expect(elementClipboard.size).toBe(1)
    const b = make(false, 'other')
    b.clearSelection()
    // a fresh note without elements: a copy of "a" lands there
    b.history.note.pages[0]!.elements.length = 0
    expect(b.pasteClipboard()).toBe(true)
    const [pasted] = els(b)
    expect(pasted!.id).not.toBe('a')
    expect(b.selectedCount).toBe(1)
    b.undo()
    expect(els(b)).toHaveLength(0)
    expect(clip).not.toHaveBeenCalled()
  })

  test('paste centers on the pointer when it is over the page', () => {
    const w = make()
    w.copySelection()
    ev('pointermove', 400, 500)
    expect(w.pasteClipboard()).toBe(true)
    const p = els(w)[1]!.points
    expect([(p[0]![0]! + p[1]![0]!) / 2, (p[0]![1]! + p[1]![1]!) / 2]).toEqual([400, 500])
  })

  test('cut: undo restores the elements and keeps the clipboard', () => {
    const w = make()
    expect(w.cutSelection()).toBe(true)
    expect(els(w)).toHaveLength(0)
    expect(w.history.undoDepth).toBe(1)
    expect(w.undo()).toBe(true)
    expect(els(w)).toHaveLength(1)
    expect(elementClipboard.size).toBe(1)
  })

  test('a cut that cannot delete leaves the clipboard alone', () => {
    const w = make()
    elementClipboard.set([stroke('old', [[1, 1], [2, 2]])])
    w.history.setLocked(['p'])
    expect(w.cutSelection()).toBe(false)
    expect(elementClipboard.get()[0]!.id).toBe('old')
  })

  test('delete: one op, undo brings it back', () => {
    const w = make()
    expect(w.deleteSelection()).toBe(true)
    expect(els(w)).toHaveLength(0)
    w.undo()
    expect(els(w)[0]!.id).toBe('a')
  })

  test('read-only: copy works; cut, delete, color, paste do nothing', () => {
    const w = make(true)
    expect(w.copySelection()).toBe(true)
    expect(w.cutSelection()).toBe(false)
    expect(w.deleteSelection()).toBe(false)
    expect(w.setSelectionColor('#ff0000')).toBe(false)
    expect(w.pasteClipboard()).toBe(false)
    expect(els(w)).toHaveLength(1)
    expect(w.history.undoDepth).toBe(0)
  })
})
