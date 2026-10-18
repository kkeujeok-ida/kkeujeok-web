// @vitest-environment jsdom
// Story 3.22, the whole flow in the writing screen: [해결하기] / a card opens the dialog, a choice goes through the
// editor's queue, the page is unlocked, the sync record and the state follow in one write, the resolve is uploaded,
// the Drive sidecar is marked. Real stores, real uploader and coordinator over the fake Drive.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { v5 } from 'uuid'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { decodeKkj } from '../src/model/kkjCodec'
import type { Note, Stroke } from '../src/model/note'
import { History } from '../src/ops/history'
import { PAGE_ID_NAMESPACE } from '../src/ops/resolveConflict'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { getOpenNote, openNoteIds } from '../src/sync/openNotes'
import { createSyncStatus } from '../src/sync/syncStatus'
import { createUploadCoordinator } from '../src/sync/uploadCoordinator'
import { App } from '../src/ui/App'
import { Library } from '../src/ui/library/Library'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Writer } from '../src/ui/library/writer'
import { requestResolve, takeResolveRequest } from '../src/ui/library/resolveRequest'
import { type Mounted, SyncUiProvider, fakeAuth, fakeNet, fakeStatus, mountUi, view } from './syncUiHarness'
import { signedIn } from './helpers'
import { type Env, NID, PA, PB, bytesOf, foreignEdit, makeEnv, mkNote, stroke, withStroke } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {}, set: () => true })) as never

let m: Mounted | undefined
let env: Env | undefined
let stores: NoteStore[] = []
let status: ReturnType<typeof createSyncStatus> | undefined
// The uploads the editor started in the background: a test is over only when they are (they share the database).
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
  await settle(60) // the closing upload starts after the last save
  await Promise.allSettled(syncs)
  syncs = []
  status?.dispose()
  status = undefined
  await savesSettled()
  stores.forEach((s) => s.close())
  stores = []
  env?.close()
  env = undefined
  location.hash = ''
  await deleteNoteDatabase()
})

const NOW_ = '2026-10-13T00:00:00.000Z'
const two = () => mkNote({ title: '필기', pages: { [PA]: 'a1', [PB]: 'b1' } })
const kid = (pageId: string, rev: string) => `sc:${NID}:${pageId}:${rev}`
const oneFile = (e: Env, id: string) => {
  const found = e.drive.byKkeujeokId(id)
  expect(found).toHaveLength(1)
  return found[0]!
}
const strokesOf = (n: Note, id: string) => n.pages.find((p) => p.id === id)!.elements as Stroke[]

/** Both devices edited page A (this one: stroke `mine`; the other: `a3`). Uploaded: the note holds the remote A, state `conflict`. */
async function twoDevices(e: Env, kind: 'edit' | 'twoPages' | 'remoteDeleted' = 'edit') {
  await e.store.writeNote(two())
  await e.uploader.upload(NID)
  const id = oneFile(e, NID).id
  if (kind === 'remoteDeleted') {
    const remote = two()
    remote.pages = remote.pages.filter((p) => p.id !== PB)
    remote.orderRev = 'o2'
    e.drive.foreignRevision(id, await bytesOf(remote))
    await e.store.writeNote(withStroke(two(), PB, 'b2'))
  } else if (kind === 'twoPages') {
    e.drive.foreignRevision(id, await bytesOf(foreignEdit(foreignEdit(two(), PA, 'a3'), PB, 'b3')))
    await e.store.writeNote(withStroke(withStroke(two(), PA, 'a2'), PB, 'b2'))
  } else {
    e.drive.foreignRevision(id, await bytesOf(foreignEdit(two(), PA, 'a3')))
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
  }
  expect(await e.uploader.upload(NID)).toBe('uploaded')
  expect((await e.sync()).info.state).toBe('conflict')
  return id
}

