// @vitest-environment jsdom
// Writing screen: input -> addStroke -> serial saves, rendering, semantics (story 2.10).
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nContext, createI18n, resources } from '../src/i18n'
import type { Note, Page, Stroke } from '../src/model/note'
import { History } from '../src/ops/history'
import { createNote } from '../src/ops/ops'
import { clearSessionHistories, sessionHistory } from '../src/ops/sessionHistories'
import { StrokePathCache, fitViewport, paintPage } from '../src/render/pagePainter'
import { pageBackground } from '../src/render/pageBackground'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { SaveQueue, savesSettled, trackSave } from '../src/storage/saveQueue'
import { App } from '../src/ui/App'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { signedIn } from './helpers'

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

async function mountEditor(o: { id?: string; lang?: string; opts?: Opts; note?: Note | null } = {}) {
  const id = o.id ?? 'n1'
  if (o.note !== null) await seed(o.note ?? newNote(id))
  act(() =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: i18nFor(o.lang ?? 'ko-KR') },
        createElement(NoteEditor, { noteId: id, openStore: makeOpen(o.opts) }),
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
    expect(q('.editor-title')!.textContent).toBe('필기 노트')
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
      expect.arrayContaining(['editor.undo', 'editor.redo', 'editor.undoTip', 'editor.redoTip', 'editor.historyNotApplied', 'editor.penSlot', 'editor.colorBlack', 'editor.page', 'editor.handwriting', 'editor.saveFailed', 'editor.strokeNotAdded', 'editor.toolbar', 'editor.canvas']),
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
    fire('pointerdown', { type: 'touch', id: 1, x: 10, y: 10 })
    fire('pointerdown', { type: 'touch', id: 2, x: 200, y: 200 })
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
