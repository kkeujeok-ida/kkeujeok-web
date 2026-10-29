// @vitest-environment jsdom
// Writing screen: input -> addStroke -> serial saves, rendering, semantics (story 2.10).
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nContext, createI18n, resources } from '../src/i18n'
import type { Note, Page, Stroke } from '../src/model/note'
import { defaultPen, defaultPenSlots } from '../src/model/pen'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { clearSessionHistories, sessionHistory } from '../src/ops/sessionHistories'
import { StrokePathCache, fitViewport, paintPage } from '../src/render/pagePainter'
import { pageBackground } from '../src/render/pageBackground'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { acquireNoteLock } from '../src/storage/noteLock'
import { PEN_SLOTS_KEY, createPenSlots, sharedPenSlots, type PenSlotsStore } from '../src/storage/penSlots'
import { ERASER_KEY, createEraserSettings, type EraserSettingsStore } from '../src/storage/eraserSettings'
import { TOOLBAR_KEY, createToolbarPosition, type ToolbarPositionStore } from '../src/storage/toolbarPosition'
import { createViewMode, type ViewModeStore } from '../src/storage/viewMode'
import { createPenDetected, type PenDetectedStore } from '../src/storage/penDetected'
import { RECENT_COLORS_KEY, createRecentColors, type RecentColorsStore } from '../src/storage/recentColors'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { SaveQueue, savesSettled, trackSave } from '../src/storage/saveQueue'
import { getOpenNote } from '../src/sync/openNotes'
import { App } from '../src/ui/App'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Writer } from '../src/ui/library/writer'
import { publishNoteOrder } from '../src/ui/library/noteOrder'
import { fakeLocks, signedIn } from './helpers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has neither Path2D nor a canvas: record what is filled.
class FakePath {
  ops: string[] = []
  moveTo(x: number, y: number) {
    this.ops.push(`M${x},${y}`)
  }
  lineTo(x: number, y: number) {
    this.ops.push(`L${x},${y}`)
  }
  closePath() {
    this.ops.push('Z')
  }
}
let fills: FakePath[] = []
let contextCalls = 0
const fakeCtx = new Proxy(
  {},
  {
    get: (_t, k) => (k === 'fill' ? (p: unknown) => void (p instanceof FakePath && fills.push(p)) : () => void contextCalls++),
    set: () => true,
  },
)
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never

let host: HTMLElement
let root: Root
let stores: NoteStore[] = []
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const flush = async () => {
  await settle()
  await settle()
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
const qa = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)]
const click = (el: Element) => act(() => (el as HTMLElement).click())

function i18nFor(lang: string) {
  return createI18n({ navigatorLanguage: lang, storage: { getItem: () => null, setItem: () => {} } })
}
type Opts = Parameters<typeof openNoteStore>[1]
const makeOpen = (opts: Opts = {}) => () => {
  const s = openNoteStore(undefined, opts)
  stores.push(s)
  return s
}

function newNote(id = 'n1', orientation = 'portrait', background = 'lined'): Note {
  const r = createNote({
    title: '필기 노트',
    existingTitles: [],
    background,
    orientation,
    noteId: id,
    pageId: `${id}-p`,
    pageRev: 'r',
    metaRev: 'm',
    orderRev: 'o',
    now: '2026-10-11T00:00:00.000Z',
    editedBy: 'Chrome, Windows',
  })
  if ('error' in r) throw new Error(r.error)
  return r.note
}
async function seed(note: Note) {
  const s = openNoteStore()
  await s.writeNote(note)
  s.close()
}
async function saved(id = 'n1'): Promise<Note> {
  const s = openNoteStore()
  const r = await s.loadNote(id)
  s.close()
  if (r?.result !== 'ok' || !r.note) throw new Error('not saved')
  return r.note
}
const strokesOf = (n: Note) => n.pages[0]!.elements as Stroke[]

async function mountEditor(o: { id?: string; lang?: string; opts?: Opts; note?: Note | null; pens?: PenSlotsStore; recent?: RecentColorsStore; eraser?: EraserSettingsStore; toolbar?: ToolbarPositionStore; viewMode?: ViewModeStore; penDetected?: PenDetectedStore; lockWaitMs?: number } = {}) {
  const id = o.id ?? 'n1'
  if (o.note !== null) await seed(o.note ?? newNote(id))
  act(() =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: i18nFor(o.lang ?? 'ko-KR') },
        createElement(NoteEditor, { noteId: id, openStore: makeOpen(o.opts), penStore: o.pens, recentStore: o.recent, eraserStore: o.eraser ?? createEraserSettings({ getItem: () => null, setItem: () => {} }), toolbarStore: o.toolbar ?? createToolbarPosition({ getItem: () => null, setItem: () => {} }), viewModeStore: o.viewMode ?? createViewMode({ getItem: () => null, setItem: () => {} }), penDetectedStore: o.penDetected ?? createPenDetected({ getItem: () => null, setItem: () => {} }), ...(o.lockWaitMs !== undefined && { lockWaitMs: o.lockWaitMs }) }),
      ),
    ),
  )
  await flush()
}
const canvas = () => q<HTMLCanvasElement>('canvas.editor-canvas')!

let clock = 1000
type PInit = { type?: string; x: number; y: number; pressure?: number; button?: number; buttons?: number; id?: number; t?: number }
function pev(name: string, o: PInit, co?: PInit[]) {
  const mk = (p: PInit, n: string) => {
    const e = new PointerEvent(n, {
      bubbles: true,
      cancelable: true,
      pointerId: p.id ?? 1,
      pointerType: p.type ?? 'pen',
      clientX: p.x,
      clientY: p.y,
      pressure: p.pressure ?? 0.5,
      button: p.button ?? 0,
      buttons: p.buttons ?? 1,
    })
    Object.defineProperty(e, 'timeStamp', { value: p.t ?? (clock += 10) })
    return e
  }
  const e = mk(o, name)
  if (co) Object.defineProperty(e, 'getCoalescedEvents', { value: () => co.map((c) => mk(c, name)) })
  return e
}
const fire = (name: string, o: PInit, co?: PInit[]) => {
  const e = pev(name, o, co)
  act(() => void canvas().dispatchEvent(e))
  return e
}
const key = (el: Element | Document, k: string, init: KeyboardEventInit = {}) =>
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  location.hash = ''
  fills = []
  clearSessionHistories()
})
afterEach(async () => {
  act(() => root.unmount())
  await savesSettled()
  host.remove()
  for (const s of stores) s.close()
  stores = []
  await deleteNoteDatabase()
})

describe('semantics', () => {
  test('corner, toolbar, radiogroup slot and the page canvas', async () => {
    await mountEditor()
    expect(q('.editor-title')).toBeNull()
    const tb = q('[role="toolbar"]')!
    expect(tb.getAttribute('aria-label')).toBe('툴바')
    expect(tb.querySelector('.toolbar-grip')!.getAttribute('aria-label')).toBe('툴바 위치 바꾸기')
    const radios = qa('[role="radiogroup"] [role="radio"]')
    expect(radios).toHaveLength(3)
    expect(qa('[role="radiogroup"]')).toHaveLength(1)
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
    expect(radios[0]!.getAttribute('aria-label')).toBe('펜, 검정, 두께 2.0 (1)')
    expect(radios.map((r) => r.querySelector('.pen-width')!.textContent)).toEqual(['2.0', '2.0', '14.0'])
    expect(radios[0]!.querySelector('.pen-dot')).toBeNull()
    expect(canvas().getAttribute('aria-label')).toBe('1페이지 / 1, 세로')
    expect(canvas().hasAttribute('aria-current')).toBe(false)
    expect(q('.editor-page-area')!.getAttribute('aria-label')).toBe('필기 영역: 1페이지 / 1, 세로')
    expect(document.getElementById(canvas().getAttribute('aria-describedby')!)!.textContent).toBe('손글씨')
    expect(document.activeElement).toBe(q('.editor-back'))
  })

  test('landscape and English', async () => {
    await mountEditor({ note: newNote('n1', 'landscape'), lang: 'en-US' })
    expect(canvas().getAttribute('aria-label')).toBe('Page 1 of 1, Landscape')
    expect(q('[role="radio"]')!.getAttribute('aria-label')).toBe('Pen, Black, width 2.0 (1)')
    expect(q('[role="toolbar"]')!.getAttribute('aria-label')).toBe('Toolbar')
  })

  test('editor strings exist in ko and en', () => {
    const keys = Object.keys(resources.ko).filter((k) => k.startsWith('editor.'))
    expect(keys).toEqual(
      expect.arrayContaining(['editor.undo', 'editor.redo', 'editor.undoTip', 'editor.redoTip', 'editor.historyNotApplied', 'editor.penSlot', 'editor.color.black', 'editor.color.lavender', 'editor.colorCustom', 'editor.highlighterSlot', 'editor.addSlot', 'editor.addSlotTip', 'editor.slotMoved', 'editor.deleteSlot', 'editor.slotDeleted', 'editor.undoDelete', 'editor.page', 'editor.handwriting', 'editor.saveFailed', 'editor.strokeNotAdded', 'editor.toolbar', 'editor.canvas', 'editor.more', 'editor.zoomOut', 'editor.zoomIn', 'editor.zoomLevel', 'editor.fitWidth', 'editor.fitPage', 'editor.zoomOutTip', 'editor.zoomInTip', 'editor.fitWidthTip']),
    )
    expect(Object.keys(resources.en).filter((k) => k.startsWith('editor.'))).toEqual(keys)
  })

  test('F6 and Shift+F6 cycle corner, toolbar, canvas; 1 selects the slot', async () => {
    await mountEditor()
    const back = q('.editor-back')!
    const slot = q('[role="radio"]')!
    key(document.activeElement!, 'F6')
    expect(document.activeElement).toBe(slot)
    key(document.activeElement!, 'F6')
    expect(document.activeElement).toBe(canvas())
    key(document.activeElement!, 'F6')
    expect(document.activeElement).toBe(back)
    key(document.activeElement!, 'F6', { shiftKey: true })
    expect(document.activeElement).toBe(canvas())
    key(canvas(), '1')
    expect(slot.getAttribute('aria-checked')).toBe('true')
  })
})

describe('sidebar and empty notes', () => {
  const mountApp = async () => {
    act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(App, { auth: signedIn }))))
    await flush()
  }
  test('the sidebar is inert behind the writing screen only', async () => {
    await seed(newNote('n1'))
    await mountApp()
    expect(q('nav')!.hasAttribute('inert')).toBe(false)
    location.hash = '#/notes/n1'
    await flush()
    await flush()
    expect(q('nav')!.hasAttribute('inert')).toBe(true)
    location.hash = '#/'
    await flush()
    expect(q('nav')!.hasAttribute('inert')).toBe(false)
    click(qa('nav button').find((b) => b.textContent === '설정')!)
    expect(q('nav')!.hasAttribute('inert')).toBe(false)
  })

  test('a note without pages goes back to the library', async () => {
    const n = newNote('n1')
    n.pages = []
    location.hash = '#/notes/n1'
    await mountEditor({ note: n })
    expect(q('canvas')).toBeNull()
    expect(location.hash.startsWith('#/notes/')).toBe(false)
  })
})

