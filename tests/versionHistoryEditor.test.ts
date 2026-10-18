// @vitest-environment jsdom
// Story 3.25, the whole flow in the writing screen: ⋯ -> [버전 기록] -> two presses of [이 버전으로 복원] -> the
// current state is uploaded and pinned, the restore goes through the editor's queue, the dialog closes, focus is on
// ⋯, the words are polite, and the restored note goes up. Also: no entry without the feature, the read-only tab,
// a note being received, a stroke in progress, a note with conflicts. Real stores / uploader / restorer over the fake Drive.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import type { Note, Stroke } from '../src/model/note'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { acquireNoteLock } from '../src/storage/noteLock'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { getOpenNote, openNoteIds } from '../src/sync/openNotes'
import { createSyncStatus } from '../src/sync/syncStatus'
import { createUploadCoordinator } from '../src/sync/uploadCoordinator'
import { type Versions, createVersionRestorer, createVersionSource } from '../src/sync/versionHistory'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { fakeLocks } from './helpers'
import { type Mounted, SyncUiProvider, fakeAuth, fakeNet, mountUi } from './syncUiHarness'
import { type Env, NID, PA, PB, bytesOf, foreignEdit, makeEnv, mkNote, withStroke } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {}, set: () => true })) as never
HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({ width: 60, height: 80, top: 0, left: 0, right: 60, bottom: 80, x: 0, y: 0, toJSON() {} })) as never

let m: Mounted | undefined
let env: Env | undefined
let stores: NoteStore[] = []
let status: ReturnType<typeof createSyncStatus> | undefined
let syncs: Promise<unknown>[] = []
const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
async function until(cond: () => boolean | Promise<boolean>, what = 'condition') {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return
    await settle(20)
  }
  throw new Error(`timed out: ${what}`)
}
const openStore = () => {
  const s = openNoteStore()
  stores.push(s)
  return s
}
beforeEach(() => clearSessionHistories())
afterEach(async () => {
  vi.useRealTimers()
  m?.unmount()
  m = undefined
  await settle(60)
  await Promise.allSettled(syncs)
  syncs = []
  status?.dispose()
  status = undefined
  await savesSettled()
  stores.forEach((s) => s.close())
  stores = []
  env?.close()
  env = undefined
  delete (navigator as { locks?: unknown }).locks
  location.hash = ''
  await deleteNoteDatabase()
})

const two = () => mkNote({ title: '필기', pages: { [PA]: 'a1', [PB]: 'b1' } })
const REV2 = '01926f3a-0000-7000-8000-0000000000c2'
const REV3 = '01926f3a-0000-7000-8000-0000000000c3'
const strokesOf = (n: Note, id: string) => (n.pages.find((p) => p.id === id)!.elements as Stroke[]).map((s) => s.id)
const stored = async (): Promise<Note> => {
  const s = openNoteStore()
  const r = await s.loadNote(NID)
  s.close()
  return r!.note!
}

/** rev1 (no strokes) and rev2 (`s-up`, the head) are on Drive; this device has an unsent stroke `s-local` on page A. */
async function withLocalStroke(e: Env) {
  await e.store.writeNote(two())
  await e.uploader.upload(NID)
  const fileId = e.drive.byKkeujeokId(NID)[0]!.id
  const first = e.drive.revisions(fileId)[0]!.id
  const up = withStroke(two(), PA, 'a2', 's-up')
  await e.store.writeNote(up)
  await e.uploader.upload(NID)
  await e.store.writeNote(withStroke(up, PA, 'a3', 's-local'))
  return { fileId, first }
}

async function mountEditor(e: Env, o: { versions?: boolean; lang?: 'ko' | 'en'; receiving?: boolean; probe?: () => Promise<boolean> } = {}) {
  const coordinator = createUploadCoordinator({
    store: e.store,
    uploader: e.uploader,
    log: e.deps.log,
    allowed: e.deps.allowed,
    online: e.deps.online,
    flushOpen: async () => void (await Promise.all(openNoteIds().map((id) => getOpenNote(id)?.flush()))),
    locks: undefined,
  })
  const uploads = Object.assign(Object.create(coordinator) as typeof coordinator, {
    noteClosed: (id: string) => {
      const p = coordinator.noteClosed(id)
      syncs.push(p)
      return p
    },
    syncNow: (id: string) => {
      const p = coordinator.syncNow(id)
      syncs.push(p)
      return p
    },
  })
  const source = createVersionSource(e.drive)
  const versions: Versions = {
    source,
    restorer: createVersionRestorer({ drive: e.drive, store: e.store, coordinator, source, editedBy: () => 'Chrome, Windows' }),
    probe: o.probe ?? (async () => true),
  }
  status = createSyncStatus({ store: e.store })
  await status.refreshAll()
  const receivingNow = { receiving: new Set([NID]) as ReadonlySet<string> }
  const receiver = o.receiving ? { subscribe: () => () => {}, getState: () => receivingNow } : undefined
  m = mountUi(
    createElement(
      SyncUiProvider,
      { auth: fakeAuth() as never, status, net: fakeNet(), receiver: receiver as never, uploads, ...(o.versions !== false && { versions }) },
      createElement(NoteEditor, { noteId: NID, openStore, uploads }),
    ),
    o.lang ?? 'ko',
  )
  await until(() => !!m!.q('canvas.editor-canvas'), 'the editor')
  await settle()
}

