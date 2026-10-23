// @vitest-environment jsdom
// Writing screen: input -> addStroke -> serial saves, rendering, semantics (story 2.10).
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nContext, createI18n, resources } from '../src/i18n'
import type { Note, Page, Stroke } from '../src/model/note'
import { defaultPen } from '../src/model/pen'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { clearSessionHistories, sessionHistory } from '../src/ops/sessionHistories'
import { StrokePathCache, fitViewport, paintPage } from '../src/render/pagePainter'
import { pageBackground } from '../src/render/pageBackground'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { acquireNoteLock } from '../src/storage/noteLock'
import { PEN_SLOTS_KEY, createPenSlots, sharedPenSlots, type PenSlotsStore } from '../src/storage/penSlots'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { SaveQueue, savesSettled, trackSave } from '../src/storage/saveQueue'
import { getOpenNote } from '../src/sync/openNotes'
import { App } from '../src/ui/App'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Writer } from '../src/ui/library/writer'
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

async function mountEditor(o: { id?: string; lang?: string; opts?: Opts; note?: Note | null; pens?: PenSlotsStore } = {}) {
  const id = o.id ?? 'n1'
  if (o.note !== null) await seed(o.note ?? newNote(id))
  act(() =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: i18nFor(o.lang ?? 'ko-KR') },
        createElement(NoteEditor, { noteId: id, openStore: makeOpen(o.opts), penStore: o.pens }),
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
    expect(tb.querySelector('.toolbar-grip')!.getAttribute('aria-hidden')).toBe('true')
    const radios = qa('[role="radiogroup"] [role="radio"]')
    expect(radios).toHaveLength(1)
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
    expect(radios[0]!.getAttribute('aria-label')).toBe('펜, 검정, 두께 2.0 (1)')
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
      expect.arrayContaining(['editor.undo', 'editor.redo', 'editor.undoTip', 'editor.redoTip', 'editor.historyNotApplied', 'editor.penSlot', 'editor.colorBlack', 'editor.page', 'editor.handwriting', 'editor.saveFailed', 'editor.strokeNotAdded', 'editor.toolbar', 'editor.canvas', 'editor.more', 'editor.zoomOut', 'editor.zoomIn', 'editor.zoomLevel', 'editor.fitWidth', 'editor.fitPage', 'editor.zoomOutTip', 'editor.zoomInTip', 'editor.fitWidthTip']),
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
    act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { noteId: 'n1', openStore: open }))))
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
    expect(kids[2]!.className).toBe('toolbar-divider')
    expect(kids[2]!.getAttribute('aria-hidden')).toBe('true')
    expect(kids[3]).toBe(undoBtn())
    expect(kids[4]).toBe(redoBtn())
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
    const items = [...q('[role="menu"]')!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map((i) => i.getAttribute('aria-label') ?? i.textContent)).toEqual([
      'Zoom out',
      'Zoom in',
      'Fit width',
      'Fit page',
    ])
    expect(q('[role="status"][aria-live="polite"]')!.textContent).toBe(`Zoom ${Math.round(fit() * 100)}%`)
    expect(document.activeElement).toBe(items[0])
    key(items[0]!, 'ArrowUp')
    expect(document.activeElement).toBe(items[3])
    key(items[3]!, 'ArrowDown')
    expect(document.activeElement).toBe(items[0])
    key(items[0]!, 'End')
    expect(document.activeElement).toBe(items[3])
    key(items[3]!, 'Home')
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
        createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { noteId: id, openStore: makeOpen(opts) })),
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
      sharedPenSlots().write([defaultPen])
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
      root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { noteId: 'n1', openStore }))),
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
    const labelId = sw().getAttribute('aria-labelledby')!
    expect(document.getElementById(labelId)!.textContent).toBe('필압 반영')
    expect(d.querySelector('svg.pen-preview path')!.getAttribute('d')).toMatch(/^M/)
    expect(document.activeElement).toBe(sw())
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

  test('Tab stays on the switch; outside press and Esc close, keep the change, focus the slot', async () => {
    const { m, storage } = memStore()
    await mountEditor({ pens: createPenSlots(storage) })
    // Enter/Space on a button is a click, so the keyboard route is this handler.
    click(slot())
    click(sw())
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => void sw().dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(sw())
    act(() => void q('.pen-popover-scrim')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(dialog()).toBeNull()
    expect(storedUp(m)).toBe(false)
    expect(document.activeElement).toBe(slot())
    click(slot())
    key(sw(), 'Escape')
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
          createElement(NoteEditor, { noteId: 'n1', openStore: makeOpen(), penStore: createPenSlots(storage) }),
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
    key(sw(), 'F6')
    expect(document.activeElement).toBe(sw())
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
      act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(NoteEditor, { noteId: 'n1', openStore: open }))))
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