describe('input', () => {
  test('pen: pressure per point including coalesced events; saved at once', async () => {
    await mountEditor()
    fire('pointerdown', { x: 100, y: 100, pressure: 0.2 })
    fire('pointermove', { x: 110, y: 100, pressure: 0.6 }, [
      { x: 104, y: 100, pressure: 0.4 },
      { x: 110, y: 100, pressure: 0.6 },
    ])
    fire('pointerup', { x: 120, y: 100, pressure: 0 })
    await flush()
    const [s] = strokesOf(await saved())
    expect(s!.tool).toBe('pen')
    expect(s!.color).toBe('#000000')
    expect(s!.width).toBe(2)
    expect(s!.usePressure).toBe(true)
    expect(s!.points.map((p) => p[2])).toEqual([0.2, 0.4, 0.6, 0.6]) // release keeps the last pressure
    expect(s!.points.map((p) => p[0])).toEqual([100, 104, 110, 120])
    expect(s!.points.every((p) => p[2]! >= 0 && p[2]! <= 1 && p[3]! >= 0)).toBe(true)
  })

  test('mouse and touch: every pressure is 0.5', async () => {
    await mountEditor()
    fire('pointerdown', { type: 'mouse', x: 10, y: 10, pressure: 0.9 })
    fire('pointermove', { type: 'mouse', x: 30, y: 10, pressure: 0.1 })
    fire('pointerup', { type: 'mouse', x: 50, y: 10 })
    fire('pointerdown', { type: 'touch', x: 10, y: 50, pressure: 1 })
    fire('pointermove', { type: 'touch', x: 30, y: 50, pressure: 0 })
    fire('pointerup', { type: 'touch', x: 50, y: 50 })
    await flush()
    const strokes = strokesOf(await saved())
    expect(strokes).toHaveLength(2)
    for (const s of strokes) expect(s.points.every((p) => p[2] === 0.5)).toBe(true)
  })

  test('secondary buttons, the eraser end and the context menu make nothing', async () => {
    await mountEditor()
    for (const init of [{ button: 1 }, { button: 2, buttons: 2 }, { buttons: 32 }]) {
      fire('pointerdown', { type: init.buttons === 32 ? 'pen' : 'mouse', x: 20, y: 20, ...init })
      fire('pointermove', { type: 'mouse', x: 40, y: 40 })
      fire('pointerup', { type: 'mouse', x: 40, y: 40, ...init })
    }
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => void canvas().dispatchEvent(menu))
    expect(menu.defaultPrevented).toBe(true)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)
  })

  test('a start outside the page makes no stroke and no save; unknown pointer types are ignored', async () => {
    let writes = 0
    await mountEditor({ opts: { afterPut: () => void writes++ } })
    fire('pointerdown', { x: -5, y: 100 })
    fire('pointermove', { x: 100, y: 100 })
    fire('pointerup', { x: 100, y: 120 })
    fire('pointerdown', { x: 600, y: 100 }) // right of the 595 pt page
    fire('pointerup', { x: 600, y: 100 })
    fire('pointerdown', { type: 'unknown', x: 100, y: 100 })
    fire('pointerup', { type: 'unknown', x: 100, y: 100 })
    await flush()
    expect(writes).toBe(0)
    expect(strokesOf(await saved())).toHaveLength(0)
  })

  test('leaving the page keeps every point', async () => {
    await mountEditor()
    fire('pointerdown', { x: 590, y: 400 })
    fire('pointermove', { x: 700, y: 400 })
    fire('pointermove', { x: 900, y: -50 })
    fire('pointerup', { x: 900, y: -50 })
    await flush()
    const [s] = strokesOf(await saved())
    expect(s!.points.map((p) => [p[0], p[1]])).toEqual([[590, 400], [700, 400], [900, -50]])
  })

  test('a tap is a one-point stroke; pointercancel ends the stroke with its points', async () => {
    await mountEditor()
    fire('pointerdown', { x: 50, y: 50 })
    fire('pointerup', { x: 50, y: 50 })
    fire('pointerdown', { x: 80, y: 80 })
    fire('pointermove', { x: 90, y: 85 })
    fire('pointercancel', { x: 90, y: 85 })
    await flush()
    const strokes = strokesOf(await saved())
    expect(strokes.map((s) => s.points.length)).toEqual([1, 2])
  })

  test('only the first pointer draws', async () => {
    await mountEditor()
    // The second finger comes after the 150 ms window: it is ignored.
    fire('pointerdown', { type: 'touch', id: 1, x: 10, y: 10, t: 1000 })
    fire('pointerdown', { type: 'touch', id: 2, x: 200, y: 200, t: 1200 })
    fire('pointermove', { type: 'touch', id: 2, x: 220, y: 200 })
    fire('pointerup', { type: 'touch', id: 2, x: 220, y: 200 })
    fire('pointermove', { type: 'touch', id: 1, x: 30, y: 10 })
    fire('pointerup', { type: 'touch', id: 1, x: 30, y: 10 })
    await flush()
    const strokes = strokesOf(await saved())
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.points.map((p) => p[0])).toEqual([10, 30])
  })

  test('the stroke goes through History: ids, page touch', async () => {
    await mountEditor()
    fire('pointerdown', { x: 10, y: 10 })
    fire('pointerup', { x: 10, y: 10 })
    await flush()
    const n = await saved()
    const p = n.pages[0]!
    expect(p.seq).toBe(2)
    expect(p.rev).not.toBe('r')
    expect(p.editedBy).toMatch(/\S/)
    expect(strokesOf(n)[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('saving', () => {
  test('a failed save shows the snackbar and the next stroke saves the whole note', async () => {
    let fail = true
    await mountEditor({
      opts: {
        afterPut: () => {
          if (fail) throw new Error('quota')
        },
      },
    })
    fire('pointerdown', { x: 10, y: 10 })
    fire('pointerup', { x: 30, y: 10 })
    await flush()
    expect(q('[role="status"]')!.textContent).toBe('이 브라우저에 저장하지 못했어요.')
    expect(strokesOf(await saved())).toHaveLength(0)

    fail = false
    fire('pointerdown', { x: 10, y: 50 })
    fire('pointerup', { x: 30, y: 50 })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(2)
  })

  test('SaveQueue: one write at a time, only the newest waits, failure is retried on flush', async () => {
    const written: string[] = []
    let active = 0
    let maxActive = 0
    const releases: (() => void)[] = []
    let failNext = false
    const store = {
      writeNote: async (n: Note) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((r) => releases.push(r))
        active--
        if (failNext) throw new Error('x')
        written.push(n.metaRev)
      },
    }
    let fails = 0
    const queue = new SaveQueue(store, () => void fails++)
    const n = (rev: string) => ({ ...newNote(), metaRev: rev })
    queue.commit(n('a'))
    queue.commit(n('b'))
    queue.commit(n('c'))
    await Promise.resolve()
    expect(releases).toHaveLength(1)
    releases.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(releases).toHaveLength(1) // the second write is c: b was superseded
    failNext = true
    releases.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(written).toEqual(['a'])
    expect(fails).toBe(1)

    failNext = false
    const done = queue.flush() // retries the failed snapshot once
    await new Promise((r) => setTimeout(r, 0))
    releases.shift()!()
    await done
    expect(written).toEqual(['a', 'c'])
    expect(maxActive).toBe(1)
  })

  test('trackSave keeps savesSettled waiting', async () => {
    let done!: () => void
    trackSave(new Promise<void>((r) => (done = r)))
    let settled = false
    void savesSettled().then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    done()
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(true)
  })
})

describe('failures', () => {
  test('a stroke that is not added shows the snackbar, which clears itself', async () => {
    await mountEditor()
    const spy = vi.spyOn(History.prototype, 'doOp').mockReturnValue('invalidStroke')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fire('pointerdown', { x: 10, y: 10 })
      fire('pointerup', { x: 30, y: 10 })
      expect(q('[role="status"]')!.textContent).toBe('획을 추가하지 못했어요.')
      act(() => void vi.advanceTimersByTime(4000))
      expect(q('[role="status"]')!.textContent).toBe('')
    } finally {
      vi.useRealTimers()
      spy.mockRestore()
    }
  })

  test('a throwing finish does not strand the user: back still leaves and closes the store', async () => {
    await seed(newNote('n1'))
    let closed = 0
    const open = () => {
      const s = openNoteStore()
      stores.push(s)
      return { ...s, close: () => { closed++; s.close() } } as NoteStore
    }
    act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore: open }))))
    await flush()
    location.hash = '#/notes/n1'
    fire('pointerdown', { x: 10, y: 10 })
    fire('pointermove', { x: 40, y: 10 })
    const spy = vi.spyOn(History.prototype, 'doOp').mockImplementation(() => {
      throw new Error('boom')
    })
    click(q('.editor-back')!)
    await flush()
    await flush()
    spy.mockRestore()
    expect(location.hash.startsWith('#/notes/')).toBe(false)
    expect(closed).toBe(1)
  })

  test('a pen takes over from a touch stroke, which is discarded', async () => {
    await mountEditor()
    fire('pointerdown', { type: 'touch', id: 1, x: 10, y: 10 })
    fire('pointermove', { type: 'touch', id: 1, x: 20, y: 10 })
    fire('pointerdown', { type: 'pen', id: 2, x: 100, y: 100 })
    fire('pointerup', { type: 'pen', id: 2, x: 100, y: 100 })
    fire('pointerup', { type: 'touch', id: 1, x: 20, y: 10 })
    await flush()
    const strokes = strokesOf(await saved())
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.points[0]!.slice(0, 2)).toEqual([100, 100])
  })
})

describe('leaving', () => {
  test('back finishes the stroke, saves, ignores later input and leaves even when the retry fails', async () => {
    let failing = false
    await mountEditor({
      opts: {
        afterPut: () => {
          if (failing) throw new Error('quota')
        },
      },
    })
    location.hash = '#/notes/n1'
    fire('pointerdown', { x: 10, y: 10 })
    fire('pointermove', { x: 40, y: 10 })
    failing = true
    click(q('.editor-back')!) // the stroke in progress ends; its save fails
    fire('pointerdown', { x: 100, y: 100 }) // leaving: ignored
    fire('pointerup', { x: 100, y: 100 })
    await flush()
    await flush()
    expect(location.hash.startsWith('#/notes/')).toBe(false) // back to the library
    failing = false
    expect(strokesOf(await saved())).toHaveLength(0)
  })

  test('back saves the stroke in progress', async () => {
    await mountEditor()
    fire('pointerdown', { x: 10, y: 10 })
    fire('pointermove', { x: 40, y: 10 })
    click(q('.editor-back')!)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('unmounting (browser back) finishes saving in the background', async () => {
    await mountEditor()
    fire('pointerdown', { x: 10, y: 10 })
    fire('pointermove', { x: 40, y: 10 })
    act(() => root.render(createElement('div')))
    await savesSettled()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('app: draw, go back; the library card shows the stroke', async () => {
    await seed(newNote('n1'))
    act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(App, { auth: signedIn }))))
    await flush()
    contextCalls = 0
    fills = []
    expect(qa('a.cover-card')).toHaveLength(1)
    expect(fills).toHaveLength(0) // an empty page draws no stroke

    location.hash = '#/notes/n1'
    await flush()
    await flush()
    expect(canvas()).not.toBeNull()
    fire('pointerdown', { x: 100, y: 100 })
    fire('pointermove', { x: 140, y: 120 })
    fire('pointerup', { x: 180, y: 100 })
    await flush()
    fills = []
    // Thumbnails wait for a laid-out card; give the cards a size.
    const proto = HTMLCanvasElement.prototype
    const orig = proto.getBoundingClientRect
    proto.getBoundingClientRect = () => ({ width: 150, height: 200, left: 0, top: 0, right: 150, bottom: 200, x: 0, y: 0, toJSON() {} })
    try {
      click(q('.editor-back')!)
      await flush()
      await flush()
      expect(q('.editor')).toBeNull()
      expect(fills.length).toBeGreaterThan(0) // the thumbnail drew the new stroke
    } finally {
      proto.getBoundingClientRect = orig
    }
  })
})

describe('render', () => {
  const stroke = (id: string, points: number[][], over: Partial<Stroke> = {}): Stroke => ({
    id,
    type: 'stroke',
    tool: 'pen',
    color: '#000000',
    width: 2,
    usePressure: true,
    points,
    ...over,
  })
  const pageWith = (elements: unknown[], over: Partial<Page> = {}): Page => ({ ...newNote().pages[0]!, elements, ...over })

  test('finished outlines are cached by id and key; keepOnly forgets the rest', () => {
    const c = new StrokePathCache()
    const s = stroke('a', [[0, 0, 0.5, 0], [10, 0, 0.5, 5]])
    const p = c.pathOf(s)
    expect(c.pathOf({ ...s })).toBe(p)
    expect(c.pathOf(stroke('a', [[0, 0, 0.5, 0], [10, 0, 0.5, 5], [20, 0, 0.5, 9]]))).not.toBe(p) // count
    const q1 = c.pathOf(stroke('b', [[0, 0, 0.5, 0], [10, 0, 0.5, 5]]))
    expect(c.pathOf(stroke('b', [[0, 0, 0.5, 0], [10, 0, 0.5, 5]], { width: 3 }))).not.toBe(q1) // width
    const q2 = c.pathOf(stroke('b', [[0, 0, 0.5, 0], [10, 0, 0.5, 5]], { width: 3 }))
    expect(c.pathOf(stroke('b', [[0, 0, 0.5, 0], [10, 0, 0.5, 5]], { width: 3, usePressure: false }))).not.toBe(q2)
    const q3 = c.pathOf(stroke('c', [[0, 0, 0.5, 0], [10, 0, 0.5, 5]]))
    expect(c.pathOf(stroke('c', [[1, 0, 0.5, 0], [10, 0, 0.5, 5]]))).not.toBe(q3) // first point
    c.keepOnly(new Set(['a']))
    expect(c.pathOf(s)).toBe(c.pathOf(s))
  })

  test('a repaint reuses the cached outline', () => {
    const cache = new StrokePathCache()
    const page = pageWith([stroke('a', [[10, 10, 0.5, 0], [50, 50, 0.5, 9]])])
    const vp = fitViewport(0, 0, 595, 842)
    paintPage(fakeCtx as CanvasRenderingContext2D, page, vp, cache)
    paintPage(fakeCtx as CanvasRenderingContext2D, page, vp, cache)
    expect(fills).toHaveLength(2)
    expect(fills[0]).toBe(fills[1])
  })

  test('bad elements and bad sizes are skipped without throwing', () => {
    const cache = new StrokePathCache()
    const vp = { scale: 1, offsetX: 0, offsetY: 0 }
    const page = pageWith([
      null,
      7,
      { id: 'x', type: 'text' },
      stroke('nan', [[Number.NaN, 0, 0.5, 0]]),
      { ...stroke('eraser', [[1, 1, 0.5, 0]]), tool: 'eraser' },
      stroke('ok', [[10, 10, 0.5, 0]], { color: 'not a color' }),
    ])
    expect(() => paintPage(fakeCtx as CanvasRenderingContext2D, page, vp, cache)).not.toThrow()
    expect(fills).toHaveLength(1)
    fills = []
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      paintPage(fakeCtx as CanvasRenderingContext2D, pageWith([], { width: bad }), vp, cache)
      paintPage(fakeCtx as CanvasRenderingContext2D, pageWith([stroke('z', [[1, 1, 0.5, 0]])], { height: bad }), vp, cache)
    }
    expect(fills).toHaveLength(0)
    expect(() => paintPage(fakeCtx as CanvasRenderingContext2D, pageWith([]), { scale: 0, offsetX: 0, offsetY: 0 }, cache)).not.toThrow()
  })

  // A recording context: every call and every assignment, in order.
  const recorder = () => {
    const calls: [string, unknown[]][] = []
    const sets: [string, unknown][] = []
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) => (...a: unknown[]) => void calls.push([String(k), a]),
        set: (_t, k, v) => {
          sets.push([String(k), v])
          return true
        },
      },
    )
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, sets }
  }
  const vp = { scale: 1, offsetX: 0, offsetY: 0 }
  const count = (calls: [string, unknown[]][], name: string) => calls.filter(([n]) => n === name).length

  test('lined and grid lines and dot arcs are drawn; an invalid color is black', () => {
    const cache = new StrokePathCache()
    for (const bg of ['lined', 'grid', 'dot'] as const) {
      const r = recorder()
      paintPage(r.ctx, pageWith([], { background: bg }), vp, cache)
      const geo = pageBackground(bg, 595, 842)
      expect(geo.lines.length + geo.dots.length).toBeGreaterThan(0)
      expect(count(r.calls, 'lineTo')).toBe(geo.lines.length)
      expect(count(r.calls, 'arc')).toBe(geo.dots.length)
      expect(r.sets.some(([k, v]) => k === 'strokeStyle' && v === '#c5ced8')).toBe(bg !== 'dot')
      expect(r.sets.some(([k, v]) => k === 'fillStyle' && v === '#a0aab5')).toBe(bg === 'dot')
    }
    const r = recorder()
    paintPage(r.ctx, pageWith([stroke('c', [[10, 10, 0.5, 0]], { color: 'bogus' })]), vp, cache)
    expect(r.sets.filter(([k]) => k === 'fillStyle').pop()![1]).toBe('#000000')
  })

  test('a huge page gets paper only, not a million dots', () => {
    const r = recorder()
    paintPage(r.ctx, pageWith([], { background: 'dot', width: 1e6, height: 1e6 }), vp, new StrokePathCache())
    expect(count(r.calls, 'arc')).toBe(0)
    expect(count(r.calls, 'fillRect')).toBe(1)
  })

  test('an edit inside a stroke invalidates its cached outline', () => {
    const c = new StrokePathCache()
    const a = c.pathOf(stroke('m', [[0, 0, 0.5, 0], [5, 5, 0.5, 1], [10, 0, 0.5, 2]]))
    expect(c.pathOf(stroke('m', [[0, 0, 0.5, 0], [5, 9, 0.5, 1], [10, 0, 0.5, 2]]))).not.toBe(a)
  })

  test('background geometry is computed once per (background, w, h)', () => {
    expect(pageBackground('grid', 595, 842)).toBe(pageBackground('grid', 595, 842))
    expect(pageBackground('grid', 595, 842)).not.toBe(pageBackground('grid', 842, 595))
    expect(pageBackground('mystery', 100, 100).lines).toEqual([])
  })
})