const more = () => m!.q<HTMLButtonElement>('button[aria-label="더 보기"], button[aria-label="More"]')!
const menuItem = (text: string) => m!.qa<HTMLButtonElement>('[role="menuitem"]').find((b) => b.textContent === text)
const dlg = () => m!.q('[role="dialog"]')
const items = () => m!.qa('[data-version-item]')
const restoreButtons = () => m!.qa<HTMLButtonElement>('[data-restore]')
const openHistory = async () => {
  more().focus()
  act(() => void more().click())
  act(() => void menuItem('버전 기록')!.click())
  await until(() => !!dlg(), 'the dialog')
  await until(() => items().length > 0 || !!m!.q('.version-message'), 'the list')
}
const key = (k: string) => act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
const polite = () => m!.qa('[role="status"][aria-live="polite"]').map((x) => x.textContent).join('|')

describe('the entry and the dialog', () => {
  test('⋯ has [버전 기록]; it opens the dialog; closing returns focus to ⋯', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e)
    act(() => void more().click())
    expect(menuItem('버전 기록')).toBeTruthy()
    expect(m!.qa('[role="menuitem"]').map((x) => x.getAttribute('aria-label') ?? x.textContent).slice(-3)).toContain('버전 기록')
    act(() => void menuItem('버전 기록')!.click())
    await until(() => !!dlg())
    expect(m!.q('[role="menu"]')).toBeNull()
    await until(() => items().length === 1, 'one older version')
    expect(items()).toHaveLength(1)
    key('Escape')
    await until(() => !dlg(), 'closing')
    await until(() => document.activeElement === more(), 'focus on ⋯')
  })

  test('the menu keys reach the entry (arrows / End)', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e)
    act(() => void more().click())
    const menu = m!.q('[role="menu"]')!
    const last = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].at(-1)!
    expect(last.textContent).toBe('버전 기록')
    last.focus()
    key('Home')
    expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'))
    key('End')
    expect(document.activeElement).toBe(last)
    key('ArrowDown') // wraps to the first
    expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'))
    key('ArrowUp') // and back to the last
    expect(document.activeElement).toBe(last)
  })

  test('without the feature there is no entry', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e, { versions: false })
    act(() => void more().click())
    expect(menuItem('버전 기록')).toBeUndefined()
  })

  test('English entry', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e, { lang: 'en' })
    act(() => void more().click())
    expect(m!.qa('[role="menuitem"]').map((x) => x.textContent)).toContain('Version history')
  })

  test('offline: the dialog says so and makes no Drive call', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e, { probe: async () => false })
    const n = e.drive.calls.length
    await openHistory()
    expect(m!.q('.version-message')!.textContent).toBe('연결되면 버전 기록을 볼 수 있어요.')
    expect(e.drive.calls).toHaveLength(n)
  })
})

