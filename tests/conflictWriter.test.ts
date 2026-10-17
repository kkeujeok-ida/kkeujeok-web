// @vitest-environment jsdom
// Story 3.20, the editor side: a page with an unresolved conflict is read-only (strokes, undo, redo) while the
// other pages stay editable; a conflict found while a stroke is in progress waits for the pointer to go up,
// puts the finished stroke into the sidecar and keeps the local version on screen until the editor closes.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import type { Note, Stroke } from '../src/model/note'
import { History } from '../src/ops/history'
import { clearSessionHistories, sessionHistory } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { createMergeIo } from '../src/sync/mergeIo'
import type { Conflict, Sidecar } from '../src/sync/merge'
import { getOpenNote } from '../src/sync/openNotes'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Writer } from '../src/ui/library/writer'
import { NID, PA, PB, foreignEdit, mkNote, stroke } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
let fills = 0
const fakeCtx = new Proxy({}, { get: (_t, k) => (k === 'fill' ? (p: unknown) => void (p instanceof FakePath && fills++) : () => {}), set: () => true })
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
const canvas = () => q<HTMLCanvasElement>('canvas.editor-canvas')!
const openStore = () => {
  const s = openNoteStore()
  stores.push(s)
  return s
}
let clock = 1000
function fire(name: string, o: { type?: string; x: number; y: number; id?: number; buttons?: number }) {
  const e = new PointerEvent(name, {
    bubbles: true,
    cancelable: true,
    pointerId: o.id ?? 1,
    pointerType: o.type ?? 'pen',
    clientX: o.x,
    clientY: o.y,
    pressure: 0.5,
    button: 0,
    buttons: o.buttons ?? 1,
  })
  Object.defineProperty(e, 'timeStamp', { value: (clock += 10) })
  act(() => void canvas().dispatchEvent(e))
}
const draw = (x = 100, y = 100, type = 'pen') => {
  fire('pointerdown', { x, y, type })
  fire('pointermove', { x: x + 10, y, type })
  fire('pointerup', { x: x + 20, y, type })
}
const ctrl = (k: string, init: KeyboardEventInit = {}) =>
  act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true, ...init })))

const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const alertText = () => q('[role="alert"]')?.textContent ?? ''

const conf = (pageId: string, rev: string): Conflict => ({
  pageId, kind: 'bothEdited', rev, theirsRev: 't1', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null,
})
const side = (pageId: string, rev: string): Sidecar => ({
  noteId: NID, pageId, rev, seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: two().pages[0]!,
})

async function seed(note: Note, lock?: string) {
  const s = openNoteStore()
  await s.writeNote(note)
  if (lock) await s.recordConflicts(NID, { conflicts: [conf(lock, 'x1')], sidecars: [side(lock, 'x1')] })
  s.close()
}
async function saved(): Promise<Note> {
  const s = openNoteStore()
  const r = await s.loadNote(NID)
  s.close()
  return r!.note!
}
async function mountEditor() {
  act(() =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: createI18n({ navigatorLanguage: 'ko-KR', storage: { getItem: () => null, setItem: () => {} } }) },
        createElement(NoteEditor, { noteId: NID, openStore }),
      ),
    ),
  )
  await flush()
}
const strokes = (n: Note, id = PA) => n.pages.find((p) => p.id === id)!.elements as Stroke[]

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  location.hash = ''
  fills = 0
  clearSessionHistories()
})
afterEach(async () => {
  act(() => root.unmount())
  await savesSettled()
  host.remove()
  stores.forEach((s) => s.close())
  stores = []
  await deleteNoteDatabase()
})