describe('undo and redo (story 2.11)', () => {
  const undoBtn = () => q<HTMLButtonElement>('button[aria-label="실행 취소"]')!
  const redoBtn = () => q<HTMLButtonElement>('button[aria-label="다시 실행"]')!
  const off = (b: Element) => b.getAttribute('aria-disabled') === 'true'
  const ctrl = (k: string, init: KeyboardEventInit = {}, el: Element | Document = document) =>
    key(el, k, { ctrlKey: true, ...init })
  const draw = (y: number) => {
    fire('pointerdown', { x: 20, y })
    fire('pointermove', { x: 60, y })
    fire('pointerup', { x: 100, y })
  }
  const lastEvent = (k: string, init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
    act(() => void document.dispatchEvent(e))
    return e
  }

  test('buttons: after the grip and slot, divider, names, tooltips, disabled without focus loss', async () => {
    await mountEditor()
    const tb = q('[role="toolbar"]')!
    const kids = [...tb.children]
    expect(kids[2]!.className).toBe('pen-add')
    expect(kids[3]!.className).toBe('toolbar-divider')
    expect(kids[3]!.getAttribute('aria-hidden')).toBe('true')
    expect(kids[4]).toBe(undoBtn())
    expect(kids[5]).toBe(redoBtn())
    expect(undoBtn().title).toBe('실행 취소 (Ctrl+Z)')
    expect(redoBtn().title).toBe('다시 실행 (Ctrl+Y)')
    expect(off(undoBtn()) && off(redoBtn())).toBe(true)
    expect(undoBtn().hasAttribute('disabled')).toBe(false)
    draw(100)
    await flush()
    expect(off(undoBtn())).toBe(false)
    expect(off(redoBtn())).toBe(true)
  })

  test('undo and redo by button save a new rev and seq; ids and points come back', async () => {
    await mountEditor()
    draw(100)
    draw(200)
    await flush()
    const before = await saved()
    const [first, second] = strokesOf(before)
    click(undoBtn())
    await flush()
    const undone = await saved()
    expect(strokesOf(undone).map((s) => s.id)).toEqual([first!.id])
    expect(undone.pages[0]!.seq).toBe(before.pages[0]!.seq + 1)
    expect(undone.pages[0]!.rev).not.toBe(before.pages[0]!.rev)
    expect(off(redoBtn())).toBe(false)
    click(redoBtn())
    await flush()
    const redone = await saved()
    expect(strokesOf(redone)).toEqual([first, second])
    expect(redone.pages[0]!.seq).toBe(before.pages[0]!.seq + 2)
  })

  test('Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z and the Cmd variants; preventDefault only when handled', async () => {
    await mountEditor()
    draw(100)
    await flush()
    expect(lastEvent('y', { ctrlKey: true }).defaultPrevented).toBe(false) // nothing to redo
    let e = lastEvent('z', { ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)
    e = lastEvent('y', { ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
    lastEvent('z', { metaKey: true })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)
    lastEvent('Z', { ctrlKey: true, shiftKey: true })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
    lastEvent('z', { metaKey: true })
    lastEvent('Z', { metaKey: true, shiftKey: true })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
    expect(lastEvent('z', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false)
    expect(lastEvent('z', {}).defaultPrevented).toBe(false)
  })

  test('a press that starts outside the page still blocks undo until release', async () => {
    await mountEditor()
    draw(100)
    await flush()
    fire('pointerdown', { x: -5, y: 100 })
    click(undoBtn())
    ctrl('z')
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
    fire('pointerup', { x: -5, y: 100 })
  })

  test('a held key undoes once; IME composition is ignored', async () => {
    await mountEditor()
    draw(100)
    draw(200)
    draw(300)
    await flush()
    ctrl('z')
    ctrl('z', { repeat: true })
    ctrl('z', { repeat: true })
    ctrl('z', { isComposing: true })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(2)
  })

  test('another layout: the physical key decides; Cmd+Y does not redo; a modal blocks the keys', async () => {
    await mountEditor()
    draw(100)
    await flush()
    key(document, 'ㅋ', { ctrlKey: true, code: 'KeyZ' }) // Hangul layout
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)
    expect(lastEvent('y', { metaKey: true }).defaultPrevented).toBe(false)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)
    key(document, 'ㅛ', { ctrlKey: true, code: 'KeyY' })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)

    const dlg = document.createElement('div')
    dlg.setAttribute('role', 'dialog')
    document.body.append(dlg)
    ctrl('z')
    await flush()
    dlg.remove()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('sessionHistory: NaN and undefined-valued keys do not break equality', () => {
    const a = newNote('s2')
    const withNaN = { ...a, extra: { v: Number.NaN, u: undefined } } as unknown as Note
    const h = sessionHistory(withNaN)
    expect(sessionHistory({ ...a, extra: { v: Number.NaN } } as unknown as Note)).toBe(h)
  })

  test('a new stroke empties redo', async () => {
    await mountEditor()
    draw(100)
    await flush()
    click(undoBtn())
    expect(off(redoBtn())).toBe(false)
    draw(200)
    await flush()
    expect(off(redoBtn())).toBe(true)
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('empty stacks: button and keys do nothing and nothing is saved', async () => {
    let writes = 0
    await mountEditor({ opts: { afterPut: () => void writes++ } })
    click(undoBtn())
    click(redoBtn())
    ctrl('z')
    ctrl('y')
    await flush()
    expect(writes).toBe(0)
  })

  test('a text field keeps its own undo', async () => {
    await mountEditor()
    draw(100)
    await flush()
    const input = document.createElement('input')
    host.append(input)
    input.focus()
    const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => void input.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(false)
    lastEvent('z', { ctrlKey: true }) // target is document, focus is still in the input
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
    input.blur()
    input.remove()
  })

  test('mid-stroke: no effect, the stroke goes on', async () => {
    await mountEditor()
    draw(100)
    await flush()
    fire('pointerdown', { x: 20, y: 200 })
    fire('pointermove', { x: 60, y: 200 })
    click(undoBtn())
    ctrl('z')
    fire('pointerup', { x: 100, y: 200 })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(2)
  })

  test('leaving: undo is ignored', async () => {
    await mountEditor()
    draw(100)
    await flush()
    location.hash = '#/notes/n1'
    click(q('.editor-back')!)
    ctrl('z')
    await flush()
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('serial: undo, undo, redo in a row leave the last state in the database', async () => {
    await mountEditor()
    draw(100)
    draw(200)
    await flush()
    const seq = (await saved()).pages[0]!.seq
    click(undoBtn())
    click(undoBtn())
    click(redoBtn())
    await flush()
    const n = await saved()
    expect(strokesOf(n)).toHaveLength(1)
    expect(n.pages[0]!.seq).toBe(seq + 3)
  })

  test('history survives library and back; a different saved note starts a new one; reload empties', async () => {
    await mountEditor()
    draw(100)
    await flush()
    act(() => root.render(createElement('div')))
    await savesSettled()
    await mountEditor({ note: null })
    expect(off(undoBtn())).toBe(false)
    ctrl('z')
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)

    act(() => root.render(createElement('div')))
    await savesSettled()
    // the stored note changed behind the history's back (e.g. a failed save)
    const n = await saved()
    await seed({ ...n, metaRev: 'other' })
    await mountEditor({ note: null })
    expect(off(undoBtn())).toBe(true)

    draw(100)
    await flush()
    act(() => root.render(createElement('div')))
    await savesSettled()
    clearSessionHistories() // a reload
    await mountEditor({ note: null })
    expect(off(undoBtn())).toBe(true)
  })

  test('History error: snackbar, nothing changes', async () => {
    await mountEditor()
    draw(100)
    await flush()
    const spy = vi.spyOn(History.prototype, 'undo').mockReturnValue('strokeNotFound')
    click(undoBtn())
    spy.mockRestore()
    expect(q('[role="status"]')!.textContent).toBe('되돌리지 못했어요.')
    expect(off(undoBtn())).toBe(false)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('save failure after undo: snackbar, screen stays undone, the next commit saves everything', async () => {
    let fail = false
    await mountEditor({
      opts: {
        afterPut: () => {
          if (fail) throw new Error('quota')
        },
      },
    })
    draw(100)
    draw(200)
    await flush()
    fail = true
    click(undoBtn())
    await flush()
    expect(q('[role="status"]')!.textContent).toBe('이 브라우저에 저장하지 못했어요.')
    expect(off(redoBtn())).toBe(false)
    expect(strokesOf(await saved())).toHaveLength(2)
    fail = false
    click(undoBtn())
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)
  })

  test('English names and tips; sessionHistory reuses an equal note only', async () => {
    await mountEditor({ lang: 'en-US' })
    expect(q('button[aria-label="Undo"]')!.title).toBe('Undo (Ctrl+Z)')
    expect(q('button[aria-label="Redo"]')!.title).toBe('Redo (Ctrl+Y)')
    const a = newNote('s1')
    const h = sessionHistory(a)
    expect(sessionHistory(structuredClone(a))).toBe(h)
    expect(sessionHistory({ ...a, metaRev: 'x' })).not.toBe(h)
  })
})

describe('zoom and pan', () => {
  // 800 x 600 canvas; --spacing-3 is unset in jsdom so the gap is 12, no toolbar height.
  const GAP = 12
  let size = { w: 800, h: 600 }
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  const fit = () => (size.w - GAP * 2) / 595
  beforeEach(() => {
    size = { w: 800, h: 600 }
    proto.getBoundingClientRect = () =>
      ({ width: size.w, height: size.h, left: 0, top: 0, right: size.w, bottom: size.h, x: 0, y: 0, toJSON() {} }) as DOMRect
  })
  afterEach(() => {
    proto.getBoundingClientRect = origRect
    delete (globalThis as { matchMedia?: unknown }).matchMedia
    vi.unstubAllGlobals()
  })

  const tap = (x: number, y: number, type = 'pen') => {
    fire('pointerdown', { type, x, y })
    fire('pointerup', { type, x, y })
  }
  /** Where a tap at the client position lands on the page, via the saved stroke. */
  async function pageAt(x: number, y: number): Promise<[number, number] | null> {
    const before = strokesOf(await saved()).length
    tap(x, y)
    await flush()
    const all = strokesOf(await saved())
    if (all.length === before) return null
    const p = all[all.length - 1]!.points[0]!
    return [p[0]!, p[1]!]
  }
  const wheel = (init: WheelEventInit) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...init })
    act(() => void canvas().dispatchEvent(e))
    return e
  }
  const press = (target: Element, k: string, init: KeyboardEventInit = {}) =>
    act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))
  const space = (type: 'keydown' | 'keyup', target: Element = canvas()) => {
    const e = new KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    act(() => void target.dispatchEvent(e))
    return e
  }
  const openMenu = async () => {
    click(q('.editor-more button')!)
    await settle()
  }
  const level = () => q('.editor-zoom-level')!.textContent
  const closeTo = (a: [number, number] | null, x: number, y: number) => {
    expect(a).not.toBeNull()
    expect(a![0]).toBeCloseTo(x, 1)
    expect(a![1]).toBeCloseTo(y, 1)
  }

  test('opens fitted to the width', async () => {
    await mountEditor()
    const s = fit()
    closeTo(await pageAt(GAP + 100 * s, GAP + 50 * s), 100, 50)
    await openMenu()
    expect(level()).toBe(`${Math.round(s * 100)}%`)
  })

  test('wheel and Shift+wheel scroll; line units become pixels; the end stops above the toolbar room', async () => {
    await mountEditor()
    const s = fit()
    const e = wheel({ deltaY: 100 })
    expect(e.defaultPrevented).toBe(true)
    closeTo(await pageAt(GAP, GAP), 0, 100 / s)
    wheel({ deltaY: 2, deltaMode: 1 }) // two lines = 32 px
    closeTo(await pageAt(GAP, GAP), 0, 132 / s)
    // Shift moves along x; the page is no wider than the area, so nothing moves.
    wheel({ deltaY: 50, shiftKey: true })
    closeTo(await pageAt(GAP, GAP), 0, 132 / s)
    wheel({ deltaY: 100000 })
    const end = size.h - GAP - GAP // the page bottom on screen: gap + room under (gap, no toolbar)
    closeTo(await pageAt(300, end - 0.5), (300 - GAP) / s, 842 - 0.5 / s)
    expect(await pageAt(300, end + 3)).toBeNull()
  })

  test('Ctrl+wheel keeps the page point under the pointer, 50-800%, default prevented', async () => {
    await mountEditor()
    const s = fit()
    const px = (400 - GAP) / s
    const py = (300 - GAP) / s
    const e = wheel({ deltaY: -230, ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    closeTo(await pageAt(400, 300), px, py)
    await openMenu()
    expect(Number.parseInt(level()!)).toBe(Math.round(s * Math.exp(0.46) * 100))
    for (let i = 0; i < 5; i++) wheel({ deltaY: -2000, ctrlKey: true })
    expect(level()).toBe('800%')
    for (let i = 0; i < 5; i++) wheel({ deltaY: 5000, ctrlKey: true })
    expect(level()).toBe('50%')
  })

  test('Space+drag moves without a stroke; releasing Space returns to the pen', async () => {
    await mountEditor()
    const s = fit()
    canvas().focus()
    expect(space('keydown').defaultPrevented).toBe(true)
    expect(canvas().classList.contains('is-hand')).toBe(true)
    fire('pointerdown', { type: 'mouse', x: 300, y: 300 })
    fire('pointermove', { type: 'mouse', x: 300, y: 200 })
    fire('pointerup', { type: 'mouse', x: 300, y: 200 })
    space('keyup')
    expect(canvas().classList.contains('is-hand')).toBe(false)
    expect(strokesOf(await saved())).toHaveLength(0)
    closeTo(await pageAt(GAP, GAP), 0, 100 / s) // dragged up 100: the content moved up
  })

  test('Space is not the hand in a text field or on a focused button', async () => {
    await mountEditor()
    const input = document.createElement('input')
    host.append(input)
    input.focus()
    space('keydown', input)
    expect(canvas().classList.contains('is-hand')).toBe(false)
    input.remove()
    const slot = q('[role="radio"]')!
    ;(slot as HTMLElement).focus()
    expect(space('keydown', slot).defaultPrevented).toBe(false) // a plain press still works
    expect(canvas().classList.contains('is-hand')).toBe(false)
    space('keyup', slot)
    // With the hand on, a mouse drag over the canvas is a pan and the Space release is swallowed.
    canvas().focus()
    space('keydown')
    fire('pointerdown', { type: 'mouse', x: 300, y: 300 })
    fire('pointermove', { type: 'mouse', x: 300, y: 250 })
    fire('pointerup', { type: 'mouse', x: 300, y: 250 })
    expect(space('keyup', slot).defaultPrevented).toBe(true)
  })

  test('blur during Space, a drag or a pinch clears the hand and the next pointer draws', async () => {
    await mountEditor()
    canvas().focus()
    space('keydown')
    fire('pointerdown', { type: 'mouse', x: 300, y: 300 })
    expect(canvas().classList.contains('is-panning')).toBe(true)
    act(() => void globalThis.dispatchEvent(new Event('blur')))
    expect(canvas().classList.contains('is-hand')).toBe(false)
    expect(canvas().classList.contains('is-panning')).toBe(false)
    expect(await pageAt(300, 300)).not.toBeNull() // the pen again
    // A pinch cut by the blur leaves nothing owning input.
    fire('pointerdown', { type: 'touch', id: 1, x: 300, y: 300, t: 5000 })
    fire('pointerdown', { type: 'touch', id: 2, x: 400, y: 300, t: 5050 })
    act(() => void globalThis.dispatchEvent(new Event('blur')))
    expect(await pageAt(200, 200)).not.toBeNull()
  })

  test('middle button drags the view and blocks autoscroll and paste', async () => {
    await mountEditor()
    const s = fit()
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
    const ax = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    act(() => void canvas().dispatchEvent(md))
    act(() => void canvas().dispatchEvent(ax))
    expect(md.defaultPrevented).toBe(true)
    expect(ax.defaultPrevented).toBe(true)
    fire('pointerdown', { type: 'mouse', x: 300, y: 300, button: 1, buttons: 4 })
    fire('pointermove', { type: 'mouse', x: 300, y: 260, button: 1, buttons: 4 })
    fire('pointerup', { type: 'mouse', x: 300, y: 260, button: 1, buttons: 0 })
    expect(strokesOf(await saved())).toHaveLength(0)
    closeTo(await pageAt(GAP, GAP), 0, 40 / s)
  })

  test('keyboard: Ctrl+= / Ctrl+- / Ctrl+0 and arrows on the canvas only', async () => {
    await mountEditor()
    const s = fit()
    canvas().focus()
    press(canvas(), '=', { ctrlKey: true, code: 'Equal' })
    await openMenu()
    expect(level()).toBe(`${Math.round(s * 1.25 * 100)}%`)
    key(document, 'Escape')
    canvas().focus()
    press(canvas(), '0', { ctrlKey: true, code: 'Digit0' })
    press(canvas(), 'ArrowDown')
    closeTo(await pageAt(GAP, GAP), 0, 40 / s)
    press(canvas(), '-', { ctrlKey: true, code: 'Minus' })
    await openMenu()
    expect(level()).toBe(`${Math.round(s * 0.8 * 100)}%`)
    key(document, 'Escape')
    // Off the canvas nothing is handled.
    ;(q('.editor-back') as HTMLElement).focus()
    const e = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => void document.activeElement!.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(false)
  })

  test('menu: rows, stays open on +/-, aria-disabled at the limits, focus returns to the button', async () => {
    await mountEditor({ lang: 'en-US' })
    const more = q<HTMLButtonElement>('.editor-more button')!
    expect(more.getAttribute('aria-label')).toBe('More')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await openMenu()
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const items = [...q('[role="menu"]')!.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    expect(items.map((i) => i.getAttribute('aria-label') ?? i.textContent)).toEqual([
      'Zoom out',
      'Zoom in',
      'Fit width',
      'Fit page',
      'Vertical scroll',
      'Horizontal scroll',
      'Two pages',
      'Previous note',
      'Next note',
    ])
    expect(q('[role="status"][aria-live="polite"]')!.textContent).toBe(`Zoom ${Math.round(fit() * 100)}%`)
    expect(document.activeElement).toBe(items[0])
    key(items[0]!, 'ArrowUp')
    expect(document.activeElement).toBe(items[8])
    key(items[8]!, 'ArrowDown')
    expect(document.activeElement).toBe(items[0])
    key(items[0]!, 'End')
    expect(document.activeElement).toBe(items[8])
    key(items[8]!, 'Home')
    expect(document.activeElement).toBe(items[0])

    const plus = items[1]!
    click(plus)
    expect(q('[role="menu"]')).not.toBeNull()
    expect(level()).toBe(`${Math.round(fit() * 125)}%`)
    for (let i = 0; i < 12; i++) click(plus)
    expect(level()).toBe('800%')
    expect(plus.getAttribute('aria-disabled')).toBe('true')
    expect(items[0]!.getAttribute('aria-disabled')).toBe('false')

    key(document, 'Escape')
    expect(q('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more)

    await openMenu()
    click(qa('[role="menu"] .editor-menu-item')[0]!) // fit width
    expect(q('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more)
    await openMenu()
    expect(level()).toBe(`${Math.round(fit() * 100)}%`)
    // Tab out of the menu closes it.
    const outside = q('.editor-back')!
    act(() => void q('[role="menu"] .editor-menu-item')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside })))
    expect(q('[role="menu"]')).toBeNull()
    await openMenu()
    // A press outside closes it too.
    act(() => void canvas().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })))
    expect(q('[role="menu"]')).toBeNull()
  })

  test('the zoom level reads "배율 N%"; fit page shows the whole page', async () => {
    await mountEditor()
    await openMenu()
    expect(q('[role="status"][aria-live="polite"]')!.textContent).toBe(`배율 ${Math.round(fit() * 100)}%`)
    click(qa('[role="menuitem"]')[3]!)
    const sp = Math.min((800 - 24) / 595, (600 - 24 - 12) / 842)
    const x0 = GAP + (800 - 24 - 595 * sp) / 2
    const y0 = GAP + (600 - 24 - 12 - 842 * sp) / 2
    closeTo(await pageAt(x0 + 10 * sp, y0 + 10 * sp), 10, 10)
  })

  test('a window resize keeps the fit mode; a free view keeps the center page point', async () => {
    await mountEditor()
    size = { w: 1000, h: 700 }
    act(() => void globalThis.dispatchEvent(new Event('resize')))
    const s = (1000 - 24) / 595
    closeTo(await pageAt(GAP + 100 * s, GAP + 50 * s), 100, 50)

    wheel({ deltaY: -230, ctrlKey: true, clientX: 500, clientY: 350 })
    const center = await pageAt(500, 350)
    size = { w: 700, h: 500 }
    act(() => void globalThis.dispatchEvent(new Event('resize')))
    closeTo(await pageAt(350, 250), center![0], center![1])
  })

  test('a zoom near the width fit snaps to it, shows a scale badge, and a long wheel leaves the snap', async () => {
    await mountEditor()
    canvas().focus()
    press(canvas(), '-', { ctrlKey: true, code: 'Minus' }) // 80% of the fit: outside the band
    wheel({ deltaY: -100, ctrlKey: true }) // x1.22 -> 97.7% of the fit: snaps
    expect(q('[data-testid="zoom-badge"]')!.textContent).toBe(`${Math.round(fit() * 100)}%`)
    wheel({ deltaY: -40, ctrlKey: true }) // still asks for less than +10% in total: stays snapped
    await openMenu()
    expect(level()).toBe(`${Math.round(fit() * 100)}%`)
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    wheel({ deltaY: -100, ctrlKey: true }) // the asked scale is past 110%: leaves the snap
    await openMenu()
    expect(Number.parseInt(level(), 10)).toBeGreaterThan(Math.round(fit() * 110))
  })

  test('reduced motion changes at once', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    ;(globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true })
    await mountEditor()
    canvas().focus()
    press(canvas(), '=', { ctrlKey: true, code: 'Equal' })
    expect(frames).toHaveLength(0)
    const s = fit() * 1.25
    // The view itself is already at the target: the focus (center) is fixed.
    closeTo(await pageAt(400, 300), (400 - GAP) / fit(), (300 - GAP) / fit())
    await openMenu()
    expect(level()).toBe(`${Math.round(s * 100)}%`)
  })

  test('frames carry the zoom to the target; a late frame ends it; input mid-animation snaps', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    ;(globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false })
    await mountEditor()
    canvas().focus()
    press(canvas(), '=', { ctrlKey: true, code: 'Equal' })
    press(canvas(), '=', { ctrlKey: true, code: 'Equal' }) // builds on the target: x1.5625
    expect(frames.length).toBeGreaterThan(0)
    const s2 = fit() * 1.25 * 1.25
    // An early frame (before the start) is clamped and does not end the animation.
    act(() => void frames.shift()!(0))
    await openMenu()
    expect(level()).toBe(`${Math.round(s2 * 100)}%`)
    key(document, 'Escape')
    // A frame far past the end lands exactly on the target.
    while (frames.length > 0) act(() => void frames.shift()!(performance.now() + 10000))
    closeTo(await pageAt(400, 300), (400 - GAP) / fit(), (300 - GAP) / fit())

    // Mid-animation, a pointerdown ends it at the target before the point is mapped.
    press(canvas(), '=', { ctrlKey: true, code: 'Equal' })
    expect(frames.length).toBeGreaterThan(0)
    closeTo(await pageAt(400, 300), (400 - GAP) / fit(), (300 - GAP) / fit())
    expect(canvas().classList.contains('is-panning')).toBe(false)
  })

  test('fit page survives a resize', async () => {
    await mountEditor()
    await openMenu()
    click(qa('[role="menuitem"]')[3]!)
    size = { w: 1000, h: 800 }
    act(() => void globalThis.dispatchEvent(new Event('resize')))
    const sp = Math.min((1000 - 24) / 595, (800 - 24 - 12) / 842)
    const x0 = GAP + (1000 - 24 - 595 * sp) / 2
    const y0 = GAP + (800 - 24 - 12 - 842 * sp) / 2
    closeTo(await pageAt(x0 + 10 * sp, y0 + 10 * sp), 10, 10)
  })

  test('scrollbar thumbs follow the zoom; Shift+wheel pans sideways when zoomed', async () => {
    await mountEditor()
    expect(qa('.editor-scroll-x')).toHaveLength(0)
    wheel({ deltaY: -2000, ctrlKey: true }) // zoom in: both axes overflow
    const x = q('.editor-scroll-x > span')!
    const y = q('.editor-scroll-y > span')!
    expect(x).not.toBeNull()
    expect(y.style.height).not.toBe('')
    const before = Number.parseFloat(x.style.left)
    wheel({ deltaY: 100, shiftKey: true })
    expect(Number.parseFloat(q('.editor-scroll-x > span')!.style.left)).toBeGreaterThan(before)
    wheel({ deltaY: 100000 })
    const ys = q('.editor-scroll-y > span')!
    expect(Number.parseFloat(ys.style.top) + Number.parseFloat(ys.style.height)).toBeCloseTo(100, 3)
  })

  test('the toolbar height adds to the room under the page end', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(60)
    try {
      await mountEditor()
      const s = fit()
      wheel({ deltaY: 100000 })
      const end = size.h - GAP - (60 + GAP) // page bottom on screen
      closeTo(await pageAt(300, end - 0.5), (300 - GAP) / s, 842 - 0.5 / s)
      expect(await pageAt(300, end + 3)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  test('wheel and arrows do nothing under a stroke', async () => {
    await mountEditor()
    fire('pointerdown', { type: 'pen', x: 300, y: 300 })
    wheel({ deltaY: 200 })
    canvas().focus()
    press(canvas(), 'ArrowDown')
    fire('pointerup', { type: 'pen', x: 300, y: 300 })
    closeTo(await pageAt(GAP, GAP), 0, 0)
  })
})

describe('touch arbitration', () => {
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  beforeEach(() => {
    proto.getBoundingClientRect = () =>
      ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect
  })
  afterEach(() => {
    proto.getBoundingClientRect = origRect
  })
  const t = (name: string, id: number, x: number, y: number, at: number) => fire(name, { type: 'touch', id, x, y, t: at })

  test('a second finger within 150 ms discards the stroke; after it, the stroke is kept', async () => {
    let writes = 0
    await mountEditor({ opts: { afterPut: () => void writes++ } })
    t('pointerdown', 1, 100, 100, 1000)
    t('pointermove', 1, 130, 100, 1050)
    t('pointerdown', 2, 300, 300, 1150) // exactly 150 ms
    t('pointermove', 2, 320, 300, 1160)
    t('pointerup', 2, 320, 300, 1170)
    t('pointermove', 1, 160, 100, 1180)
    t('pointerup', 1, 160, 100, 1190)
    await flush()
    expect(writes).toBe(0)
    expect(strokesOf(await saved())).toHaveLength(0)

    // 151 ms: ignored, the stroke goes on and is saved.
    t('pointerdown', 1, 100, 100, 2000)
    t('pointerdown', 2, 300, 300, 2151)
    t('pointerup', 2, 300, 300, 2160)
    t('pointermove', 1, 130, 100, 2170)
    t('pointerup', 1, 130, 100, 2180)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('pinch keeps the page point under the fingers; a finger left over never draws', async () => {
    await mountEditor()
    const s = (800 - 24) / 595
    const p0 = [(350 - 12) / s, (300 - 12) / s]
    t('pointerdown', 1, 300, 300, 1000)
    t('pointerdown', 2, 400, 300, 1050)
    t('pointermove', 2, 500, 300, 1100) // distance 100 -> 200, focus (350,300) -> (400,300)
    t('pointerup', 2, 500, 300, 1110)
    t('pointermove', 1, 320, 320, 1120) // the one left moves: nothing
    t('pointerup', 1, 320, 320, 1130)
    await flush()
    expect(strokesOf(await saved())).toHaveLength(0)
    fire('pointerdown', { type: 'mouse', x: 400, y: 300 })
    fire('pointerup', { type: 'mouse', x: 400, y: 300 })
    await flush()
    const [pt] = strokesOf(await saved())
    expect(pt!.points[0]![0]).toBeCloseTo(p0[0]!, 1)
    expect(pt!.points[0]![1]).toBeCloseTo(p0[1]!, 1)
  })

  test('a pen takes over from a finger stroke at once', async () => {
    await mountEditor()
    t('pointerdown', 1, 100, 100, 1000)
    t('pointermove', 1, 120, 100, 1500)
    fire('pointerdown', { type: 'pen', id: 5, x: 200, y: 200, t: 1600 })
    fire('pointerup', { type: 'pen', id: 5, x: 220, y: 200, t: 1650 })
    t('pointerup', 1, 120, 100, 1700)
    await flush()
    const strokes = strokesOf(await saved())
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.points[0]![0]).toBeCloseTo((200 - 12) / ((800 - 24) / 595), 1)
  })
})

describe('same note in two tabs (story 2.13)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true })
  })
  afterEach(() => {
    delete (navigator as { locks?: unknown }).locks
  })

  // A second editor in its own root, on the same note.
  async function second(id = 'n1', opts: Opts = {}) {
    const h = document.createElement('div')
    document.body.append(h)
    const r = createRoot(h)
    act(() =>
      r.render(
        createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: id, openStore: makeOpen(opts), lockWaitMs: 0 })),
      ),
    )
    await flush()
    return { h, r }
  }
  const fireIn = (c: HTMLElement, name: string, o: PInit) => {
    const e = pev(name, o)
    act(() => void c.dispatchEvent(e))
  }
  const close = (t: { h: HTMLElement; r: Root }) => {
    act(() => t.r.unmount())
    t.h.remove()
  }

  test('the second tab is read-only: banner first, no stroke, no save, tips, zoom works', async () => {
    await mountEditor()
    fire('pointerdown', { x: 20, y: 20 })
    fire('pointerup', { x: 60, y: 20 })
    await flush()
    const t = await second()
    // The holder is mid-stroke, so only a loose guard in the read-only tab could undo the first stroke.
    fire('pointerdown', { x: 20, y: 80 })
    fire('pointermove', { x: 40, y: 80 })
    try {
      const { h } = t
      const banner = h.querySelector('.editor')!.firstElementChild as HTMLElement
      expect(banner.className).toBe('editor-banner')
      expect(banner.textContent).toBe('다른 탭에서 이 노트를 편집 중이에요. 여기서 편집하려면 그 탭을 닫아 주세요.')
      expect(banner.getAttribute('role')).toBe('status')
      expect(banner.getAttribute('aria-live')).toBe('polite')
      expect(banner.querySelector('button')).toBeNull()
      expect(q('.editor-banner')).toBeNull() // the first tab is untouched

      const c = h.querySelector<HTMLCanvasElement>('canvas')!
      fireIn(c, 'pointerdown', { x: 100, y: 100 })
      fireIn(c, 'pointermove', { x: 140, y: 100 })
      fireIn(c, 'pointerup', { x: 180, y: 100 })
      act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))
      await flush()
      fire('pointerup', { x: 60, y: 80 })
      await flush()
      expect(strokesOf(await saved())).toHaveLength(2) // the holder's two strokes only

      const slot = h.querySelector('[role="radio"]')!
      expect(slot.getAttribute('aria-disabled')).toBe('true')
      expect(slot.getAttribute('title')).toBe('읽기 전용이에요')
      for (const name of ['실행 취소', '다시 실행']) {
        const b = h.querySelector(`button[aria-label="${name}"]`)!
        expect(b.getAttribute('aria-disabled')).toBe('true')
        expect(b.getAttribute('title')).toBe('읽기 전용이에요')
      }

      // zoom still works
      act(() => h.querySelector<HTMLElement>('.editor-more button')!.click())
      await settle()
      const before = h.querySelector('.editor-zoom-level')!.textContent
      act(() => h.querySelector<HTMLElement>('button[aria-label="확대"]')!.click())
      expect(h.querySelector('.editor-zoom-level')!.textContent).not.toBe(before)
    } finally {
      close(t)
    }
  })

  test('the first tab can still draw while the second waits', async () => {
    await mountEditor()
    const t = await second()
    try {
      fire('pointerdown', { x: 20, y: 20 })
      fire('pointerup', { x: 60, y: 20 })
      await flush()
      expect(strokesOf(await saved())).toHaveLength(1)
    } finally {
      close(t)
    }
  })

  test('closing the first tab: the second reloads its stroke, drops the banner and can draw', async () => {
    await mountEditor()
    const t = await second()
    try {
      fire('pointerdown', { x: 20, y: 20 })
      fire('pointerup', { x: 60, y: 20 })
      act(() => root.render(createElement('div'))) // the first tab closes; its final save lands, then the lock goes
      await flush()
      await flush()
      const { h } = t
      expect(h.querySelector('.editor-banner')).toBeNull()
      expect(h.querySelector('[role="radio"]')!.getAttribute('aria-disabled')).toBeNull()
      const c = h.querySelector<HTMLCanvasElement>('canvas')!
      fireIn(c, 'pointerdown', { x: 20, y: 200 })
      fireIn(c, 'pointerup', { x: 60, y: 200 })
      await flush()
      expect(strokesOf(await saved())).toHaveLength(2)
    } finally {
      close(t)
    }
  })

  test('leaving while waiting aborts the request: a later tab gets the lock', async () => {
    await mountEditor()
    close(await second())
    act(() => root.render(createElement('div')))
    await flush()
    await mountEditor({ note: null })
    expect(q('.editor-banner')).toBeNull()
  })

  test('another note has its own lock', async () => {
    await seed(newNote('n2'))
    await mountEditor()
    const t = await second('n2')
    try {
      expect(t.h.querySelector('.editor-banner')).toBeNull()
    } finally {
      close(t)
    }
  })

  test('no navigator.locks: editable without a banner even when two tabs open', async () => {
    delete (navigator as { locks?: unknown }).locks
    await mountEditor()
    const t = await second()
    try {
      expect(q('.editor-banner')).toBeNull()
      expect(t.h.querySelector('.editor-banner')).toBeNull()
    } finally {
      close(t)
    }
  })

  test('read-only: mouse and pen drags pan and save nothing; another slot cannot be picked; teardown writes nothing', async () => {
    const proto = HTMLCanvasElement.prototype
    const orig = proto.getBoundingClientRect
    proto.getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect
    sharedPenSlots().write([defaultPen, { ...defaultPen, width: 3 }])
    let writes = 0
    try {
      await mountEditor()
      const t = await second('n1', { afterCheck: () => void writes++ })
      try {
        const { h } = t
        const c = h.querySelector<HTMLCanvasElement>('canvas')!
        const top = () => h.querySelector<HTMLElement>('.editor-scroll-y span')!.style.top
        for (const type of ['mouse', 'pen']) {
          const t0 = top()
          fireIn(c, 'pointerdown', { type, x: 300, y: 300 })
          expect(c.classList.contains('is-panning')).toBe(true)
          fireIn(c, 'pointermove', { type, x: 300, y: 200 })
          fireIn(c, 'pointerup', { type, x: 300, y: 200 })
          expect(c.classList.contains('is-panning')).toBe(false)
          expect(top()).not.toBe(t0)
        }
        const radios = [...h.querySelectorAll<HTMLElement>('[role="radio"]')]
        expect(radios).toHaveLength(2)
        act(() => radios[1]!.click())
        key(c, '1')
        expect(h.querySelectorAll('[role="radio"]')[0]!.getAttribute('aria-checked')).toBe('true')
        expect(h.querySelectorAll('[role="radio"]')[1]!.getAttribute('aria-checked')).toBe('false')
      } finally {
        close(t)
      }
      await flush()
      expect(writes).toBe(0)
      expect(strokesOf(await saved())).toHaveLength(0)
    } finally {
      sharedPenSlots().write(defaultPenSlots)
      proto.getBoundingClientRect = orig
    }
  })

  test('the lock granted while the first load runs: the tab ends writable', async () => {
    await seed(newNote('n1'))
    const holder = await acquireNoteLock('n1')
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let first = true
    const openStore = () => {
      const s = openNoteStore()
      stores.push(s)
      if (!first) return s
      first = false
      return { ...s, loadNote: async (id: string) => (await gate, s.loadNote(id)) } as NoteStore
    }
    act(() =>
      root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore }))),
    )
    await flush() // waiting for the lock, first load held at the gate
    await holder.release()
    await flush() // granted mid-load
    open()
    await flush()
    await flush()
    expect(q('.editor-banner')).toBeNull()
    expect(q('[role="radio"]')!.getAttribute('aria-disabled')).toBeNull()
    fire('pointerdown', { x: 20, y: 20 })
    fire('pointerup', { x: 60, y: 20 })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('a held lock is waited for before the note is read: read-only after the wait, writable once it frees', async () => {
    await seed(newNote('n1'))
    const holder = await acquireNoteLock('n1') // a closed-note upload
    let loads = 0
    const openStore = () => {
      const s = openNoteStore()
      stores.push(s)
      return { ...s, loadNote: async (id: string) => (loads++, s.loadNote(id)) } as NoteStore
    }
    act(() =>
      root.render(
        createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore, lockWaitMs: 150 })),
      ),
    )
    await flush()
    expect(loads).toBe(0) // the unmerged working copy is not read while the lock is held
    expect(q('.editor-banner')).toBeNull()
    await new Promise((r) => setTimeout(r, 250))
    await flush()
    expect(q('.editor-banner')).not.toBeNull() // read-only notice after the wait
    await holder.release()
    await flush()
    await flush()
    expect(q('.editor-banner')).toBeNull() // the lock freed: the editor goes on
    fire('pointerdown', { x: 20, y: 20 })
    fire('pointerup', { x: 60, y: 20 })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('a lock freed within the wait opens the editor writable at once', async () => {
    await seed(newNote('n1'))
    const holder = await acquireNoteLock('n1')
    act(() =>
      root.render(
        createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore: makeOpen(), lockWaitMs: 5000 })),
      ),
    )
    await flush()
    await holder.release()
    await flush()
    await flush()
    expect(q('.editor-banner')).toBeNull()
    expect(q('canvas.editor-canvas')).not.toBeNull()
  })

  test('ko and en strings exist', () => {
    for (const lang of [resources.ko, resources.en]) {
      expect(lang['editor.otherTab']).toBeTruthy()
      expect(lang['editor.readOnlyTip']).toBeTruthy()
    }
  })
})