describe('restoring', () => {
  test('two presses: the current state is uploaded and pinned, the note changes through the queue, the dialog closes, focus is on ⋯, polite words, and the restore goes up', async () => {
    const e = (env = await makeEnv())
    const { fileId } = await withLocalStroke(e)
    await mountEditor(e)
    expect(strokesOf(await stored(), PA)).toEqual(['s-up', 's-local'])
    await openHistory()
    act(() => void restoreButtons()[0]!.click())
    expect(restoreButtons()[0]!.textContent).toBe('한 번 더 누르면 이 버전으로 바뀌어요')
    act(() => void restoreButtons()[0]!.click())
    await until(() => !dlg(), 'the dialog closing')
    expect(polite()).toContain('이 버전으로 되돌렸어요')
    await until(() => document.activeElement === more(), 'focus on ⋯')
    // the note on screen and on disk is the restored one
    await until(async () => strokesOf(await stored(), PA).length === 0, 'the restored note on disk')
    // the state before the restore (with `s-local`) is its own revision and is pinned; then the restore went up
    await until(() => e.drive.revisions(fileId).length === 4, 'the upload of the restore')
    const revs = e.drive.revisions(fileId)
    expect(revs.map((r) => r.keepForever === true)).toEqual([false, false, true, false])
    expect(e.invalid).toEqual([])
  })

  test('the restored note takes strokes again and undo does not reach back across the restore', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e)
    await openHistory()
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    await until(() => !dlg())
    const undo = m!.q<HTMLElement>('[aria-label="실행 취소"], [aria-label="Undo"]')
    expect(undo?.getAttribute('aria-disabled')).toBe('true')
  })

  test('an unreadable version: the message, the dialog stays, the note is unchanged', async () => {
    const e = (env = await makeEnv())
    const { fileId, first } = await withLocalStroke(e)
    await mountEditor(e)
    await openHistory()
    e.drive.purgeRevision(fileId, first)
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    await until(() => m!.q('[role="alert"].dialog-error')!.textContent !== '', 'the message')
    expect(m!.q('[role="alert"].dialog-error')!.textContent).toBe('이 버전을 읽을 수 없어요.')
    expect(dlg()).not.toBeNull()
    expect(strokesOf(await stored(), PA)).toEqual(['s-up', 's-local'])
  })

  test('the upload of the current state fails: "저장하지 못해서", nothing pinned, nothing restored', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e)
    await openHistory()
    e.drive.failAlways('uploadSimple', new DriveError('http', 403, 'storageQuotaExceeded'))
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    await until(() => m!.q('[role="alert"].dialog-error')!.textContent !== '', 'the message')
    expect(m!.q('[role="alert"].dialog-error')!.textContent).toBe('지금 상태를 Drive에 저장하지 못해서 복원하지 않았어요.')
    expect(e.drive.calls.some((c) => c.startsWith('updateRevision'))).toBe(false)
    expect(strokesOf(await stored(), PA)).toEqual(['s-up', 's-local'])
  })

  test('a stroke in progress: the restore is refused with its words and nothing is called on Drive', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e)
    await openHistory()
    const c = m!.q<HTMLCanvasElement>('canvas.editor-canvas')!
    act(() => void c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', clientX: 30, clientY: 40, pressure: 0.5, buttons: 1 })))
    const n = e.drive.calls.length
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    await until(() => m!.q('[role="alert"].dialog-error')!.textContent !== '', 'the message')
    expect(m!.q('[role="alert"].dialog-error')!.textContent).toBe('쓰는 중에는 복원할 수 없어요. 획을 끝내고 다시 눌러 주세요.')
    expect(e.drive.calls.slice(n).some((x) => x.startsWith('updateRevision') || x.startsWith('uploadSimple'))).toBe(false)
    expect(strokesOf(await stored(), PA)).toEqual(['s-up', 's-local'])
  })
})

describe('a read-only tab and a note being received', () => {
  test('another tab holds the note: the dialog opens but every restore is disabled with the tooltip and calls nothing', async () => {
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true })
    const holder = await acquireNoteLock(NID) // "the other tab"
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    try {
      await mountEditor(e)
      expect(m!.q('[data-banner="otherTab"], .editor-banner')).not.toBeNull()
      await openHistory()
      for (const b of restoreButtons()) {
        expect(b.getAttribute('aria-disabled')).toBe('true')
        expect(b.getAttribute('title')).toBe('읽기 전용이에요')
      }
      const n = e.drive.calls.length
      act(() => void restoreButtons()[0]!.click())
      act(() => void restoreButtons()[0]!.click())
      expect(e.drive.calls.slice(n).filter((x) => x.startsWith('updateRevision') || x.startsWith('uploadSimple'))).toEqual([])
    } finally {
      m?.unmount()
      m = undefined
      await holder.release()
    }
  })

  test('the note is being received: the menu entry is disabled with a reason and opens nothing', async () => {
    const e = (env = await makeEnv())
    await withLocalStroke(e)
    await mountEditor(e, { receiving: true })
    act(() => void more().click())
    const item = menuItem('버전 기록')!
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.getAttribute('title')).toBe('최신 내용 받는 중')
    const n = e.drive.calls.length
    act(() => void item.click())
    expect(dlg()).toBeNull()
    expect(e.drive.calls).toHaveLength(n)
  })
})

describe('a note with conflicts', () => {
  test('a whole-note restore settles the conflicts: record resolved, the page unlocked, the banner gone', async () => {
    const e = (env = await makeEnv())
    await e.store.writeNote(two())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    e.drive.foreignRevision(fileId, await bytesOf(foreignEdit(two(), PA, REV3)))
    await e.store.writeNote(withStroke(two(), PA, REV2, 's-mine'))
    await e.uploader.upload(NID)
    expect((await e.sync()).info.state).toBe('conflict')
    await mountEditor(e)
    expect(m!.q('[data-banner="conflictReadOnly"]')).not.toBeNull()
    await openHistory()
    // the oldest version is the one before both edits
    act(() => void restoreButtons().at(-1)!.click())
    act(() => void restoreButtons().at(-1)!.click())
    await until(() => !dlg(), 'the dialog closing')
    await until(async () => (await e.sync()).info.conflicts.every((c) => c.resolvedAt != null), 'the conflicts resolved')
    await until(() => !m!.q('[data-banner="conflictReadOnly"]'), 'the banner leaving')
    // the page takes strokes again
    const c = m!.q<HTMLCanvasElement>('canvas.editor-canvas')!
    const ev = (n: string, dx: number) =>
      act(() => void c.dispatchEvent(new PointerEvent(n, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', clientX: 20 + dx, clientY: 20, pressure: 0.5, buttons: 1 })))
    ev('pointerdown', 0)
    ev('pointermove', 5)
    ev('pointerup', 10)
    await until(async () => strokesOf(await stored(), PA).length === 1, 'the new stroke')
  })
})
