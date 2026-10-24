// @vitest-environment jsdom
// Story 4.10: text boxes on the writing surface (Writer), the format bar and the editor keys.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { elementClipboard } from '../src/model/elementClipboard'
import type { Note } from '../src/model/note'
import { defaultPen } from '../src/model/pen'
import { formatAt, retextRuns } from '../src/model/textEdit'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore, type NoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Writer } from '../src/ui/library/writer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const proto = HTMLCanvasElement.prototype
const origRect = proto.getBoundingClientRect
const origCtx = proto.getContext
const textBox = { id: 't1', type: 'text', x: 100, y: 100, width: 200, rotation: 0, text: 'abc', runs: [], size: 16, color: '#000000', bold: false, italic: false }

function newNote(readonlyPlaceholder = false): Note {
  const r = createNote({ title: 't', existingTitles: [], background: 'plain', orientation: 'portrait', noteId: 'n', pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-11T00:00:00.000Z', editedBy: 'x' })
  if ('error' in r) throw new Error(r.error)
  if (readonlyPlaceholder) r.note.pages[0]!.elements.push(structuredClone(textBox))
  return r.note
}
type Box = { id: string; type: string; text: string; runs: { start: number; end: number; bold?: boolean }[]; width: number; x: number; y: number }

describe('Writer text boxes', () => {
  let canvas: HTMLCanvasElement
  const ev = (name: string, x: number, y: number) =>
    canvas.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: name === 'pointerup' ? 0 : 1 }))
  const click = (x: number, y: number) => {
    ev('pointerdown', x, y)
    ev('pointerup', x, y)
  }
  const make = (withBox = false, readOnly = false) => {
    const w = new Writer(new History(newNote(withBox)), { writeNote: async () => {}, close: () => {} } as never, () => defaultPen, () => {}, () => 'X')
    w.readOnly = readOnly
    w.attach(canvas)
    return w
  }
  const boxes = (w: Writer) => w.history.note.pages[0]!.elements as unknown as Box[]

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

  test('text tool click starts a half-page-wide box; confirming is one createTextBox, one undo step', () => {
    const w = make()
    w.setTool('text')
    click(50, 60)
    expect(w.editing).toBe(true)
    expect(w.editInfo()!.width).toBeCloseTo(297.5 * w.info().scale, 5)
    w.editInput('안녕', 2, 2)
    w.commitEdit()
    expect(w.editing).toBe(false)
    expect(boxes(w)).toHaveLength(1)
    expect(boxes(w)[0]).toMatchObject({ type: 'text', text: '안녕', x: 50, y: 60, width: 297.5 })
    expect(w.history.undoDepth).toBe(1)
    w.undo()
    expect(boxes(w)).toHaveLength(0)
  })

  test('text tool click on a stored box edits it; on a stroke it still starts a new box', () => {
    const w = make(true)
    w.setTool('text')
    click(150, 108)
    expect(w.editing).toBe(true)
    expect(w.editInfo()!.text).toBe('abc')
    w.commitEdit()
    expect(boxes(w)).toHaveLength(1)
    // A stroke is under the second click: it does not block a new box.
    const w2 = make()
    w2.history.doOp({ op: 'addStroke', pageId: 'p', stroke: { id: 's1', type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: [[300, 300, 0.5, 0], [320, 300, 0.5, 10]] } as never }, { rev: 'r2', now: 'n', editedBy: 'X', lastSeenRemoteSeq: 0 })
    expect(w2.history.note.pages[0]!.elements).toHaveLength(1)
    w2.setTool('text')
    click(310, 300)
    expect(w2.editing).toBe(true)
    expect(w2.editInfo()!.text).toBe('')
  })

  test('side handle of the box in edit sets the width: one setTextBoxWidth, one undo step', () => {
    const w = make(true)
    w.setTool('text')
    click(150, 108)
    const before = w.history.undoDepth
    w.editWidth(60, true)
    w.editWidth(10, false) // the left handle dragged right narrows
    expect(w.editInfo()!.width).toBeCloseTo(250 * w.info().scale, 5)
    w.commitEdit()
    expect(boxes(w)[0]!.width).toBe(250)
    expect(w.history.undoDepth).toBe(before + 1)
    w.undo()
    expect(boxes(w)[0]!.width).toBe(200)
  })

  test('a press outside the box in edit confirms it; with the text tool it does not start the next box', () => {
    const w = make()
    w.setTool('text')
    click(50, 60)
    w.editInput('a', 1, 1)
    click(300, 400)
    expect(boxes(w)).toHaveLength(1)
    expect(w.editing).toBe(false)
  })

  test('blank content leaves no box and no history', () => {
    const w = make()
    w.setTool('text')
    click(50, 60)
    w.editInput('  \n ', 4, 4)
    w.commitEdit()
    expect(boxes(w)).toHaveLength(0)
    expect(w.history.undoDepth).toBe(0)
  })

  test('another tool confirms the box', () => {
    const w = make()
    w.setTool('text')
    click(50, 60)
    w.editInput('x', 1, 1)
    w.setTool('lasso')
    expect(boxes(w)).toHaveLength(1)
  })

  test('double click edits a stored box in any tool; confirming is one editText', () => {
    const w = make(true)
    click(150, 108)
    click(150, 108)
    expect(w.editing).toBe(true)
    expect(boxes(w)).toHaveLength(1) // the pen dot of the first click is taken back
    w.editInput('abcd', 4, 4)
    w.commitEdit()
    expect(boxes(w)[0]).toMatchObject({ id: 't1', text: 'abcd' })
    expect(w.history.undoDepth).toBe(1)
    w.undo()
    expect(boxes(w)[0]!.text).toBe('abc')
  })

  test('a stale dot is not taken back by a later double click', () => {
    const w = make(true)
    click(400, 600) // dot
    w.undo()
    click(400, 600) // dot again, then a real stroke far away
    ev('pointerdown', 20, 20)
    ev('pointermove', 60, 60)
    ev('pointerup', 60, 60)
    const strokes = () => boxes(w).filter((e) => e.type === 'stroke').length
    const n = strokes()
    click(150, 108)
    click(150, 108)
    expect(w.editing).toBe(true)
    expect(strokes()).toBe(n) // the first click's own dot is taken back, the real stroke stays
  })

  test('no change to a stored box is no operation', () => {
    const w = make(true)
    w.setTool('lasso')
    click(150, 108)
    click(150, 108)
    expect(w.editing).toBe(true)
    w.commitEdit()
    expect(w.history.undoDepth).toBe(0)
  })

  test('format: a selection gets the run, a caret formats the next input', () => {
    const w = make()
    w.setTool('text')
    click(50, 60)
    w.editInput('abc', 3, 3)
    w.editSelect(0, 2)
    w.editFormat({ bold: true })
    expect(w.editInfo()!.format.bold).toBe(true)
    w.editSelect(3, 3)
    expect(w.editInfo()!.format.bold).toBe(false)
    w.editFormat({ bold: true })
    expect(w.editInfo()!.format.bold).toBe(true) // waiting for the next input
    w.editInput('abcd', 4, 4)
    w.commitEdit()
    expect(boxes(w)[0]!.runs).toEqual([{ start: 0, end: 2, bold: true }, { start: 3, end: 4, bold: true }])
  })

  test('width handle drag is one setTextBoxWidth', () => {
    const w = make(true)
    w.setTool('lasso')
    click(150, 108) // selects the box
    expect(w.selectedCount).toBe(1)
    // The right side handle sits at (300, 111.2).
    ev('pointerdown', 300, 111)
    ev('pointermove', 350, 111)
    ev('pointerup', 350, 111)
    expect(boxes(w)[0]!.width).toBeCloseTo(250, 0)
    expect(w.history.undoDepth).toBe(1)
    w.undo()
    expect(boxes(w)[0]!.width).toBe(200)
  })

  test('system text: a new box in the middle, selected; blank, read-only and locked do nothing', () => {
    const w = make()
    const clip = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { read: clip, write: clip, readText: clip, writeText: clip }, configurable: true })
    expect(w.pasteText(' \n ')).toBe(false)
    expect(w.pasteText('hello\r\nworld')).toBe(true)
    expect(boxes(w)[0]).toMatchObject({ text: 'hello\nworld', width: 297.5 })
    expect(w.selectedCount).toBe(1)
    expect(w.history.undoDepth).toBe(1)
    expect(clip).not.toHaveBeenCalled()
    const ro = make(false, true)
    expect(ro.pasteText('x')).toBe(false)
    const locked = make()
    locked.history.setLocked(['p'])
    expect(locked.pasteText('x')).toBe(false)
  })

  test('read-only ignores the text tool, Enter and double click', () => {
    const w = make(true, true)
    w.setTool('text')
    click(50, 60)
    expect(w.editing).toBe(false)
    expect(w.createTextAtCenter()).toBe(false)
    w.setTool('pen')
    click(150, 108)
    click(150, 108)
    expect(w.editing).toBe(false)
  })

  test('Enter in the text tool: a box in the middle of the view', () => {
    const w = make()
    w.setTool('text')
    expect(w.createTextAtCenter()).toBe(true)
    expect(w.editing).toBe(true)
    const i = w.editInfo()!
    expect(i.left + i.width / 2).toBeCloseTo(297.5 * w.info().scale, 0)
  })
})