describe('pen pressure toggle', () => {
  const memStore = (initial?: string) => {
    const m = new Map<string, string>(initial === undefined ? [] : [[PEN_SLOTS_KEY, initial]])
    return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
  }
  const slot = () => q('[role="radio"]')!
  const dialog = () => q('[role="dialog"].pen-popover')
  const sw = () => q('[role="switch"]')!
  const storedUp = (m: Map<string, string>) => (JSON.parse(m.get(PEN_SLOTS_KEY)!) as { usePressure: boolean }[])[0]!.usePressure
  const stroke = (pressure: number) => {
    fire('pointerdown', { x: 100, y: 100, pressure })
    fire('pointermove', { x: 130, y: 100, pressure: 0.9 })
    fire('pointerup', { x: 160, y: 100, pressure: 0.9 })
  }

  test('click on the selected slot opens the popover: title, switch on, preview only', async () => {
    const { storage } = memStore()
    await mountEditor({ pens: createPenSlots(storage) })
    expect(dialog()).toBeNull()
    click(slot())
    const d = dialog()!
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('aria-labelledby')).toBeTruthy()
    expect(d.querySelector('h2')!.textContent).toBe('펜')
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(d.querySelectorAll('.pen-palette [role="radio"]')).toHaveLength(13) // 12 colors + custom
    const labelId = sw().getAttribute('aria-labelledby')!
    expect(document.getElementById(labelId)!.textContent).toBe('필압 반영')
    expect(d.querySelector('svg.pen-preview path')!.getAttribute('d')).toMatch(/^M/)
    expect(document.activeElement).toBe(d.querySelector('.pen-tool-switch [aria-checked="true"]'))
  })

  test('off: stored at once, flat preview, next stroke false with raw pressure; old stroke unchanged', async () => {
    const { m, storage } = memStore()
    await mountEditor({ pens: createPenSlots(storage) })
    stroke(0.2)
    await flush()
    click(slot())
    const onPath = q('.pen-preview path')!.getAttribute('d')
    click(sw())
    expect(storedUp(m)).toBe(false)
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(q('.pen-preview path')!.getAttribute('d')).not.toBe(onPath)
    key(sw(), 'Escape')
    expect(dialog()).toBeNull()
    stroke(0.2)
    await flush()
    const [a, b] = strokesOf(await saved())
    expect(a!.usePressure).toBe(true)
    expect(b!.usePressure).toBe(false)
    expect(b!.points.map((p) => p[2])).toEqual([0.2, 0.9, 0.9])
  })

  test('a stored false applies to a new session; a corrupt value falls back', async () => {
    const off = JSON.stringify([{ color: '#000000', width: 2, usePressure: false }])
    await mountEditor({ pens: createPenSlots(memStore(off).storage) })
    click(slot())
    expect(sw().getAttribute('aria-checked')).toBe('false')
    act(() => root.unmount())
    root = createRoot(host)
    await mountEditor({ pens: createPenSlots(memStore('{"x":1}').storage), note: null })
    click(slot())
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  test('Tab cycles the stops inside; outside press and Esc close, keep the change, focus the slot', async () => {
    const { m, storage } = memStore()
    await mountEditor({ pens: createPenSlots(storage) })
    click(slot())
    click(sw())
    const tab = (el: Element, shiftKey = false) => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      act(() => void el.dispatchEvent(ev))
      return ev
    }
    const first = document.activeElement as HTMLElement
    expect(first.closest('.pen-tool-switch')).not.toBeNull()
    const seen: string[] = []
    let ev = tab(first)
    expect(ev.defaultPrevented).toBe(true)
    for (let i = 0; i < 6; i++) {
      const el = document.activeElement as HTMLElement
      seen.push(el.closest('.pen-palette') ? 'palette' : el.closest('.pen-recent') ? 'recent' : el.className || el.getAttribute('role')!)
      ev = tab(el)
    }
    // tool, palette, (recent is empty), slider, down, up, switch, delete, back to the tool
    expect(seen).toEqual(['palette', 'pen-width-slider', 'pen-step pen-step-down', 'pen-step', 'pen-popover-switch', 'pen-popover-delete'])
    expect(document.activeElement).toBe(first)
    tab(first, true)
    expect(document.activeElement).toBe(q('.pen-popover-delete'))
    act(() => void q('.pen-popover-scrim')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(dialog()).toBeNull()
    expect(storedUp(m)).toBe(false)
    expect(document.activeElement).toBe(slot())
    click(slot())
    key(document.activeElement!, 'Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(slot())
  })

  test('another slot is selected first, not edited', async () => {
    const { storage } = memStore(
      JSON.stringify([
        { color: '#000000', width: 2, usePressure: true },
        { color: '#000000', width: 3, usePressure: true },
      ]),
    )
    await mountEditor({ pens: createPenSlots(storage) })
    click(qa('[role="radio"]')[1]!)
    expect(dialog()).toBeNull()
    expect(qa('[role="radio"]')[1]!.getAttribute('aria-checked')).toBe('true')
    click(qa('[role="radio"]')[1]!)
    expect(dialog()).not.toBeNull()
  })

  test('English strings and the keys exist in both languages', async () => {
    await mountEditor({ lang: 'en-US', pens: createPenSlots(memStore().storage) })
    click(slot())
    expect(q('.pen-popover h2')!.textContent).toBe('Pen')
    expect(q('[role="switch"] span')!.textContent).toBe('Use pressure')
    for (const lang of [resources.ko, resources.en]) {
      expect(lang['editor.penEditTitle']).toBeTruthy()
      expect(lang['editor.usePressure']).toBeTruthy()
    }
  })

  test('read-only tab: clicking the selected slot shows no dialog and stores nothing', async () => {
    const off = JSON.stringify([{ color: '#000000', width: 2, usePressure: false }])
    const { m, storage } = memStore(off)
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true })
    await mountEditor()
    const h = document.createElement('div')
    document.body.append(h)
    const r = createRoot(h)
    act(() =>
      r.render(
        createElement(
          I18nContext.Provider,
          { value: i18nFor('ko-KR') },
          createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore: makeOpen(), penStore: createPenSlots(storage), lockWaitMs: 0 }),
        ),
      ),
    )
    await flush()
    try {
      expect(h.querySelector('.editor-banner')).not.toBeNull()
      const radio = h.querySelector<HTMLElement>('[role="radio"]')!
      expect(radio.getAttribute('aria-checked')).toBe('true')
      act(() => radio.click())
      expect(h.querySelector('[role="dialog"]')).toBeNull()
      expect(m.get(PEN_SLOTS_KEY)).toBe(off)
    } finally {
      act(() => r.unmount())
      h.remove()
      delete (navigator as { locks?: unknown }).locks
    }
  })

  test('F6 and 1 do nothing while the popover is open', async () => {
    const { storage } = memStore(
      JSON.stringify([
        { color: '#000000', width: 2, usePressure: true },
        { color: '#000000', width: 3, usePressure: true },
      ]),
    )
    await mountEditor({ pens: createPenSlots(storage) })
    click(qa('[role="radio"]')[1]!)
    click(qa('[role="radio"]')[1]!)
    expect(dialog()).not.toBeNull()
    const focused = document.activeElement
    key(sw(), 'F6')
    expect(document.activeElement).toBe(focused)
    key(sw(), '1')
    key(canvas(), '1')
    expect(qa('[role="radio"]')[0]!.getAttribute('aria-checked')).toBe('false')
    expect(qa('[role="radio"]')[1]!.getAttribute('aria-checked')).toBe('true')
  })

  test('the slot is ignored in the middle of a stroke', async () => {
    const { storage } = memStore()
    await mountEditor({ pens: createPenSlots(storage) })
    fire('pointerdown', { x: 100, y: 100 })
    fire('pointermove', { x: 120, y: 100 })
    click(slot())
    expect(dialog()).toBeNull()
    fire('pointerup', { x: 140, y: 100 })
    click(slot())
    expect(dialog()).not.toBeNull()
  })

  test('a pen changed by another tab is shown when the popover opens', async () => {
    const { m, storage } = memStore()
    await mountEditor({ pens: createPenSlots(storage) })
    m.set(PEN_SLOTS_KEY, JSON.stringify([{ color: '#000000', width: 2, usePressure: false }]))
    click(slot())
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  describe('re-read after the editor is registered', () => {
    // The 2nd loadNote (after registering) answers a note with another title; a failing 2nd read keeps the first.
    const mountWith = async (second: 'other' | 'reject') => {
      await seed(newNote('n1'))
      let calls = 0
      const open = () => {
        const s = openNoteStore()
        stores.push(s)
        return {
          ...s,
          loadNote: async (id: string) => {
            const r = await s.loadNote(id)
            if (++calls < 2) return r
            if (second === 'reject') throw new Error('boom')
            return r?.result === 'ok' && r.note ? { ...r, note: { ...r.note, meta: { ...r.note.meta, title: '받은 노트' } } } : r
          },
        } as NoteStore
      }
      act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore: open }))))
      await flush()
    }

    test('a different note on disk rebuilds and registers the writer', async () => {
      await mountWith('other')
      expect(getOpenNote('n1')?.current().meta.title).toBe('받은 노트')
    })

    test('a failing second read keeps the first writer', async () => {
      await mountWith('reject')
      expect(getOpenNote('n1')?.current().meta.title).toBe('필기 노트')
    })

    test('a writer with unsaved changes is not replaced', async () => {
      const spy = vi.spyOn(Writer.prototype, 'unsaved').mockReturnValue(true)
      await mountWith('other')
      spy.mockRestore()
      expect(getOpenNote('n1')?.current().meta.title).toBe('필기 노트')
    })
  })
})