describe('History: a locked page', () => {
  const ctx = { rev: 'r9', now: '2026-10-12T00:00:00.000Z', editedBy: 'C', lastSeenRemoteSeq: 0 }
  const op = (pageId: string, id: string) => ({ op: 'addStroke', pageId, stroke: stroke(id) })

  test('no op touches it, other pages are fine', () => {
    const h = new History(two())
    h.setLocked([PA])
    expect(h.doOp(op(PA, 's1'), ctx)).toBe('pageReadOnly')
    expect(h.note.pages[0]!.elements).toHaveLength(0)
    expect(h.undoDepth).toBe(0)
    expect(h.doOp(op(PB, 's2'), ctx)).toBeNull()
    expect(h.undoDepth).toBe(1)
  })

  test('undo and redo of a record of a locked page are refused and nothing is popped', () => {
    const h = new History(two())
    expect(h.doOp(op(PA, 's1'), ctx)).toBeNull()
    h.lockPages([PA])
    expect(h.undo(ctx)).toBe('pageReadOnly')
    expect(h.undoDepth).toBe(1)
    expect(h.note.pages[0]!.elements).toHaveLength(1)
    h.setLocked([])
    expect(h.undo(ctx)).toBeNull()
    h.lockPages([PA])
    expect(h.redo(ctx)).toBe('pageReadOnly')
    expect(h.redoDepth).toBe(1)
  })

  test('lockPages only adds; setLocked replaces', () => {
    const h = new History(two())
    h.lockPages([PA])
    h.lockPages([PB])
    expect([h.isLocked(PA), h.isLocked(PB)]).toEqual([true, true])
    h.setLocked([PB])
    expect([h.isLocked(PA), h.isLocked(PB)]).toEqual([false, true])
  })
})

describe('writing on a locked page', () => {
  test.each(['pen', 'mouse', 'touch'])('%s: no stroke is made, the attempt is announced assertively, the note is untouched', async (type) => {
    await seed(two(), PA)
    await mountEditor()
    draw(100, 100, type)
    await flush()
    expect((await saved()).pages[0]!.elements).toHaveLength(0)
    expect(alertText()).toBe('읽기 전용 페이지예요')
    expect(q('[role="alert"]')!.getAttribute('role')).toBe('alert')
  })

  test('a press outside the page is not a write attempt', async () => {
    await seed(two(), PA)
    await mountEditor()
    fire('pointerdown', { x: 700, y: 100 })
    fire('pointerup', { x: 700, y: 100 })
    expect(alertText()).toBe('')
  })

  test('Ctrl+Z and Ctrl+Y on the locked page: nothing is undone, the attempt is announced; the undo buttons are disabled', async () => {
    const note = two()
    const h = sessionHistory(note)
    expect(h.doOp({ op: 'addStroke', pageId: PA, stroke: stroke('s1') }, { rev: 'r9', now: '2026-10-12T00:00:00.000Z', editedBy: 'C', lastSeenRemoteSeq: 0 })).toBeNull()
    await seed(h.note, PA)
    await mountEditor()
    expect(q('button[aria-label="실행 취소"]')!.getAttribute('aria-disabled')).toBe('true')
    ctrl('z')
    await flush()
    expect(alertText()).toBe('읽기 전용 페이지예요')
    expect(strokes(await saved())).toHaveLength(1)
    ctrl('y')
    await flush()
    expect(strokes(await saved())).toHaveLength(1)
  })

  test('another page being locked does not stop this one: strokes, undo and redo work', async () => {
    await seed(two(), PB)
    await mountEditor()
    draw()
    await flush()
    expect(strokes(await saved())).toHaveLength(1)
    ctrl('z')
    await flush()
    expect(strokes(await saved())).toHaveLength(0)
    ctrl('y')
    await flush()
    expect(strokes(await saved())).toHaveLength(1)
    expect(alertText()).toBe('')
  })

  test('the canvas description names the read-only conflict page; an editable page has only the usual words', async () => {
    await seed(two(), PA)
    await mountEditor()
    const desc = () => document.getElementById(canvas().getAttribute('aria-describedby')!)!.textContent
    expect(desc()).toBe('손글씨. 읽기 전용, 두 기기에서 고친 페이지')
    act(() => root.unmount())
    root = createRoot(host)
    await deleteNoteDatabase()
    await seed(two(), PB)
    await mountEditor()
    expect(desc()).toBe('손글씨')
  })

  test('blocked attempts are announced at most once a second', async () => {
    await seed(two(), PA)
    await mountEditor()
    draw()
    const first = q('[role="alert"]')
    draw(120, 120)
    expect(q('[role="alert"]')).toBe(first) // not replaced: no second announcement inside the gap
  })
})