type Wrap = { conflictResolved?: (noteId: string, c: Record<string, unknown>) => Promise<unknown> }
async function mountEditor(e: Env, o: { noUploads?: boolean; lang?: 'ko' | 'en'; wrap?: (real: NonNullable<Wrap['conflictResolved']>) => NonNullable<Wrap['conflictResolved']> } = {}) {
  const coordinator = createUploadCoordinator({
    store: e.store,
    uploader: e.uploader,
    log: e.deps.log,
    allowed: e.deps.allowed,
    online: e.deps.online,
    flushOpen: async () => void (await Promise.all(openNoteIds().map((id) => getOpenNote(id)?.flush()))),
    locks: undefined,
  })
  const real = (noteId: string, c: Record<string, unknown>) => coordinator.conflictResolved(noteId, c)
  const uploads = Object.assign(Object.create(coordinator) as typeof coordinator, {
    conflictResolved: o.wrap ? o.wrap(real) : real,
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
  status = createSyncStatus({ store: e.store })
  await status.refreshAll()
  m = mountUi(
    createElement(
      SyncUiProvider,
      { auth: fakeAuth() as never, status, net: fakeNet(), receiver: undefined, uploads, resolve: requestResolve },
      createElement(NoteEditor, { noteId: NID, openStore, ...(!o.noUploads && { uploads }) }),
    ),
    o.lang ?? 'ko',
  )
  await until(() => !!m!.q('canvas.editor-canvas'), 'the editor')
  await settle()
  return { coordinator }
}

const dialog = () => m!.q('[role="dialog"]')
const buttons = () => m!.qa<HTMLButtonElement>('[role="dialog"] button')
const press = (text: string) => act(() => void buttons().find((b) => b.textContent === text)!.click())
const banner = () => m!.q('[data-banner]')
const canvasEl = () => m!.q<HTMLCanvasElement>('canvas.editor-canvas')!
const openFromBanner = async () => {
  const b = m!.q<HTMLButtonElement>('[data-banner] button')!
  b.focus() // a click focuses the button in a browser
  act(() => void b.click())
  await until(() => !!dialog(), 'the dialog')
}
const draw = (x = 100, y = 100) => {
  const ev = (n: string, dx: number) =>
    act(() => void canvasEl().dispatchEvent(new PointerEvent(n, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', clientX: x + dx, clientY: y, pressure: 0.5, buttons: 1 })))
  ev('pointerdown', 0)
  ev('pointermove', 10)
  ev('pointerup', 20)
}
const stored = async (): Promise<Note> => {
  const s = openNoteStore()
  const r = await s.loadNote(NID)
  s.close()
  return r!.note!
}
const polite = () => m!.qa('[role="status"][aria-live="polite"]').map((x) => x.textContent).join('|')
const alerts = () => m!.qa('[role="alert"]').map((e) => e.textContent).filter(Boolean)

describe('opening', () => {
  test('[해결하기] opens the dialog over this note; the page is read-only until a choice', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await mountEditor(e)
    expect(banner()!.getAttribute('data-banner')).toBe('conflictReadOnly')
    await openFromBanner()
    expect(m!.q('.dialog-title')!.textContent).toBe('두 기기에서 고친 페이지가 있어요')
    expect(m!.qa('canvas[aria-label]').map((c) => c.getAttribute('aria-label')).filter((l) => l!.includes('버전'))).toEqual(['1페이지 이 기기 버전', '1페이지 다른 기기 버전'])
    expect(document.activeElement).toBe(buttons().find((b) => b.textContent === '둘 다 남기기'))
    draw()
    await settle()
    expect(strokesOf(await stored(), PA)).toHaveLength(1) // only the other device's stroke: nothing written on the locked page
  })

  test('a card of a conflicted note opens the editor with the dialog already up', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    requestResolve(NID) // the card click
    await mountEditor(e)
    await until(() => !!dialog(), 'the dialog')
  })

  test('the dialog keeps the sidecar readable after it was uploaded: the left preview is this device even then', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    expect(oneFile(e, kid(PA, 'a2'))).toBeTruthy() // on Drive already
    await mountEditor(e)
    await openFromBanner()
    expect(m!.q('[data-side="this"] canvas')).not.toBeNull()
  })

  test('a conflict whose sidecar record is gone is skipped; none left: an error message, no dialog (no silent dead end)', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await e.store.sidecars.delete(NID, PA, 'a2')
    await mountEditor(e)
    act(() => void m!.q<HTMLButtonElement>('[data-banner] button')!.click())
    await until(() => alerts().length > 0, 'the error')
    expect(alerts()).toEqual(['정하지 못했어요. 다시 시도해 주세요.'])
    expect(dialog()).toBeNull()
  })

  test('another conflict page is still usable when one sidecar is missing', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e, 'twoPages')
    const s = await e.sync()
    expect(s.info.conflicts).toHaveLength(2)
    await e.store.sidecars.delete(NID, PA, 'a2')
    await mountEditor(e)
    await openFromBanner()
    expect(m!.q('.conflict-progress span')!.textContent).toBe('2페이지 · 1/1')
  })
})