describe('pen slots (story 5.3)', () => {
  const memStore = (initial?: string) => {
    const m = new Map<string, string>(initial === undefined ? [] : [[PEN_SLOTS_KEY, initial]])
    return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
  }
  const radios = () => qa('.pen-slots [role="radio"]')
  const checked = () => radios().findIndex((r) => r.getAttribute('aria-checked') === 'true')
  const storedList = (m: Map<string, string>) => JSON.parse(m.get(PEN_SLOTS_KEY)!) as { tool: string; color: string; width: number }[]
  const colors = (m: Map<string, string>) => storedList(m).map((p) => p.color)
  const addBtn = () => q('.pen-add')!
  const dialog = () => q('[role="dialog"].pen-popover')
  const draw = (y: number) => {
    fire('pointerdown', { x: 20, y })
    fire('pointermove', { x: 60, y })
    fire('pointerup', { x: 100, y })
  }
  const open = async (initial?: string) => {
    const s = memStore(initial)
    await mountEditor({ pens: createPenSlots(s.storage) })
    return s
  }
  const many = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ tool: 'pen', color: '#000000', width: 1 + i / 10, usePressure: true })))
  const BLACK = '#000000'
  const BLUE = '#1971c2'
  const YELLOW = '#ffe066'

  test('three default slots with spec names; the first is selected', async () => {
    await open()
    expect(radios().map((r) => r.getAttribute('aria-label'))).toEqual(['펜, 검정, 두께 2.0 (1)', '펜, 파랑, 두께 2.0 (2)', '형광펜, 노랑, 두께 14.0 (3)'])
    expect(checked()).toBe(0)
    expect(radios()[0]!.querySelector('.pen-underline')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await mountEditor({ pens: createPenSlots(memStore().storage), lang: 'en-US', note: null })
    expect(radios().map((r) => r.getAttribute('aria-label'))).toEqual(['Pen, Black, width 2.0 (1)', 'Pen, Blue, width 2.0 (2)', 'Highlighter, Yellow, width 14.0 (3)'])
  })

  test('number keys pick that slot as the pen; a missing slot is ignored; a highlighter slot writes highlighter strokes', async () => {
    await open()
    key(canvas(), '2')
    expect(checked()).toBe(1)
    key(canvas(), '5')
    expect(checked()).toBe(1)
    key(canvas(), '1', { shiftKey: true })
    expect(checked()).toBe(1)
    key(canvas(), 'End', { code: 'Numpad1' }) // NumLock off
    expect(checked()).toBe(1)
    key(canvas(), '3', { code: 'Digit3' })
    expect(checked()).toBe(2)
    draw(100)
    await flush()
    expect(strokesOf(await saved())[0]).toMatchObject({ tool: 'highlighter', color: YELLOW, width: 14, usePressure: false })
  })

  test('number keys are ignored in a text field, with Ctrl and while a dialog is open', async () => {
    await open()
    const input = document.createElement('input')
    q('[role="toolbar"]')!.append(input)
    key(input, '2')
    key(canvas(), '2', { ctrlKey: true })
    expect(checked()).toBe(0)
    click(radios()[0]!) // opens the popover
    key(document.activeElement!, '2')
    expect(checked()).toBe(0)
  })

  test('P and H pick the last used slot of that tool; none of that tool does nothing', async () => {
    await open()
    key(canvas(), '2')
    key(canvas(), 'h', { code: 'KeyH' })
    expect(checked()).toBe(2)
    key(canvas(), 'p', { code: 'KeyP' })
    expect(checked()).toBe(1) // the pen used last
    key(canvas(), '1')
    key(canvas(), 'H')
    expect(checked()).toBe(2)
    act(() => root.unmount())
    root = createRoot(host)
    await mountEditor({ pens: createPenSlots(memStore(many(2)).storage), note: null })
    key(canvas(), '2')
    key(canvas(), 'h', { code: 'KeyH' })
    expect(checked()).toBe(1)
  })

  test('[+] copies the selected slot to the end, selects it, opens the popover and stores the list', async () => {
    const { m } = await open()
    click(radios()[1]!)
    click(addBtn())
    expect(radios()).toHaveLength(4)
    expect(checked()).toBe(3)
    expect(radios()[3]!.getAttribute('aria-label')).toBe('펜, 파랑, 두께 2.0 (4)')
    expect(dialog()).not.toBeNull()
    expect(colors(m)).toEqual([BLACK, BLUE, YELLOW, BLUE])
  })

  test('at 12 slots [+] still adds a 13th; no limit notice', async () => {
    await open(many(12))
    expect(addBtn().getAttribute('aria-disabled')).toBeNull()
    click(addBtn())
    expect(radios()).toHaveLength(13)
    expect(q('[role="alert"]')!.textContent).toBe('')
  })

  test('Alt+Right moves the slot and keeps it selected; the end does nothing', async () => {
    const { m } = await open()
    const first = radios()[0]!
    act(() => first.focus())
    key(first, 'ArrowRight', { altKey: true })
    expect(colors(m)).toEqual([BLUE, BLACK, YELLOW])
    expect(checked()).toBe(1)
    expect(document.activeElement).toBe(radios()[1])
    expect(q('[aria-live="polite"].sr-only')!.textContent).toBe('2번째로 옮겼어요')
    key(radios()[1]!, 'ArrowRight', { altKey: true })
    expect(colors(m)).toEqual([BLUE, YELLOW, BLACK])
    expect(checked()).toBe(2)
    key(radios()[2]!, 'ArrowRight', { altKey: true })
    expect(colors(m)).toEqual([BLUE, YELLOW, BLACK])
  })

  test('the last used index follows a move', async () => {
    await open()
    key(canvas(), '2')
    key(canvas(), 'h', { code: 'KeyH' }) // highlighter now selected, last pen = 2nd
    key(radios()[2]!, 'ArrowLeft', { altKey: true }) // highlighter to the 2nd place; the pen is the 3rd
    expect(checked()).toBe(1)
    key(canvas(), 'p', { code: 'KeyP' })
    expect(checked()).toBe(2)
  })

  test('dragging a slot over another reorders; dropping outside the toolbar keeps the order', async () => {
    const { m } = await open()
    const rect = (l: number, r: number, t = 0, b = 40) => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} }) as DOMRect
    q('.pen-toolbar')!.getBoundingClientRect = () => rect(0, 300)
    let shift = 0 // the dragged slot's rect includes its translateX, like a real browser
    radios().forEach((r, i) => (r.getBoundingClientRect = () => rect(40 * i + 40 + (i === 0 ? shift : 0), 40 * i + 76 + (i === 0 ? shift : 0))))
    const ptr = (el: Element, name: string, x: number, y = 20) =>
      act(() => void el.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y, button: 0 })))
    const first = radios()[0]!
    ptr(first, 'pointerdown', 58)
    ptr(first, 'pointermove', 60) // under 6 px: still a press
    expect(first.classList.contains('pen-slot-dragging')).toBe(false)
    ptr(first, 'pointermove', 120)
    shift = 62
    expect(first.classList.contains('pen-slot-dragging')).toBe(true)
    ptr(first, 'pointerup', 138) // over the 3rd slot
    first.click() // the click that ends a drag is ignored
    expect(dialog()).toBeNull()
    expect(colors(m)).toEqual([BLUE, YELLOW, BLACK])
    expect(checked()).toBe(2)
    const again = radios()[2]!
    ptr(again, 'pointerdown', 138)
    ptr(again, 'pointermove', 138, 200)
    ptr(again, 'pointerup', 138, 200) // below the toolbar
    expect(colors(m)).toEqual([BLUE, YELLOW, BLACK])
  })

  test('delete from the popover: closes it, the snackbar undo restores the same place and selection', async () => {
    const { m } = await open()
    key(canvas(), '2')
    click(radios()[1]!)
    click(q('.pen-popover-delete')!)
    expect(dialog()).toBeNull()
    expect(radios()).toHaveLength(2)
    expect(checked()).toBe(1) // the slot that moved up
    expect(colors(m)).toEqual([BLACK, YELLOW])
    expect(q('.snackbar-action')!.textContent).toContain('도구를 지웠어요')
    click(q('.snackbar-button')!)
    expect(colors(m)).toEqual([BLACK, BLUE, YELLOW])
    expect(checked()).toBe(1)
    expect(q('.snackbar-action')).toBeNull()
  })

  test('deleting the last slot selects the new last one; the undo goes away after 6 s or another change', async () => {
    await open()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      key(canvas(), '3')
      click(radios()[2]!)
      click(q('.pen-popover-delete')!)
      expect(checked()).toBe(1)
      act(() => void vi.advanceTimersByTime(5900))
      expect(q('.snackbar-action')).not.toBeNull()
      act(() => void vi.advanceTimersByTime(200))
      expect(q('.snackbar-action')).toBeNull()
      click(radios()[1]!)
      click(q('.pen-popover-delete')!)
      expect(q('.snackbar-action')).not.toBeNull()
      click(addBtn()) // another change drops the undo
      expect(q('.snackbar-action')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a pressure edit after a delete drops the undo, so it cannot restore stale slots', async () => {
    const { m } = await open()
    click(radios()[0]!)
    click(q('.pen-popover-delete')!)
    expect(q('.snackbar-action')).not.toBeNull()
    click(radios()[0]!)
    click(q('[role="switch"]')!)
    expect(q('.snackbar-action')).toBeNull()
    expect(colors(m)).toEqual([BLUE, YELLOW])
  })

  test('with one slot left [도구 삭제] is aria-disabled', async () => {
    const { m } = await open(many(1))
    click(radios()[0]!)
    const del = q('.pen-popover-delete')!
    expect(del.getAttribute('aria-disabled')).toBe('true')
    click(del)
    expect(dialog()).not.toBeNull()
    expect(m.get(PEN_SLOTS_KEY)).toBe(many(1))
  })

  test('roving tab index: one stop, arrows move without wrapping, Home and End', async () => {
    await open()
    const items = () => qa('[role="toolbar"] [data-roving]')
    expect(items().filter((e) => e.tabIndex === 0)).toEqual([radios()[0]])
    act(() => radios()[0]!.focus())
    key(radios()[0]!, 'ArrowLeft')
    expect(document.activeElement).toBe(items()[0]) // the handle comes first
    key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement).toBe(items()[0])
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement).toBe(radios()[0])
    key(radios()[0]!, 'ArrowRight')
    expect(document.activeElement).toBe(radios()[1])
    expect(items().filter((e) => e.tabIndex === 0)).toEqual([radios()[1]])
    key(document.activeElement!, 'End')
    expect(document.activeElement).toBe(items()[items().length - 1])
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement).toBe(items()[items().length - 1])
    key(document.activeElement!, 'Home')
    expect(document.activeElement).toBe(items()[0])
    expect(items().map((e) => e.getAttribute('data-roving'))).toEqual(['handle', 'slot-0', 'slot-1', 'slot-2', 'add', 'undo', 'redo', 'eraser', 'lasso', 'text', 'image'])
  })

  test('the wheel scrolls the slot area sideways only when it overflows', async () => {
    await open()
    const area = q('.pen-slots')!
    const wheel = () => {
      const e = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true })
      act(() => void area.dispatchEvent(e))
      return e
    }
    expect(wheel().defaultPrevented).toBe(false)
    Object.defineProperty(area, 'scrollWidth', { value: 600, configurable: true })
    Object.defineProperty(area, 'clientWidth', { value: 200, configurable: true })
    expect(wheel().defaultPrevented).toBe(true)
    expect(area.scrollLeft).toBe(40)
  })

  test('read-only: no select, add, move or key pick, and the tip says so', async () => {
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true })
    try {
      await mountEditor()
      const h = document.createElement('div')
      document.body.append(h)
      const r = createRoot(h)
      const { m, storage } = memStore()
      act(() =>
        r.render(
          createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore: makeOpen(), penStore: createPenSlots(storage), lockWaitMs: 0 })),
        ),
      )
      await flush()
      try {
        const rs = [...h.querySelectorAll<HTMLElement>('[role="radio"]')]
        const add = h.querySelector<HTMLElement>('.pen-add')!
        expect(add.getAttribute('aria-disabled')).toBe('true')
        expect(add.title).toBe('읽기 전용이에요')
        act(() => rs[1]!.click())
        act(() => add.click())
        key(rs[0]!, 'ArrowRight', { altKey: true })
        key(rs[0]!, '2')
        expect(h.querySelectorAll('[role="radio"]')).toHaveLength(3)
        expect(h.querySelectorAll('[role="radio"]')[0]!.getAttribute('aria-checked')).toBe('true')
        expect(m.has(PEN_SLOTS_KEY)).toBe(false)
      } finally {
        act(() => r.unmount())
        h.remove()
      }
    } finally {
      delete (navigator as { locks?: unknown }).locks
    }
  })

  test('a remount keeps the list and its order; the selection starts at the first', async () => {
    const s = await open()
    click(radios()[2]!)
    key(canvas(), '3')
    key(radios()[2]!, 'ArrowLeft', { altKey: true })
    act(() => root.unmount())
    root = createRoot(host)
    await mountEditor({ pens: createPenSlots(s.storage), note: null })
    expect(colors(s.m)).toEqual([BLACK, YELLOW, BLUE])
    expect(radios().map((r) => r.getAttribute('aria-label')?.slice(0, 3))).toEqual(['펜, ', '형광펜', '펜, '])
    expect(checked()).toBe(0)
  })
})