describe('a conflict found while the editor is open', () => {
  const merger = (store: NoteStore) =>
    createMergeIo({ store, editedBy: () => 'C', now: () => '2026-10-12T04:20:00.000Z', newId: () => crypto.randomUUID() })
  const resize = () => act(() => void globalThis.dispatchEvent(new Event('resize')))

  test('an idle page is replaced by the remote one at once and is read-only from then on', async () => {
    const note = two()
    await seed(note)
    await mountEditor()
    draw()
    await flush()
    const store = openStore()
    const out = await merger(store).merge({ noteId: NID, base: two(), remote: foreignEdit(two(), PA, 'a3') })
    await flush()
    expect(out).toMatchObject({ result: 'merged', conflicts: [expect.any(String)] })
    fills = 0
    resize()
    expect(fills).toBe(1) // the remote page (one stroke) is what is drawn
    expect((await saved()).pages[0]!.rev).toBe('a3')
    draw(200, 200)
    await flush()
    expect(strokes(await saved())).toHaveLength(1) // still the remote page's one stroke
    expect(alertText()).toBe('읽기 전용 페이지예요')
    const info = (await store.readSync(NID)).info
    expect(info.conflicts).toHaveLength(1)
    expect(info.unsentSidecars).toHaveLength(1)
  })

  test('a stroke in progress is received to its end first; it is in the sidecar; the screen keeps this device version', async () => {
    await seed(two())
    await mountEditor()
    draw() // this device edited page A (one stroke)
    await flush()
    fire('pointerdown', { x: 200, y: 200 }) // ... and is writing another one right now
    fire('pointermove', { x: 210, y: 200 })
    const store = openStore()
    let done = false
    const merged = merger(store).merge({ noteId: NID, base: two(), remote: foreignEdit(two(), PA, 'a3') }).then((r) => ((done = true), r))
    await settle()
    expect(done).toBe(false) // waits for the pointer
    expect((await store.readSync(NID)).info.conflicts).toEqual([]) // nothing is decided yet
    fire('pointerup', { x: 220, y: 200 })
    const out = await merged
    await flush()
    expect(done).toBe(true)
    const rev = (out as { conflicts: string[] }).conflicts[0]!
    const sc = await store.sidecars.get(NID, PA, rev)
    expect(sc!.page.elements).toHaveLength(2) // the stroke that was in progress is part of this device version
    // The screen still shows this device's page (two strokes); what is stored is the Drive page (one stroke).
    fills = 0
    resize()
    expect(fills).toBe(2)
    expect((await saved()).pages[0]!.rev).toBe('a3')
    expect(strokes(await saved())).toHaveLength(1)
    // read-only from now on
    draw(300, 300)
    await flush()
    expect(strokes(await saved())).toHaveLength(1)
    expect(alertText()).toBe('읽기 전용 페이지예요')
    // leaving shows the Drive version
    act(() => root.unmount())
    await savesSettled()
    root = createRoot(host)
    fills = 0
    await mountEditor()
    expect(fills).toBe(1)
  })

  test('a merge without a conflict does not wait for a stroke in progress', async () => {
    await seed(two())
    await mountEditor()
    fire('pointerdown', { x: 200, y: 200 })
    const store = openStore()
    // no conflict: only page B changed on the other device; the merge goes through at once
    const out = await merger(store).merge({ noteId: NID, base: two(), remote: foreignEdit(two(), PB, 'b3') })
    // (it waited for the stroke only when a conflict made the wait necessary: here there is none to protect)
    expect(out).toEqual({ result: 'merged' })
    fire('pointerup', { x: 210, y: 200 })
    await flush()
    expect(strokes(await saved())).toHaveLength(1)
  })
})

describe('strokeEnd', () => {
  test('idle: resolves at once with null', async () => {
    await seed(two())
    await mountEditor()
    expect(await getOpenNote(NID)!.strokeEnd!()).toBeNull()
  })

  test('a cancelled pointer ends the stroke too, with the stroke in', async () => {
    await seed(two())
    await mountEditor()
    fire('pointerdown', { x: 100, y: 100 })
    fire('pointermove', { x: 110, y: 100 })
    let page: string | null | undefined
    void getOpenNote(NID)!.strokeEnd!().then((p) => (page = p))
    await settle()
    expect(page).toBeUndefined()
    fire('pointercancel', { x: 110, y: 100 })
    await settle()
    expect(page).toBe(PA)
    expect(getOpenNote(NID)!.current().pages[0]!.elements).toHaveLength(1)
  })

  test('leaving the editor in the middle of a stroke releases the wait', async () => {
    await seed(two())
    await mountEditor()
    fire('pointerdown', { x: 100, y: 100 })
    const wait = getOpenNote(NID)!.strokeEnd!()
    act(() => root.unmount())
    expect(await wait).toBe(PA)
    root = createRoot(host)
  })

  test('a second finger turns the stroke into a gesture: the wait ends with null, nothing was added', async () => {
    await seed(two())
    await mountEditor()
    fire('pointerdown', { x: 100, y: 100, type: 'touch', id: 1 })
    const wait = getOpenNote(NID)!.strokeEnd!()
    fire('pointerdown', { x: 200, y: 200, type: 'touch', id: 2 })
    expect(await wait).toBeNull()
    expect(getOpenNote(NID)!.current().pages[0]!.elements).toHaveLength(0)
  })
})