describe('choosing', () => {
  test('this device version: the page is replaced, unlocked, undo cleared, the entry resolved, state pending, the resolve uploaded, the Drive sidecar marked, polite words, dialog closed, focus on the canvas', async () => {
    const e = (env = await makeEnv())
    const fileId = await twoDevices(e)
    await mountEditor(e)
    await openFromBanner()
    press('이 기기 버전')
    await until(() => !dialog(), 'the dialog closing')
    expect(document.activeElement).toBe(canvasEl())
    expect(polite()).toContain('1페이지: 이 기기 버전을 남겼어요')

    await until(async () => (await e.sync()).info.conflicts[0]?.sidecarMarked === true, 'the marked sidecar')
    const s = await e.sync()
    expect(s.info.conflicts[0]).toMatchObject({ pageId: PA, rev: 'a2', sidecarMarked: true })
    expect(typeof s.info.conflicts[0]!.resolvedAt).toBe('string')
    expect(s.info.state).toBe('synced') // uploaded and verified
    // the page now holds this device's stroke (new rev), and that is what Drive has
    const page = (await stored()).pages.find((p) => p.id === PA)!
    expect(page.rev).not.toBe('a3')
    expect(page.elements).toHaveLength(1)
    const head = (await decodeKkj(e.drive.revisions(fileId).at(-1)!.bytes)).note!
    expect(head.pages.find((p) => p.id === PA)!.rev).toBe(page.rev)
    expect(oneFile(e, kid(PA, 'a2')).appProperties.kkjResolved).toBe(s.info.conflicts[0]!.resolvedAt)
    expect(await e.store.sidecars.get(NID, PA, 'a2')).toBeNull() // marked: the local record goes
    // the banner is gone and the page takes strokes again
    await until(() => banner()?.getAttribute('data-banner') !== 'conflictReadOnly', 'the banner leaving')
    draw()
    await until(async () => strokesOf(await stored(), PA).length === 2, 'the new stroke')
    expect(e.invalid).toEqual([])
  })

  test('the other device version keeps the remote page with a new revision', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await mountEditor(e)
    await openFromBanner()
    press('다른 기기 버전')
    await until(() => !dialog(), 'the dialog closing')
    expect(polite()).toContain('1페이지: 다른 기기 버전을 남겼어요')
    const page = (await stored()).pages.find((p) => p.id === PA)!
    expect(page.rev).not.toBe('a3')
    expect(page.lineage).toContain('a3')
    expect(page.elements).toHaveLength(1)
    expect((page.elements as Stroke[])[0]!.id).not.toBe('s1')
  })

  test('keep both: this device version at the original index, the other right after (UUIDv5 id); the editor shows both pages', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await mountEditor(e)
    await openFromBanner()
    press('둘 다 남기기')
    await until(() => !dialog(), 'the dialog closing')
    expect(polite()).toContain('1페이지: 둘 다 남겼어요')
    const note = await stored()
    expect(note.pages).toHaveLength(3)
    const ids = note.pages.map((p) => p.id)
    const lo = note.pages.find((p) => p.rev === 'a2' || p.rev === 'a3')!
    // whichever has the greater rev keeps the id, the other gets the UUIDv5 of `<pageId>:<lo.rev>`
    expect(ids).toContain(v5(`${PA}:${lo.rev === 'a2' ? 'a2' : 'a3'}`, PAGE_ID_NAMESPACE))
    expect(note.pages.slice(0, 2).map((p) => p.rev).sort()).toEqual(['a2', 'a3'])
    expect(note.pages[2]!.id).toBe(PB)
    // all pages are in the editor, named, one of them current
    expect(m!.qa('ul.sr-only li').map((x) => x.textContent)).toEqual(['1페이지 / 3, 세로', '2페이지 / 3, 세로', '3페이지 / 3, 세로'])
    expect(m!.qa('ul.sr-only li[aria-current="page"]')).toHaveLength(1)
    await until(async () => (await e.sync()).info.conflicts[0]?.sidecarMarked === true, 'the marked sidecar')
    const head = (await decodeKkj(e.drive.revisions(oneFile(e, NID).id).at(-1)!.bytes)).note!
    expect(head.pages).toHaveLength(3)
  })

  test('the pages are unlocked from the record as committed: the other conflict page stays read-only', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e, 'twoPages')
    await mountEditor(e)
    await openFromBanner()
    press('이 기기 버전') // page 1 only
    await until(() => m!.q('.conflict-progress span')?.textContent === '2페이지 · 1/1', 'the next page')
    expect(dialog()).not.toBeNull()
    expect(banner()!.getAttribute('data-banner')).toBe('conflictReadOnly')
    act(() => void m!.q<HTMLButtonElement>('button.conflict-later')!.click())
    expect(dialog()).toBeNull()
    draw() // page 1 is free again
    await until(async () => strokesOf(await stored(), PA).length === 2, 'a stroke on the resolved page')
  })
})