describe('pen popover (story 5.5)', () => {
  const mem = (key: string, initial?: string) => {
    const m = new Map<string, string>(initial === undefined ? [] : [[key, initial]])
    return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
  }
  const open = async (recentInit?: string, slotsInit?: string) => {
    const slots = mem(PEN_SLOTS_KEY, slotsInit)
    const rec = mem(RECENT_COLORS_KEY, recentInit)
    await mountEditor({ pens: createPenSlots(slots.storage), recent: createRecentColors(rec.storage) })
    click(q('.pen-slots [role="radio"]')!)
    return { slots: slots.m, rec: rec.m }
  }
  const slotList = (m: Map<string, string>) => JSON.parse(m.get(PEN_SLOTS_KEY)!) as { tool: string; color: string; width: number; usePressure: boolean }[]
  const cell = (i: number) => qa('.pen-palette [role="radio"]')[i]!
  const picker = () => q<HTMLInputElement>('.pen-color-input')!
  const caption = () => qa('.pen-caption')[1]!.textContent
  const slider = () => q<HTMLInputElement>('.pen-width-slider')!
  const up = () => q('.pen-step:not(.pen-step-down)')!

  test('arrow keys only move focus (no wrap); Enter applies, stores and puts the color first in recent', async () => {
    const { slots, rec } = await open()
    act(() => cell(0).focus())
    key(cell(0), 'ArrowLeft')
    expect(document.activeElement).toBe(cell(0))
    key(cell(0), 'ArrowRight')
    expect(document.activeElement).toBe(cell(1))
    expect(slots.get(PEN_SLOTS_KEY)).toBeUndefined()
    key(cell(1), 'ArrowDown')
    expect(document.activeElement).toBe(cell(7))
    key(cell(7), 'Enter')
    expect(slotList(slots)[0]!.color).toBe('#1971c2')
    expect(cell(7).getAttribute('aria-checked')).toBe('true')
    expect(cell(7).getAttribute('aria-label')).toBe('파랑')
    expect(JSON.parse(rec.get(RECENT_COLORS_KEY)!)).toEqual(['#1971c2'])
    expect(qa('.pen-recent [role="radio"]')).toHaveLength(1)
    click(qa('.pen-recent [role="radio"]')[0]!)
    expect(JSON.parse(rec.get(RECENT_COLORS_KEY)!)).toEqual(['#1971c2'])
  })

  test('recent keeps six: a new color goes first, the oldest drops, an old one moves up', async () => {
    const { rec } = await open(JSON.stringify(['#000001', '#000002', '#000003', '#000004', '#000005', '#000006']))
    expect(qa('.pen-recent [role="radio"]')).toHaveLength(6)
    click(cell(2))
    expect(JSON.parse(rec.get(RECENT_COLORS_KEY)!)).toEqual(['#e03131', '#000001', '#000002', '#000003', '#000004', '#000005'])
    click(qa('.pen-recent [role="radio"]')[3]!)
    expect(JSON.parse(rec.get(RECENT_COLORS_KEY)!)).toEqual(['#000003', '#e03131', '#000001', '#000002', '#000004', '#000005'])
  })

  test('[custom] opens the hidden picker; input applies, change records; the custom cell is checked', async () => {
    const { slots, rec } = await open()
    const spy = vi.spyOn(picker(), 'click').mockImplementation(() => {})
    click(cell(12))
    expect(spy).toHaveBeenCalled()
    picker().value = '#12AB34'
    act(() => void picker().dispatchEvent(new Event('input', { bubbles: true })))
    expect(slotList(slots)[0]!.color).toBe('#12ab34')
    expect(cell(12).getAttribute('aria-checked')).toBe('true')
    expect(rec.get(RECENT_COLORS_KEY)).toBeUndefined()
    act(() => void picker().dispatchEvent(new Event('change', { bubbles: true })))
    expect(JSON.parse(rec.get(RECENT_COLORS_KEY)!)).toEqual(['#12ab34'])
    expect(qa('.pen-recent [role="radio"]')[0]!.getAttribute('aria-label')).toBe('사용자 지정')
  })

  test('width: slider arrows step 0.1 without float noise; the caption follows; the stepper disables at the end', async () => {
    const { slots } = await open()
    expect(caption()).toBe('두께 2.0')
    act(() => slider().focus())
    for (let i = 0; i < 3; i++) key(slider(), 'ArrowRight')
    expect(slotList(slots)[0]!.width).toBe(2.3)
    expect(caption()).toBe('두께 2.3')
    key(slider(), 'ArrowLeft')
    expect(slotList(slots)[0]!.width).toBe(2.2)
    click(up())
    expect(slotList(slots)[0]!.width).toBe(2.3)
    expect(slider().min).toBe('0.5')
    expect(slider().max).toBe('10')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider(), '10')
      slider().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(slotList(slots)[0]!.width).toBe(10)
    expect(up().getAttribute('aria-disabled')).toBe('true')
    click(up())
    expect(slotList(slots)[0]!.width).toBe(10)
  })

  test('tool switch: slot gets that tool defaults, the pressure switch hides, the same tool does nothing', async () => {
    const { slots } = await open()
    const [penBtn, hiBtn] = qa('.pen-tool-switch [role="radio"]')
    click(penBtn!) // already a pen
    expect(slots.get(PEN_SLOTS_KEY)).toBeUndefined()
    click(hiBtn!)
    expect(slotList(slots)[0]).toEqual({ tool: 'highlighter', color: '#ffe066', width: 14, usePressure: false })
    expect(q('.pen-popover h2')!.textContent).toBe('형광펜')
    expect(q('[role="switch"]')).toBeNull()
    expect(qa('.pen-palette [role="radio"]')).toHaveLength(7) // 6 colors + custom
    expect(slider().getAttribute('min')).toBe('4')
    expect(q('.pen-preview path')!.getAttribute('fill-opacity')).toBe('0.4')
    expect(qa('[role="status"]').some((e) => e.textContent === '형광펜')).toBe(true)
    key(document.activeElement!, 'Escape')
    expect(qa('.pen-slots [role="radio"]')[0]!.getAttribute('aria-checked')).toBe('true')
    key(canvas(), 'h', { code: 'KeyH' })
    expect(qa('.pen-slots [role="radio"]')[0]!.getAttribute('aria-checked')).toBe('true') // slot 1 is the last highlighter now
  })

  test('a highlighter stroke is saved as highlighter with the new color and width', async () => {
    await open()
    click(qa('.pen-tool-switch [role="radio"]')[1]!)
    click(cell(3))
    key(document.activeElement!, 'Escape')
    fire('pointerdown', { x: 100, y: 100 })
    fire('pointermove', { x: 130, y: 100 })
    fire('pointerup', { x: 160, y: 100 })
    await flush()
    expect(strokesOf(await saved())[0]).toMatchObject({ tool: 'highlighter', color: '#faa2c1', width: 14, usePressure: false })
  })

  test('slot and recent colors survive a remount (device setting)', async () => {
    const slots = mem(PEN_SLOTS_KEY)
    const rec = mem(RECENT_COLORS_KEY)
    await mountEditor({ pens: createPenSlots(slots.storage), recent: createRecentColors(rec.storage) })
    click(q('.pen-slots [role="radio"]')!)
    click(cell(2))
    act(() => root.unmount())
    root = createRoot(host)
    await mountEditor({ pens: createPenSlots(slots.storage), recent: createRecentColors(rec.storage), note: null })
    click(q('.pen-slots [role="radio"]')!)
    expect(cell(2).getAttribute('aria-checked')).toBe('true')
    expect(qa('.pen-recent [role="radio"]')[0]!.getAttribute('aria-label')).toBe('빨강')
  })

  test('strings exist in both languages and English names show', async () => {
    for (const k of ['editor.tool.pen', 'editor.tool.highlighter', 'editor.recent', 'editor.widthCaption', 'editor.widthDown', 'editor.widthUp', 'editor.toolKind', 'editor.palette'] as const) {
      expect(resources.ko[k]).toBeTruthy()
      expect(resources.en[k]).toBeTruthy()
    }
    await mountEditor({ lang: 'en-US', pens: createPenSlots(mem(PEN_SLOTS_KEY).storage), recent: createRecentColors(mem(RECENT_COLORS_KEY).storage) })
    click(q('.pen-slots [role="radio"]')!)
    expect(caption()).toBe('Width 2.0')
    expect(cell(7).getAttribute('aria-label')).toBe('Blue')
  })
})