describe('Writer.applyMerge with a recorded preview', () => {
  const base = () => two()
  const local = () => {
    const h = new History(base())
    h.doOp({ op: 'addStroke', pageId: PA, stroke: stroke('s1') }, { rev: 'a2', now: '2026-10-12T00:00:00.000Z', editedBy: 'C', lastSeenRemoteSeq: 0 })
    return h
  }
  const ctx = { now: '2026-10-12T04:20:00.000Z', orderRev: 'o9', rev: 'r9', editedBy: 'C', lastSeenRemoteSeq: 0 }
  const mkWriter = (h: History) => new Writer(h, { writeNote: async () => {}, close: () => {} } as never, () => ({}) as never, () => {}, () => 'C')

  test('applies exactly the recorded sidecars: the conflict page is taken from the remote and locked', () => {
    const h = local()
    const w = mkWriter(h)
    const before = structuredClone(h.note)
    const r = w.applyMerge({ base: base(), localAtStart: before, remote: foreignEdit(base(), PA, 'a3'), ctx, expect: [`${PA}:a2`] })
    expect(r.result).toBe('merged')
    expect(h.note.pages[0]!.rev).toBe('a3')
    expect(h.isLocked(PA)).toBe(true)
    expect(h.isLocked(PB)).toBe(false)
    expect(h.undoDepth).toBe(0) // the undo record of the replaced page is gone
    expect(w.pageLocked).toBe(true)
  })

  test('a sidecar that was not recorded (the page changed meanwhile): stale, nothing applied, nothing locked', () => {
    const h = local()
    const w = mkWriter(h)
    const before = structuredClone(h.note)
    const r = w.applyMerge({ base: base(), localAtStart: before, remote: foreignEdit(base(), PA, 'a3'), ctx, expect: [`${PA}:other`] })
    expect(r).toEqual({ result: 'stale' })
    expect(h.note).toEqual(before)
    expect(h.isLocked(PA)).toBe(false)
  })

  test('a stroke has begun: stale', () => {
    const h = local()
    const w = mkWriter(h)
    ;(w as unknown as { drawing: unknown }).drawing = { id: 1, strokeId: 's', type: 'pen', t0: 0, points: [], pageId: PA }
    const r = w.applyMerge({ base: base(), localAtStart: structuredClone(h.note), remote: foreignEdit(base(), PA, 'a3'), ctx, expect: [`${PA}:a2`] })
    expect(r).toEqual({ result: 'stale' })
    expect(h.note.pages[0]!.rev).toBe('a2')
  })

  test('held: the page of the stroke that ended stays on screen only when it is a conflict page', () => {
    const h1 = local()
    const w1 = mkWriter(h1)
    w1.applyMerge({ base: base(), localAtStart: structuredClone(h1.note), remote: foreignEdit(base(), PA, 'a3'), ctx, expect: [`${PA}:a2`], held: PA })
    expect((w1 as unknown as { held: { rev: string } | null }).held?.rev).toBe('a2')
    const h2 = local()
    const w2 = mkWriter(h2)
    w2.applyMerge({ base: base(), localAtStart: structuredClone(h2.note), remote: foreignEdit(base(), PA, 'a3'), ctx, expect: [`${PA}:a2`], held: PB })
    expect((w2 as unknown as { held: unknown }).held).toBeNull()
    const h3 = local()
    const w3 = mkWriter(h3)
    w3.applyMerge({ base: base(), localAtStart: structuredClone(h3.note), remote: foreignEdit(base(), PA, 'a3'), ctx, expect: [`${PA}:a2`], held: null })
    expect((w3 as unknown as { held: unknown }).held).toBeNull()
  })

  test('without `expect` nothing is checked (an ordinary merge)', () => {
    const h = local()
    const w = mkWriter(h)
    const r = w.applyMerge({ base: base(), localAtStart: structuredClone(h.note), remote: foreignEdit(base(), PB, 'b3'), ctx })
    expect(r.result).toBe('merged')
    expect(h.isLocked(PA)).toBe(false)
  })
})