describe('a page the other device deleted', () => {
  test('keep: the page comes back at its place, with this device version', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e, 'remoteDeleted')
    expect((await stored()).pages.map((p) => p.id)).toEqual([PA])
    await mountEditor(e)
    expect(banner()!.querySelector('.editor-banner-text')!.textContent).toContain('지운 페이지')
    await openFromBanner()
    expect(m!.q('.conflict-deleted')!.textContent).toBe('다른 기기에서 지운 페이지')
    expect(document.activeElement).toBe(buttons().find((b) => b.textContent === '이 버전 남기기'))
    press('이 버전 남기기')
    await until(() => !dialog(), 'the dialog closing')
    expect(polite()).toContain('2페이지: 남겼어요')
    expect((await stored()).pages.map((p) => p.id)).toEqual([PA, PB])
    expect(strokesOf(await stored(), PB)).toHaveLength(1)
    await until(async () => (await e.sync()).info.state === 'synced', 'the upload')
  })

  test('remove: the note stays as it is, nothing to send, state synced', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e, 'remoteDeleted')
    await mountEditor(e)
    await openFromBanner()
    press('페이지 지우기')
    await until(() => !dialog(), 'the dialog closing')
    expect(polite()).toContain('2페이지: 지웠어요')
    expect((await stored()).pages.map((p) => p.id)).toEqual([PA])
    await until(async () => (await e.sync()).info.state === 'synced', 'synced')
    await until(async () => (await e.sync()).info.conflicts[0]?.sidecarMarked === true, 'the marked sidecar')
  })
})

describe('rest of the conflicts', () => {
  test('two steps in place, then every remaining conflict is settled', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e, 'twoPages')
    await mountEditor(e)
    await openFromBanner()
    press('나머지 모두 이 기기 버전')
    expect(dialog()).not.toBeNull()
    expect((await e.sync()).info.conflicts.every((c) => c.resolvedAt == null)).toBe(true)
    press('한 번 더 누르면 2페이지에 적용돼요')
    await until(() => !dialog(), 'the dialog closing')
    expect(polite()).toContain('2페이지를 정했어요')
    const s = await e.sync()
    expect(s.info.conflicts.every((c) => typeof c.resolvedAt === 'string')).toBe(true)
    const note = await stored()
    expect(note.pages.every((p) => (p.elements as Stroke[]).length === 1)).toBe(true)
    await until(() => !banner() || banner()!.getAttribute('data-banner') !== 'conflictReadOnly', 'the banner leaving')
  })
})