describe('eraser (story 5.7)', () => {
  const memory = (init?: object) => {
    const m = new Map<string, string>(init ? [[ERASER_KEY, JSON.stringify(init)]] : [])
    return { m, store: createEraserSettings({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }) }
  }
  const ink = (id: string, y: number): Stroke =>
    ({ id, type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: true, points: Array.from({ length: 11 }, (_, i) => [i * 10, y, 0.5, i * 10]) }) as Stroke
  const noteWith = (...els: unknown[]) => {
    const n = newNote('n1')
    n.pages[0]!.elements.push(...(els as never[]))
    return n
  }
  const text = { id: 'tx', type: 'text', x: 20, y: 90, width: 60, rotation: 0, text: 'hi' }
  const eraserBtn = () => q<HTMLButtonElement>('button[data-tool="eraser"]')!
  const ctrl = (k: string) => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true })))
  const ids = async () => ((await saved()).pages[0]!.elements as { id: string }[]).map((e) => e.id)
  // A vertical pass through x = 50, from y 90 to 130.
  const pass = (type = 'mouse', init: Partial<PInit> = {}) => {
    fire('pointerdown', { type, x: 50, y: 90, ...init })
    fire('pointermove', { type, x: 50, y: 110, ...init })
    fire('pointermove', { type, x: 50, y: 130, ...init })
    fire('pointerup', { type, x: 50, y: 130, ...init, buttons: 0 })
  }

  test('E and the button select it; name, tooltip, pressed; the slot stays selected', async () => {
    await mountEditor()
    expect(eraserBtn().getAttribute('aria-pressed')).toBe('false')
    canvas().focus()
    key(canvas(), 'e', { code: 'KeyE' })
    expect(eraserBtn().getAttribute('aria-pressed')).toBe('true')
    expect(eraserBtn().title).toBe('지우개 (E)')
    expect(eraserBtn().getAttribute('aria-label')).toBe('지우개, 획 단위')
    expect(q('.pen-slots [role="radio"]')!.getAttribute('aria-checked')).toBe('true')
    expect(canvas().classList.contains('is-eraser')).toBe(true)
    click(q('button[data-tool="lasso"]')!)
    expect(eraserBtn().getAttribute('aria-pressed')).toBe('false')
    expect(canvas().classList.contains('is-eraser')).toBe(false)
    key(canvas(), 'e', { ctrlKey: true })
    expect(eraserBtn().getAttribute('aria-pressed')).toBe('false')
    // The roving order: undo, redo, eraser, lasso, text, image.
    expect(qa('[data-roving]').map((b) => b.dataset.roving).slice(-6)).toEqual(['undo', 'redo', 'eraser', 'lasso', 'text', 'image'])
  })

  test('stroke mode: one pass erases both strokes, keeps the text, is one undo step', async () => {
    await mountEditor({ note: noteWith(ink('a', 100), text, ink('b', 120)) })
    click(eraserBtn())
    pass()
    await flush()
    expect(await ids()).toEqual(['tx'])
    ctrl('z')
    await flush()
    expect(await ids()).toEqual(['a', 'tx', 'b'])
    ctrl('y')
    await flush()
    expect(await ids()).toEqual(['tx'])
  })

  test('the note stays whole until the release', async () => {
    await mountEditor({ note: noteWith(ink('a', 100)) })
    click(eraserBtn())
    fire('pointerdown', { type: 'mouse', x: 50, y: 90 })
    fire('pointermove', { type: 'mouse', x: 50, y: 110 })
    await flush()
    expect(await ids()).toEqual(['a'])
    fire('pointerup', { type: 'mouse', x: 50, y: 110, buttons: 0 })
    await flush()
    expect(await ids()).toEqual([])
  })

  test('partial mode: two pieces with new ids and original points; undo and redo reuse them', async () => {
    const { store } = memory({ mode: 'partial', returnToPen: false })
    const a = ink('a', 100)
    await mountEditor({ note: noteWith(a), eraser: store })
    expect(eraserBtn().getAttribute('aria-label')).toBe('지우개, 부분')
    click(eraserBtn())
    pass()
    await flush()
    const pieces = strokesOf(await saved())
    expect(pieces).toHaveLength(2)
    expect(pieces.map((p) => p.id)).not.toContain('a')
    expect(pieces[0]!.points).toEqual(a.points.slice(0, 5))
    expect(pieces[1]!.points).toEqual(a.points.slice(6))
    ctrl('z')
    await flush()
    expect(await ids()).toEqual(['a'])
    ctrl('y')
    await flush()
    expect(await ids()).toEqual(pieces.map((p) => p.id))
  })

  test('a tap erases inside the disc; a miss records nothing', async () => {
    await mountEditor({ note: noteWith(ink('a', 100)) })
    click(eraserBtn())
    fire('pointerdown', { type: 'mouse', x: 50, y: 150 })
    fire('pointerup', { type: 'mouse', x: 50, y: 150, buttons: 0 })
    await flush()
    expect(await ids()).toEqual(['a'])
    ctrl('z') // nothing was recorded: there is nothing to undo
    await flush()
    expect(await ids()).toEqual(['a'])
    fire('pointerdown', { type: 'mouse', x: 52, y: 104 })
    fire('pointerup', { type: 'mouse', x: 52, y: 104, buttons: 0 })
    await flush()
    expect(await ids()).toEqual([])
  })

  test('pen barrel button and eraser end erase under the pen tool; the tool does not change', async () => {
    const { store } = memory({ mode: 'stroke', returnToPen: true })
    await mountEditor({ note: noteWith(ink('a', 100), ink('b', 220)), eraser: store })
    fire('pointerdown', { type: 'pen', x: 50, y: 95, buttons: 3, button: 2 })
    fire('pointermove', { type: 'pen', x: 50, y: 105, buttons: 3, button: -1 })
    fire('pointerup', { type: 'pen', x: 50, y: 105, buttons: 0, button: 2 })
    await flush()
    expect(await ids()).toEqual(['b'])
    fire('pointerdown', { type: 'pen', x: 50, y: 215, buttons: 32, button: 5 })
    fire('pointerup', { type: 'pen', x: 50, y: 225, buttons: 0, button: 5 })
    await flush()
    expect(await ids()).toEqual([])
    expect(eraserBtn().getAttribute('aria-pressed')).toBe('false') // not switched, and no return-to-pen either
    fire('pointerdown', { x: 20, y: 20 }) // an ordinary press draws again
    fire('pointerup', { x: 60, y: 20 })
    await flush()
    expect(strokesOf(await saved())).toHaveLength(1)
  })

  test('a cancelled gesture drops the preview: no operation, no return to the pen', async () => {
    const { store } = memory({ mode: 'stroke', returnToPen: true })
    await mountEditor({ note: noteWith(ink('a', 100)), eraser: store })
    click(eraserBtn())
    fire('pointerdown', { type: 'pen', x: 50, y: 90 })
    fire('pointermove', { type: 'pen', x: 50, y: 110 })
    fire('pointercancel', { type: 'pen', x: 50, y: 110, buttons: 0 })
    await flush()
    expect(await ids()).toEqual(['a'])
    expect(eraserBtn().getAttribute('aria-pressed')).toBe('true')
    ctrl('z') // nothing was recorded
    await flush()
    expect(await ids()).toEqual(['a'])
  })

  test('a finger with the eraser tool does not erase or draw', async () => {
    await mountEditor({ note: noteWith(ink('a', 100)) })
    click(eraserBtn())
    pass('touch')
    await flush()
    expect(await ids()).toEqual(['a'])
  })

  test('return to the pen: after a pen erase that touched, not for the mouse or a miss', async () => {
    const { store } = memory({ mode: 'stroke', returnToPen: true })
    await mountEditor({ note: noteWith(ink('a', 100), ink('b', 200), ink('c', 300)), eraser: store })
    const pressed = () => eraserBtn().getAttribute('aria-pressed')
    click(eraserBtn())
    fire('pointerdown', { type: 'mouse', x: 50, y: 100 })
    fire('pointerup', { type: 'mouse', x: 50, y: 100, buttons: 0 })
    await flush()
    expect(await ids()).toEqual(['b', 'c'])
    expect(pressed()).toBe('true') // the mouse stays on the eraser
    fire('pointerdown', { type: 'pen', x: 300, y: 500 }) // a pen that touches nothing
    fire('pointerup', { type: 'pen', x: 300, y: 500, buttons: 0 })
    expect(pressed()).toBe('true')
    fire('pointerdown', { type: 'pen', x: 50, y: 200 })
    fire('pointerup', { type: 'pen', x: 50, y: 200, buttons: 0 })
    await flush()
    expect(await ids()).toEqual(['c'])
    expect(pressed()).toBe('false')
  })

  test('popover: opens on a second click, keyboard sets the way, saves, announces, Esc returns focus', async () => {
    const { m, store } = memory()
    await mountEditor({ eraser: store })
    click(eraserBtn())
    expect(q('[role="dialog"]')).toBeNull()
    click(eraserBtn())
    const dlg = q('[role="dialog"]')!
    expect(dlg.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dlg.querySelector('h2')!.textContent).toBe('지우개')
    const radios = qa('.eraser-popover [role="radio"]')
    expect(radios.map((r) => r.textContent)).toEqual(['획 단위', '부분'])
    expect(document.activeElement).toBe(radios[0])
    key(radios[0]!, 'ArrowRight')
    expect(document.activeElement).toBe(radios[1])
    key(radios[1]!, 'Enter')
    expect(JSON.parse(m.get(ERASER_KEY)!)).toEqual({ mode: 'partial', returnToPen: false })
    expect(q('[aria-live="polite"]')!.textContent).toContain('부분 지우기')
    expect(eraserBtn().getAttribute('aria-label')).toBe('지우개, 부분')
    const sw = q('.eraser-popover [role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    click(sw)
    expect(JSON.parse(m.get(ERASER_KEY)!).returnToPen).toBe(true)
    key(document.activeElement!, 'Tab') // the stops are the chosen way and the switch
    key(document.activeElement!, 'Tab')
    expect(dlg.contains(document.activeElement)).toBe(true)
    key(document.activeElement!, 'Escape')
    expect(q('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(eraserBtn())
    expect(eraserBtn().getAttribute('aria-pressed')).toBe('true') // closing keeps the tool and the settings
  })

  test('English names; strings exist in both languages', async () => {
    const { store } = memory({ mode: 'partial', returnToPen: true })
    await mountEditor({ eraser: store, lang: 'en-US' })
    expect(eraserBtn().getAttribute('aria-label')).toBe('Eraser, Partial')
    expect(eraserBtn().title).toBe('Eraser (E)')
    for (const k of ['editor.eraser', 'editor.eraserTip', 'editor.eraserLabel', 'editor.eraserStroke', 'editor.eraserPartial', 'editor.eraserReturn', 'editor.eraserModeGroup', 'editor.eraserSayStroke', 'editor.eraserSayPartial'] as const) {
      expect(resources.ko[k]).toBeTruthy()
      expect(resources.en[k]).toBeTruthy()
    }
  })

  test('read-only (another tab holds the note): no E, no popover, no erasing', async () => {
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true })
    await mountEditor({ note: noteWith(ink('a', 100)) })
    const h = document.createElement('div')
    document.body.append(h)
    const r = createRoot(h)
    act(() => r.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }), noteId: 'n1', openStore: makeOpen(), lockWaitMs: 0 }))))
    await flush()
    try {
      const c = h.querySelector<HTMLCanvasElement>('canvas')!
      const b = h.querySelector<HTMLButtonElement>('button[data-tool="eraser"]')!
      expect(h.querySelector('.editor-banner')).not.toBeNull()
      expect(b.getAttribute('aria-disabled')).toBe('true')
      c.focus()
      act(() => void c.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true, cancelable: true })))
      act(() => b.click())
      act(() => b.click())
      expect(b.getAttribute('aria-pressed')).toBe('false')
      expect(h.querySelector('[role="dialog"]')).toBeNull()
      for (const n of ['pointerdown', 'pointermove', 'pointerup']) act(() => void c.dispatchEvent(pev(n, { type: 'pen', x: 50, y: 100, buttons: n === 'pointerup' ? 0 : 3, button: 2 })))
      await flush()
      expect(await ids()).toEqual(['a'])
    } finally {
      act(() => r.unmount())
      h.remove()
      delete (navigator as { locks?: unknown }).locks
    }
  })
})

