// @vitest-environment jsdom
// Story 33.5: the canvas screen has no page UI and a PNG item; a readOnly note is never written back.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Note } from '../src/model/note'
import { createCanvas } from '../src/ops/ops'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { createPenDetected } from '../src/storage/penDetected'
import { createViewMode } from '../src/storage/viewMode'
import { type Mounted, mountUi } from './syncUiHarness'
import { NID, PA } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const ctxProxy = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? () => {} : undefined), set: () => true })
HTMLCanvasElement.prototype.getContext = (() => ctxProxy) as never
HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} })) as never

let m: Mounted | undefined
let stores: NoteStore[] = []
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))))
const openStore = () => {
  const s = openNoteStore()
  stores.push(s)
  return s
}
beforeEach(() => clearSessionHistories())
afterEach(async () => {
  m?.unmount()
  m = undefined
  await savesSettled()
  stores.forEach((s) => s.close())
  stores = []
  location.hash = ''
  await deleteNoteDatabase()
})

const canvasNote = (kind?: string): Note => {
  const r = createCanvas({ title: 'c', existingTitles: [], width: 400, height: 300, background: 'transparent', noteId: NID, pageId: PA, pageRev: 'r1', metaRev: 'm1', orderRev: 'o1', now: '2026-01-01T00:00:00.000Z', editedBy: 'x' })
  if (!('note' in r)) throw new Error(r.error)
  if (kind) (r.note.meta as { kind?: string }).kind = kind
  return r.note
}
async function mount(note: Note) {
  const s = openNoteStore()
  await s.writeNote(note)
  s.close()
  const st = { getItem: () => null, setItem: () => {} }
  m = mountUi(createElement(NoteEditor, { noteId: NID, openStore, viewModeStore: createViewMode(st), penDetectedStore: createPenDetected(st) }), 'en')
  await settle()
  await settle()
}
const label = (l: string) => m!.q(`[aria-label="${l}"]`)

test('a canvas has no page buttons; the menu offers Export PNG and no Print', async () => {
  await mount(canvasNote())
  expect(m!.q('canvas.editor-canvas')).not.toBeNull()
  expect(label('Pages')).toBeNull()
  expect(m!.q('.add-page-edge')).toBeNull()
  expect(m!.q('.turn-edge')).toBeNull()
  act(() => void label('More')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const items = m!.qa('[role=menuitem]').map((x) => x.textContent)
  expect(items).toContain('Export PNG')
  expect(items).not.toContain('Print')
})

test('an unknown kind is view only: a stroke is not saved', async () => {
  await mount(canvasNote('hologram'))
  const c = m!.q<HTMLCanvasElement>('canvas.editor-canvas')!
  const fire = (n: string, x: number) => act(() => void c.dispatchEvent(new PointerEvent(n, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', clientX: x, clientY: 100, pressure: 0.5, button: 0, buttons: 1 })))
  fire('pointerdown', 50)
  fire('pointermove', 80)
  fire('pointerup', 90)
  await settle()
  await savesSettled()
  const s = openNoteStore()
  const r = await s.loadNote(NID)
  s.close()
  expect(r!.note!.pages[0]!.elements).toHaveLength(0)
})