describe('later', () => {
  test('[나중에 결정] and Esc close without a change; the lock, the banner and the badge stay; focus goes back to [해결하기]', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await mountEditor(e)
    const before = await e.sync()
    await openFromBanner()
    press('나중에 결정')
    expect(dialog()).toBeNull()
    await settle()
    expect(document.activeElement).toBe(m!.q('[data-banner] button'))
    await openFromBanner()
    act(() => void dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(dialog()).toBeNull()
    expect((await e.sync()).info).toEqual(before.info)
    expect(banner()!.getAttribute('data-banner')).toBe('conflictReadOnly')
    expect(m!.q('.sync-indicator-button')!.classList.contains('sync-twoVersions')).toBe(true)
    // it opens again every time
    await openFromBanner()
  })

  test('Ctrl+Z is ignored while the dialog is open', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await mountEditor(e)
    await openFromBanner()
    const ev = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => void document.dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('when the sync record cannot be written', () => {
  test('a sync-state failure never unlocks: the pages stay read-only, the dialog says so, and the note was resolved once', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    const calls = vi.fn()
    await mountEditor(e, {
      wrap: () => async () => {
        calls()
        throw new Error('sync.json unreadable')
      },
    })
    await openFromBanner()
    press('이 기기 버전')
    await until(() => alerts().length > 0, 'the error')
    expect(calls).toHaveBeenCalledTimes(2) // once, then once more
    expect(dialog()).not.toBeNull()
    expect(alerts()).toContain('정하지 못했어요. 다시 시도해 주세요.')
    expect((await e.sync()).info.conflicts[0]!.resolvedAt).toBeNull()
    expect(banner()!.getAttribute('data-banner')).toBe('conflictReadOnly')
    act(() => void m!.q<HTMLButtonElement>('button.conflict-later')!.click())
    draw()
    await settle()
    // still locked: no stroke landed on the page (it holds this device's one stroke from the resolve)
    expect(strokesOf(await stored(), PA)).toHaveLength(1)
  })

  test('a sync record that cannot be read while the banner shows a conflict: an error message, no dialog, nothing unlocked', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await mountEditor(e)
    const ndb = (await import('../src/storage/noteDb')).openNoteDb()
    await ndb.withDb((db) => db.put('sync', { state: 'bogus' }, NID))
    ndb.close()
    act(() => void m!.q<HTMLButtonElement>('[data-banner] button')!.click())
    await until(() => alerts().length > 0, 'the error')
    expect(alerts()).toEqual(['정하지 못했어요. 다시 시도해 주세요.'])
    expect(dialog()).toBeNull()
    draw()
    await settle()
    expect(strokesOf(await stored(), PA)).toHaveLength(1) // still read-only
  })

  test('two conflicts, the record fails for the second page only: the dialog keeps exactly that page, page 1 is recorded and free, page 2 stays read-only', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e, 'twoPages')
    await mountEditor(e, { wrap: (real) => async (id, c) => (c.pageId === PB ? Promise.reject(new Error('down')) : real(id, c)) })
    await openFromBanner()
    press('나머지 모두 이 기기 버전')
    press('한 번 더 누르면 2페이지에 적용돼요')
    await until(() => alerts().length > 0, 'the error')
    expect(dialog()).not.toBeNull()
    expect(m!.q('.conflict-progress span')!.textContent).toBe('2페이지 · 1/1')
    expect(alerts()).toContain('정하지 못했어요. 다시 시도해 주세요.')
    const s = await e.sync()
    expect(s.info.conflicts.find((c) => c.pageId === PA)!.resolvedAt).not.toBeNull()
    expect(s.info.conflicts.find((c) => c.pageId === PB)!.resolvedAt).toBeNull()
    act(() => void m!.q<HTMLButtonElement>('button.conflict-later')!.click())
    draw(100, 100)
    draw(100, 842 + 16 + 100)
    await until(async () => strokesOf(await stored(), PA).length === 2, 'a stroke on page 1')
    expect(strokesOf(await stored(), PB)).toHaveLength(1)
  })

  test('without a coordinator nothing is applied: the note is untouched and the dialog says so', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    await mountEditor(e, { noUploads: true })
    await openFromBanner()
    press('이 기기 버전')
    await until(() => alerts().length > 0, 'the error')
    expect(dialog()).not.toBeNull()
    await settle()
    expect((await stored()).pages.find((p) => p.id === PA)!.rev).toBe('a3')
  })

  test('the first write succeeded and then threw: the retry finds the entry resolved and that counts', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    let n = 0
    await mountEditor(e, {
      wrap: (real) => async (id, c) => {
        n++
        const r = await real(id, c)
        if (n === 1) throw new Error('threw after the write')
        return r
      },
    })
    await openFromBanner()
    press('이 기기 버전')
    await until(() => !dialog(), 'the dialog closing')
    expect((await e.sync()).info.conflicts[0]!.resolvedAt).not.toBeNull()
    draw()
    await until(async () => strokesOf(await stored(), PA).length === 2, 'a stroke on the unlocked page')
  })

  test('the first try fails, the retry works: settled in one press', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    let n = 0
    await mountEditor(e, { wrap: (real) => async (id, c) => (++n === 1 ? Promise.reject(new Error('once')) : real(id, c)) })
    await openFromBanner()
    press('이 기기 버전')
    await until(() => !dialog(), 'the dialog closing')
    expect(n).toBe(2)
    expect((await e.sync()).info.conflicts[0]!.resolvedAt).not.toBeNull()
  })

  test('failed twice, then a later press only writes sync.json again: keep-both does not add a second page', async () => {
    const e = (env = await makeEnv())
    await twoDevices(e)
    let n = 0
    await mountEditor(e, { wrap: (real) => async (id, c) => (++n <= 2 ? Promise.reject(new Error('down')) : real(id, c)) })
    await openFromBanner()
    press('둘 다 남기기')
    await until(() => alerts().length > 0, 'the error')
    expect((await stored()).pages).toHaveLength(3) // applied once
    press('둘 다 남기기')
    await until(() => !dialog(), 'the dialog closing')
    expect(n).toBe(3)
    expect((await stored()).pages).toHaveLength(3) // never twice
    expect((await e.sync()).info.conflicts[0]!.resolvedAt).not.toBeNull()
  })
})