describe('toolbar move and snap (story 5.10)', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
  }
  const bar = () => q('.pen-toolbar')!
  const grip = () => q<HTMLButtonElement>('.toolbar-grip')!
  const stored = (m: Map<string, string>) => JSON.parse(m.get(TOOLBAR_KEY)!) as { dock: string; x: number; y: number; vertical: boolean }
  const real = HTMLElement.prototype.getBoundingClientRect
  const ptr = (name: string, x: number, y: number) => act(() => void grip().dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', clientX: x, clientY: y, button: 0 })))
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    // Horizontal 400x40 (centred at 500,32 in the top row), vertical 40x400; placed by left/top (its centre) once floating.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.classList.contains('pen-toolbar')) return real.call(this)
      const v = this.classList.contains('is-vertical')
      const [w, h] = v ? [40, 400] : [400, 40]
      const cx = this.style.left ? parseFloat(this.style.left) : 500
      const cy = this.style.top ? parseFloat(this.style.top) : 32
      return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2, width: w, height: h, x: cx - w / 2, y: cy - h / 2, toJSON() {} } as DOMRect
    }
  })
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = real
  })

  test('the handle is a menu button first in the roving order; dragging shows 4 outlines and a drop near the left docks vertically', async () => {
    const s = mem()
    await mountEditor({ toolbar: createToolbarPosition(s.storage) })
    expect(grip().getAttribute('aria-haspopup')).toBe('menu')
    expect(grip().dataset.roving).toBe('handle')
    ptr('pointerdown', 330, 32) // 170 left of the centre
    ptr('pointermove', 200, 100)
    expect(qa('.toolbar-snap')).toHaveLength(4)
    expect(bar().classList.contains('is-dragging')).toBe(true)
    ptr('pointermove', -138, 384) // centre (32, 384): on the left outline
    expect(qa('.toolbar-snap-near')).toHaveLength(1)
    ptr('pointerup', -138, 384)
    expect(qa('.toolbar-snap')).toHaveLength(0)
    expect(bar().classList.contains('is-vertical')).toBe(true)
    expect(stored(s.m)).toMatchObject({ dock: 'left', vertical: true })
    click(grip()) // the click that ends a drag opens no menu
    expect(q('[role="menu"]')).toBeNull()
  })

  test('a drop away from every outline floats at that place and keeps the orientation', async () => {
    const s = mem()
    await mountEditor({ toolbar: createToolbarPosition(s.storage) })
    ptr('pointerdown', 330, 32)
    ptr('pointermove', 330, 400)
    ptr('pointerup', 330, 400) // centre (500, 400)
    expect(stored(s.m)).toEqual({ dock: 'float', x: 0.5, y: 0.5, vertical: false })
    expect(bar().classList.contains('is-floating')).toBe(true)
  })

  test('Esc while dragging restores and saves nothing', async () => {
    const s = mem()
    await mountEditor({ toolbar: createToolbarPosition(s.storage) })
    ptr('pointerdown', 330, 32)
    ptr('pointermove', 330, 400)
    expect(qa('.toolbar-snap')).toHaveLength(4)
    key(document, 'Escape')
    expect(qa('.toolbar-snap')).toHaveLength(0)
    expect(bar().classList.contains('is-floating')).toBe(false)
    expect(s.m.has(TOOLBAR_KEY)).toBe(false)
    ptr('pointerup', 330, 400) // the release after Esc is not a click on the handle
    click(grip())
    expect(q('[role="menu"]')).toBeNull()
  })

  test('a press that stays within 6px is a click: the position menu; keys pick; announced; focus returns to the handle', async () => {
    const s = mem()
    await mountEditor({ toolbar: createToolbarPosition(s.storage) })
    ptr('pointerdown', 330, 32)
    ptr('pointerup', 333, 32)
    click(grip())
    expect(q('[role="menu"]')!.getAttribute('aria-label')).toBe('툴바 위치')
    expect(grip().getAttribute('aria-expanded')).toBe('true')
    const items = qa('[role="menuitemradio"]')
    expect(items.map((i) => i.textContent)).toEqual(['상단', '왼쪽', '오른쪽', '하단'])
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false'])
    expect(document.activeElement).toBe(items[0])
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(items[1])
    click(items[1]!)
    expect(q('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(grip())
    expect(qa('[aria-live="polite"]').some((e) => e.textContent === '툴바를 왼쪽에 붙였어요')).toBe(true)
    expect(stored(s.m)).toMatchObject({ dock: 'left', vertical: true })
    click(grip())
    key(document.activeElement!, 'Escape')
    expect(q('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(grip())
    expect(stored(s.m).dock).toBe('left')
  })

  test('vertical toolbar: up/down move between items in DOM order, left/right do nothing', async () => {
    const s = mem()
    s.m.set(TOOLBAR_KEY, JSON.stringify({ dock: 'right', x: 0.5, y: 0, vertical: true }))
    await mountEditor({ toolbar: createToolbarPosition(s.storage) })
    expect(bar().getAttribute('aria-orientation')).toBe('vertical')
    act(() => grip().focus())
    key(grip(), 'ArrowRight')
    expect(document.activeElement).toBe(grip())
    key(grip(), 'ArrowDown')
    expect(document.activeElement).toBe(q('[data-slot="0"]'))
    key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement).toBe(grip())
    key(grip(), 'ArrowUp')
    expect(document.activeElement).toBe(grip())
  })

  test('a window smaller than the toolbar pulls it in for display only; growing it again restores', async () => {
    const s = mem()
    s.m.set(TOOLBAR_KEY, JSON.stringify({ dock: 'float', x: 0.95, y: 0.5, vertical: false }))
    await mountEditor({ toolbar: createToolbarPosition(s.storage) })
    expect(bar().style.left).toBe('800px') // 950 pulled in to 1000 - 200
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true })
    act(() => void window.dispatchEvent(new Event('resize')))
    expect(bar().style.left).toBe('400px')
    expect(stored(s.m).x).toBe(0.95)
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    act(() => void window.dispatchEvent(new Event('resize')))
    expect(bar().style.left).toBe('800px')
  })

  test('a new mount restores the position', async () => {
    const s = mem()
    s.m.set(TOOLBAR_KEY, JSON.stringify({ dock: 'bottom', x: 0.5, y: 0, vertical: false }))
    await mountEditor({ toolbar: createToolbarPosition(s.storage) })
    expect(bar().classList.contains('is-floating')).toBe(true)
    expect(bar().style.top).toBe('768px') // 800 - 12 - 20
  })

  test('focus under the toolbar pans the view once; reduced motion removes the transition', async () => {
    await mountEditor()
    const area = q('.editor-page-area')!
    const input = document.createElement('textarea')
    area.append(input)
    input.getBoundingClientRect = () => ({ left: 400, right: 500, top: 20, bottom: 60, width: 100, height: 40 }) as DOMRect
    area.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 800, width: 1000, height: 800 }) as DOMRect
    const pan = vi.spyOn(Writer.prototype, 'panBy')
    act(() => input.focus())
    expect(pan).toHaveBeenCalledTimes(1)
    pan.mockRestore()
    const css = readFileSync('src/ui/app.css', 'utf8')
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.pen-toolbar\.is-floating \{\s*transition: none/)
  })
})

describe('previous / next note (Story 5.14)', () => {
  const titled = (id: string, title: string): Note => {
    const n = newNote(id)
    return { ...n, meta: { ...n.meta, title } }
  }
  const order = (...ids: [string, string | null][]) => publishNoteOrder(ids.map(([noteId, title]) => ({ noteId, title })))
  const openMenu = async () => {
    click(q('.editor-more button')!)
    await flush()
  }
  const item = (label: string) => qa('[role="menu"] [role="menuitem"]').find((b) => b.textContent === label)!
  const render = (id: string) =>
    act(() =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nFor('ko-KR') },
          createElement(NoteEditor, {
            key: id,
            noteId: id,
            openStore: makeOpen(),
            eraserStore: createEraserSettings({ getItem: () => null, setItem: () => {} }),
            toolbarStore: createToolbarPosition({ getItem: () => null, setItem: () => {} }),
            viewModeStore: createViewMode({ getItem: () => null, setItem: () => {} }),
            penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }),
          }),
        ),
      ),
    )

  test('next goes by the library order, then shows the chip, the back bar and the word; the ends are disabled', async () => {
    await seed(titled('b', 'B'))
    await seed(titled('c', 'C'))
    order(['a', 'A'], ['b', 'B'], ['x', null], ['c', 'C'])
    await mountEditor({ id: 'a', note: titled('a', 'A') })
    await openMenu()
    expect(item('이전 노트').getAttribute('aria-disabled')).toBe('true')
    click(item('이전 노트'))
    expect(location.hash).toBe('')
    click(item('다음 노트'))
    await flush()
    expect(location.hash).toBe('#/notes/b')
    expect(q('[role="menu"]')).toBeNull()
    render('b')
    await flush()
    expect(q('.editor-position-chip')!.textContent).toBe('B · 2/3')
    expect(q('.snackbar-action')!.textContent).toContain('‘A’로 돌아가기')
    expect(q('[data-result]')!.textContent).toBe('‘B’ 열림')
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    click(q('.snackbar-action button')!)
    expect(back).toHaveBeenCalledOnce()
    expect(q('.snackbar-action')).toBeNull()
    back.mockRestore()
    // the jump left a note behind that skips the title-less one
    await openMenu()
    expect(item('다음 노트').getAttribute('aria-disabled')).toBe('false')
    click(item('다음 노트'))
    await flush()
    expect(location.hash).toBe('#/notes/c')
  })

  test('a fast second press jumps once', async () => {
    await seed(titled('b', 'B'))
    order(['a', 'A'], ['b', 'B'])
    await mountEditor({ id: 'a', note: titled('a', 'A') })
    await openMenu()
    const next = item('다음 노트')
    click(next)
    click(next)
    await flush()
    expect(location.hash).toBe('#/notes/b')
  })

  test('without a published order the notes by name stand in', async () => {
    await seed(titled('b', 'B'))
    publishNoteOrder([])
    await mountEditor({ id: 'a', note: titled('a', 'A') })
    await flush()
    await openMenu()
    expect(item('이전 노트').getAttribute('aria-disabled')).toBe('true')
    expect(item('다음 노트').getAttribute('aria-disabled')).toBe('false')
  })
})