describe('run bookkeeping', () => {
  test('typing inherits the format before it; the typed format wins', () => {
    const runs = [{ start: 0, end: 2, bold: true }]
    expect(retextRuns('ab', 'abc', runs)).toEqual([{ start: 0, end: 3, bold: true }])
    expect(retextRuns('ab', 'abc', runs, { bold: false })).toEqual([{ start: 0, end: 2, bold: true }, { start: 2, end: 3, bold: false }])
    expect(retextRuns('ab', 'a', runs)).toEqual([{ start: 0, end: 1, bold: true }])
  })
  test('a typed char equal to its neighbour does not shift formatted runs', () => {
    const runs = [{ start: 0, end: 1, bold: true }]
    // typed at the front of "aa" (caret 1)
    expect(retextRuns('aa', 'aaa', runs, { bold: true }, 1)).toEqual([{ start: 0, end: 2, bold: true }])
    expect(retextRuns('aa', 'aaa', runs, { bold: false }, 1)).toEqual([{ start: 0, end: 1, bold: false }, { start: 1, end: 2, bold: true }])
  })
  test('a composition replacing a char keeps its format', () => {
    expect(retextRuns('ㅎ', '하', [{ start: 0, end: 1, bold: true }], {}, 1)).toEqual([{ start: 0, end: 1, bold: true }])
  })
  test('the format at a caret is the one before it', () => {
    const el = { size: 16, bold: false }
    const runs = [{ start: 0, end: 1, bold: true, size: 24 }]
    expect(formatAt(el, 'ab', runs, [1, 1], null)).toMatchObject({ bold: true, size: 24 })
    expect(formatAt(el, 'ab', runs, [0, 2], null)).toMatchObject({ bold: false, size: null })
  })
})