describe('the library card of a conflicted note', () => {
  async function library(conflicts: { pageId: string; kind: string; originalIndex: number }[]) {
    const seed = openNoteStore()
    await seed.writeNote(two())
    seed.close()
    m = mountUi(
      createElement(
        SyncUiProvider,
        { auth: fakeAuth() as never, status: fakeStatus({ [NID]: view(conflicts.length > 0 ? 'conflict' : 'synced', { hasUnsent: false, conflicts }) }), net: fakeNet(), receiver: undefined },
        createElement(Library, { openStore, editedBy: 'x' }),
      ),
    )
    await settle()
    await settle()
  }

  test('opening it asks for the dialog; the card says 두 버전', async () => {
    takeResolveRequest(NID)
    await library([{ pageId: PA, kind: 'bothEdited', originalIndex: 0 }])
    expect(m!.q('.sync-badge-twoVersions')).not.toBeNull()
    expect(m!.q('.cover-card .sr-only')!.textContent).toContain('두 버전')
    act(() => void m!.q<HTMLAnchorElement>('a.cover-card')!.click())
    expect(takeResolveRequest(NID)).toBe(true)
    expect(takeResolveRequest(NID)).toBe(false) // once per request
  })

  test('a note without a conflict opens as before', async () => {
    takeResolveRequest(NID)
    await library([])
    act(() => void m!.q<HTMLAnchorElement>('a.cover-card')!.click())
    expect(takeResolveRequest(NID)).toBe(false)
  })
})

describe('the shell', () => {
  test('[해결하기] is live in the app: it opens the dialog of the note on the screen', async () => {
    takeResolveRequest(NID)
    const seed = openNoteStore()
    await seed.writeNote(two())
    const entry = { pageId: PA, kind: 'bothEdited', rev: 'x1', theirsRev: 't1', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null } as const
    await seed.recordConflicts(NID, {
      conflicts: [entry],
      sidecars: [{ noteId: NID, pageId: PA, rev: 'x1', seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: withStroke(two(), PA, 'x1').pages[0]! }],
    })
    seed.close()
    location.hash = `#/notes/${NID}`
    const st = fakeStatus({ [NID]: view('conflict', { hasUnsent: false, conflicts: [{ pageId: PA, kind: 'bothEdited', originalIndex: 0 }] }) })
    m = mountUi(createElement(App, { auth: signedIn, syncUi: { status: st, net: fakeNet() } }))
    await until(() => !!m!.q('[data-banner] button'), 'the banner')
    const b = m!.q<HTMLButtonElement>('[data-banner] button')!
    expect(b.getAttribute('aria-disabled')).toBe('false')
    act(() => void b.click())
    await until(() => !!dialog(), 'the dialog')
  })
})

describe('Writer.applyResolved', () => {
  const mk = (h: History) => new Writer(h, { writeNote: async () => {}, close: () => {} } as never, () => ({}) as never, () => {}, () => 'C')
  const entry = { pageId: PA, kind: 'bothEdited', rev: 'a2', theirsRev: 'a3', detectedAt: NOW_, originalIndex: 0, resolvedAt: null } as const
  const sidecar = (rev: string) => ({ noteId: NID, pageId: PA, rev, seq: 2, editedAt: NOW_, editedBy: 'C', kind: 'bothEdited' as const, page: { ...two().pages[0]!, rev } })

  test('refused while a stroke is in progress, like a merge', () => {
    const h = new History(two())
    const w = mk(h)
    ;(w as unknown as { drawing: unknown }).drawing = { id: 1, strokeId: 's', type: 'pen', t0: 0, points: [], pageId: PB, ox: 0, oy: 0 }
    expect(w.applyResolved(entry, sidecar('a2'), 'mine')).toEqual({ error: 'notApplied' })
    expect(h.note).toEqual(two())
  })

  test('identical versions on both sides keep the other device version instead of failing; no second page', () => {
    const h = new History(two())
    h.setLocked([PA])
    const w = mk(h)
    const out = w.applyResolved(entry, sidecar('a1'), 'both') // the page in the note has rev a1 too
    expect(out.result).toBe('resolved')
    expect(out.result === 'resolved' && out.used).toBe('theirs')
    expect(h.note.pages).toHaveLength(2)
    expect(h.note.pages[0]!.rev).not.toBe('a1')
  })

  test('undo records of the touched pages are dropped, the others stay; an error changes nothing; a read-only writer refuses', () => {
    const h = new History(two())
    const ctx = { rev: 'r', now: NOW_, editedBy: 'C', lastSeenRemoteSeq: 0 }
    h.doOp({ op: 'addStroke', pageId: PB, stroke: stroke('sb') }, { ...ctx, rev: 'rb' })
    h.doOp({ op: 'addStroke', pageId: PA, stroke: stroke('sa') }, { ...ctx, rev: 'ra' })
    const w = mk(h)
    expect(h.undoDepth).toBe(2)
    const out = w.applyResolved({ ...entry, rev: 'ra' }, sidecar('ra'), 'mine')
    expect(out.result).toBe('resolved')
    expect(h.undoDepth).toBe(1) // page A's record is gone
    const before = structuredClone(h.note)
    expect(w.applyResolved({ ...entry, kind: 'bothEdited', resolvedAt: NOW_ }, sidecar('ra'), 'mine')).toEqual({ error: 'alreadyResolved' })
    expect(w.applyResolved(entry, sidecar('ra'), 'nonsense')).toEqual({ error: 'invalidChoice' })
    expect(h.note).toEqual(before)
    w.readOnly = true
    expect(w.applyResolved(entry, sidecar('ra'), 'mine')).toEqual({ error: 'notApplied' })
  })
})