describe('editor', () => {
  let host: HTMLElement
  let root: Root
  const stores: NoteStore[] = []
  const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
  const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
    act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))

  async function mount(lang = 'ko-KR') {
    const s = openNoteStore()
    await s.writeNote(newNote())
    s.close()
    act(() =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: createI18n({ navigatorLanguage: lang, storage: { getItem: () => null, setItem: () => {} } }) },
          createElement(NoteEditor, {
            noteId: 'n',
            openStore: () => {
              const st = openNoteStore()
              stores.push(st)
              return st
            },
          }),
        ),
      ),
    )
    await settle()
    await settle()
  }

  beforeEach(() => {
    proto.getBoundingClientRect = () => ({ width: 595, height: 842, left: 0, top: 0, right: 595, bottom: 842, x: 0, y: 0, toJSON() {} }) as DOMRect
    proto.getContext = (() => null) as never
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    location.hash = ''
    clearSessionHistories()
  })
  afterEach(async () => {
    act(() => root.unmount())
    await savesSettled()
    host.remove()
    for (const s of stores.splice(0)) s.close()
    await deleteNoteDatabase()
    proto.getBoundingClientRect = origRect
    proto.getContext = origCtx
  })

  test('T picks the text tool; Enter starts a box with the format bar; shortcuts are letters while typing; Esc confirms', async () => {
    await mount()
    const btn = q<HTMLButtonElement>('button[data-tool="text"]')!
    expect(btn.getAttribute('aria-label')).toBe('텍스트')
    expect(btn.title).toBe('텍스트 (T)')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    const canvas = q<HTMLCanvasElement>('canvas.editor-canvas')!
    canvas.focus()
    key(canvas, 't')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    key(canvas, 'Enter')
    await settle()
    const area = q<HTMLTextAreaElement>('textarea.text-edit-area')!
    expect(area).toBeTruthy()
    expect(area.getAttribute('aria-label')).toBe('텍스트 상자 편집')
    // Bar: size, color, bold, italic.
    const bar = q('[aria-label="글자 서식"]')!
    const kids = [...bar.children]
    expect(kids.map((k) => k.tagName)).toEqual(['SELECT', 'BUTTON', 'BUTTON', 'BUTTON'])
    expect(kids[0]!.getAttribute('aria-label')).toBe('글자 크기, 16')
    expect(kids[1]!.getAttribute('aria-label')).toBe('글자 색, 검정')
    expect(kids[2]!.getAttribute('aria-label')).toBe('굵게, 꺼짐')
    expect(kids[3]!.getAttribute('aria-label')).toBe('기울임, 꺼짐')
    act(() => (kids[2] as HTMLElement).click())
    expect(bar.children[2]!.getAttribute('aria-label')).toBe('굵게, 켜짐')
    expect(bar.children[2]!.getAttribute('aria-pressed')).toBe('true')
    // Typing: letters are letters.
    area.value = '안녕 l'
    act(() => void area.dispatchEvent(new Event('input', { bubbles: true })))
    key(area, 'l')
    key(area, 't')
    key(area, '1')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(q('button[data-tool="lasso"]')!.getAttribute('aria-pressed')).toBe('false')
    // Esc during a composition only settles the composition.
    key(area, 'Escape', { isComposing: true })
    expect(q('textarea.text-edit-area')).toBeTruthy()
    key(area, 'Escape')
    await settle()
    expect(q('textarea.text-edit-area')).toBeNull()
    expect(q('[aria-label="글자 서식"]')).toBeNull()
    expect([...host.querySelectorAll('ul[aria-label="텍스트 상자"] li')].map((li) => li.textContent)).toEqual(['안녕 l'])
  })

  test('Ctrl+B in the box formats the next input', async () => {
    await mount()
    const canvas = q<HTMLCanvasElement>('canvas.editor-canvas')!
    canvas.focus()
    key(canvas, 't')
    key(canvas, 'Enter')
    await settle()
    const area = q<HTMLTextAreaElement>('textarea.text-edit-area')!
    key(area, 'b', { ctrlKey: true })
    expect(q('[aria-label="글자 서식"]')!.children[2]!.getAttribute('aria-pressed')).toBe('true')
  })

  test('the paste event reads text from the event data and never the async clipboard', async () => {
    await mount()
    elementClipboard.set([])
    const read = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { read, write: read, readText: read, writeText: read }, configurable: true })
    const canvas = q<HTMLCanvasElement>('canvas.editor-canvas')!
    canvas.focus()
    const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
    e.clipboardData = { getData: (t: string) => (t === 'text/plain' ? '붙인 글' : '') }
    act(() => void canvas.dispatchEvent(e))
    await settle()
    expect([...host.querySelectorAll('ul[aria-label="텍스트 상자"] li')].map((li) => li.textContent)).toEqual(['붙인 글'])
    // A clipboard with no text (an image, say) is ignored.
    const none = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
    none.clipboardData = { getData: () => '' }
    act(() => void canvas.dispatchEvent(none))
    expect(host.querySelectorAll('ul[aria-label="텍스트 상자"] li')).toHaveLength(1)
    expect(read).not.toHaveBeenCalled()
  })
})
