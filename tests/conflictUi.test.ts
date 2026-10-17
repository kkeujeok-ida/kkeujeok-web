// @vitest-environment jsdom
// Story 3.20, the screens: the conflict banner (first in the slot, kind-specific words, [해결하기]), its one-time
// emphasis, the assertive announcements, the `두 버전` label, ko/en, and no system notification on the web.
import 'fake-indexeddb/auto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resources } from '../src/i18n'
import type { Note, Stroke } from '../src/model/note'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore, type NoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import type { Conflict, Sidecar } from '../src/sync/merge'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Banner, EMPHASIS_MS } from '../src/ui/sync/Banner'
import { type Mounted, SyncUiProvider, fakeAuth, fakeNet, fakeStatus, mountUi, view } from './syncUiHarness'
import { NID, PA, PB, mkNote } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {}, set: () => true })) as never

let m: Mounted | undefined
let stores: NoteStore[] = []
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const flush = async () => {
  await settle()
  await settle()
}
const openStore = () => {
  const s = openNoteStore()
  stores.push(s)
  return s
}
beforeEach(() => clearSessionHistories())
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  m?.unmount()
  m = undefined
  await savesSettled()
  stores.forEach((s) => s.close())
  stores = []
  location.hash = ''
  await deleteNoteDatabase()
})

type P = { auth?: ReturnType<typeof fakeAuth>; status?: ReturnType<typeof fakeStatus>; net?: ReturnType<typeof fakeNet>; resolve?: (id: string) => void }
const provider = (p: P, child: ReturnType<typeof createElement>) =>
  createElement(
    SyncUiProvider,
    {
      auth: (p.auth ?? fakeAuth()) as never,
      status: p.status ?? fakeStatus(),
      net: p.net ?? fakeNet(),
      receiver: undefined,
      ...(p.resolve && { resolve: p.resolve }),
    },
    child,
  )
const both = (pageId = PA, originalIndex = 0) => ({ pageId, kind: 'bothEdited', originalIndex })
const gone = (pageId = PB, originalIndex = 1) => ({ pageId, kind: 'remoteDeleted', originalIndex })
const conflictView = (...conflicts: { pageId: string; kind: string; originalIndex: number }[]) => view('conflict', { hasUnsent: false, conflicts })
const kinds = () => m!.qa('[data-banner]').map((e) => e.getAttribute('data-banner')!)

describe('the conflict banner', () => {
  test('the words, the icon, polite, [해결하기]; first of the slot above every other banner', () => {
    const status = fakeStatus({ [NID]: conflictView(both()) })
    m = mountUi(provider({ status, auth: fakeAuth({ expired: true }), net: fakeNet(true) }, createElement(Banner, { noteId: NID, otherTab: true, onClose: () => {} })))
    expect(kinds()).toEqual(['conflictReadOnly'])
    const b = m.q('[data-banner="conflictReadOnly"]')!
    expect(b.firstElementChild!.tagName.toLowerCase()).toBe('svg')
    expect(b.querySelector('.editor-banner-text')!.textContent).toBe('다른 기기에서도 고친 페이지예요. 고를 때까지는 읽기만 돼요.')
    expect([...b.querySelectorAll('button')].map((x) => x.textContent)).toEqual(['해결하기'])
    expect(b.getAttribute('role')).toBe('status')
    expect(b.getAttribute('aria-live')).toBe('polite')
    expect(b.hasAttribute('data-emphasis')).toBe(false)
  })

  test('when the conflict is resolved the banner steps aside for the next one', () => {
    const status = fakeStatus({ [NID]: conflictView(both()) })
    m = mountUi(provider({ status, net: fakeNet(true) }, createElement(Banner, { noteId: NID })))
    expect(kinds()).toEqual(['conflictReadOnly'])
    status.set({ [NID]: view('synced', { conflicts: [] }) })
    expect(kinds()).toEqual(['offline'])
  })

  test('only pages the other device deleted: their own words; a mix uses the general ones', () => {
    const status = fakeStatus({ [NID]: conflictView(gone()) })
    m = mountUi(provider({ status }, createElement(Banner, { noteId: NID })))
    expect(m.q('.editor-banner-text')!.textContent).toBe('다른 기기에서 지운 페이지가 있어요. 고를 때까지 이 기기 버전을 보관해요.')
    status.set({ [NID]: conflictView(gone(), both()) })
    expect(m.q('.editor-banner-text')!.textContent).toBe('다른 기기에서도 고친 페이지예요. 고를 때까지는 읽기만 돼요.')
  })

  test('English', () => {
    const status = fakeStatus({ [NID]: conflictView(both()) })
    m = mountUi(provider({ status }, createElement(Banner, { noteId: NID })), 'en')
    expect(m.q('.editor-banner-text')!.textContent).toBe('This page was also edited on another device. It is read-only until you choose.')
    expect(m.q('button')!.textContent).toBe('Resolve')
  })

  test('a conflict on another note does not show here, and the library banner (no note) never does', () => {
    const status = fakeStatus({ [NID]: conflictView(both()), other: view('synced') })
    m = mountUi(provider({ status }, createElement(Banner, { noteId: 'other' })))
    expect(kinds()).toEqual([])
    m.render(provider({ status }, createElement(Banner, {})))
    expect(kinds()).toEqual([])
  })

  test('[해결하기] calls the hook of the sheet story with the note; without a hook it is inert and says so', () => {
    const resolve = vi.fn()
    const status = fakeStatus({ [NID]: conflictView(both()) })
    m = mountUi(provider({ status, resolve }, createElement(Banner, { noteId: NID })))
    act(() => m!.q<HTMLButtonElement>('button')!.click())
    expect(resolve).toHaveBeenCalledWith(NID)
    m.render(provider({ status }, createElement(Banner, { noteId: NID })))
    const button = m.q<HTMLButtonElement>('button')!
    expect(button.getAttribute('aria-disabled')).toBe('true')
    act(() => button.click()) // nothing to call, nothing thrown
  })

  test('pulse: the banner is emphasized once per blocked write and the emphasis ends by itself', () => {
    vi.useFakeTimers()
    const status = fakeStatus({ [NID]: conflictView(both()) })
    m = mountUi(provider({ status }, createElement(Banner, { noteId: NID, pulse: 0 })))
    const b = () => m!.q('[data-banner]')!
    expect(b().classList.contains('is-emphasis')).toBe(false)
    m.render(provider({ status }, createElement(Banner, { noteId: NID, pulse: 1 })))
    expect(b().getAttribute('data-emphasis')).toBe('true')
    expect(b().classList.contains('is-emphasis')).toBe(true)
    act(() => void vi.advanceTimersByTime(EMPHASIS_MS - 1))
    expect(b().classList.contains('is-emphasis')).toBe(true)
    act(() => void vi.advanceTimersByTime(2))
    expect(b().classList.contains('is-emphasis')).toBe(false)
    m.render(provider({ status }, createElement(Banner, { noteId: NID, pulse: 2 })))
    expect(b().classList.contains('is-emphasis')).toBe(true)
  })

  test('no timer is left behind when the banner goes away', () => {
    vi.useFakeTimers()
    const status = fakeStatus({ [NID]: conflictView(both()) })
    m = mountUi(provider({ status }, createElement(Banner, { noteId: NID, pulse: 1 })))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    m.unmount()
    m = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the writing screen with a conflict', () => {
  async function mountEditor(status: ReturnType<typeof fakeStatus>, o: { note?: Note; recorded?: string; lang?: 'ko' | 'en' } = {}) {
    const s = openNoteStore()
    await s.writeNote(o.note ?? mkNote({ noteId: NID, title: '필기', pages: { [PA]: 'a1', [PB]: 'b1' } }))
    if (o.recorded) {
      const c: Conflict = { pageId: o.recorded, kind: 'bothEdited', rev: 'x1', theirsRev: 't1', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex: 0, resolvedAt: null }
      const sc: Sidecar = { noteId: NID, pageId: o.recorded, rev: 'x1', seq: 2, editedAt: '2026-10-11T04:20:00.000Z', editedBy: 'C', kind: 'bothEdited', page: mkNote().pages[0]! }
      await s.recordConflicts(NID, { conflicts: [c], sidecars: [sc] })
    }
    s.close()
    m = mountUi(provider({ status }, createElement(NoteEditor, { noteId: NID, openStore })), o.lang ?? 'ko')
    await flush()
  }
  const alerts = () => m!.qa('[role="alert"]').map((e) => e.textContent).filter(Boolean)
  const draw = () => {
    const c = m!.q<HTMLCanvasElement>('canvas.editor-canvas')!
    const ev = (n: string, x: number) =>
      act(() => void c.dispatchEvent(new PointerEvent(n, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', clientX: x, clientY: 30, pressure: 0.5, buttons: 1 })))
    ev('pointerdown', 20)
    ev('pointermove', 40)
    ev('pointerup', 60)
  }
  const savedStrokes = async () => {
    const s = openNoteStore()
    const r = await s.loadNote(NID)
    s.close()
    return (r?.note?.pages[0]?.elements ?? []) as Stroke[]
  }

  test('opened with a conflict: the banner is the first thing, the label says 두 버전, nothing is announced assertively', async () => {
    await mountEditor(fakeStatus({ [NID]: conflictView(both()) }), { recorded: PA })
    expect(m!.q('.editor')!.firstElementChild!.getAttribute('data-banner')).toBe('conflictReadOnly')
    expect(m!.q('.sync-indicator-button')!.classList.contains('sync-twoVersions')).toBe(true)
    expect(m!.q('.sync-indicator-button')!.getAttribute('aria-label')).toContain('두 버전')
    expect(alerts()).toEqual([])
  })

  test('a conflict that appears while it is open is announced assertively with the page number; a second view of the same one is not', async () => {
    const status = fakeStatus({ [NID]: view('synced', { conflicts: [] }) })
    await mountEditor(status)
    expect(alerts()).toEqual([])
    status.set({ [NID]: conflictView(both(PA, 2)) })
    expect(alerts()).toEqual(['3페이지를 두 기기에서 고쳤어요. 고를 때까지 읽기만 돼요.'])
    expect(m!.q('[data-banner]')!.getAttribute('data-banner')).toBe('conflictReadOnly')
    status.set({ [NID]: conflictView(both(PA, 2)) })
    expect(alerts()).toEqual(['3페이지를 두 기기에서 고쳤어요. 고를 때까지 읽기만 돼요.'])
  })

  test('a page the other device deleted has its own announcement; English too', async () => {
    const status = fakeStatus({ [NID]: view('synced', { conflicts: [] }) })
    await mountEditor(status, { lang: 'en' })
    status.set({ [NID]: conflictView(gone(PB, 1)) })
    expect(alerts()).toEqual(["Page 2 was deleted on another device. This device's version is kept until you choose."])
    expect(m!.q('.editor-banner-text')!.textContent).toBe("A page was deleted on another device. This device's version is kept until you choose.")
  })

  test('a write on the locked page emphasizes the banner once and announces; the other page of the note is still writable', async () => {
    await mountEditor(fakeStatus({ [NID]: conflictView(both()) }), { recorded: PA })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    draw()
    expect(m!.q('[data-banner]')!.getAttribute('data-emphasis')).toBe('true')
    expect(alerts()).toEqual(['읽기 전용 페이지예요'])
    expect(await savedStrokes()).toHaveLength(0)
    act(() => void vi.advanceTimersByTime(EMPHASIS_MS + 10))
    expect(m!.q('[data-banner]')!.hasAttribute('data-emphasis')).toBe(false)
    // the announcement goes away by itself
    act(() => void vi.advanceTimersByTime(6000))
    expect(alerts()).toEqual([])
  })

  test('the status store alone locks the page (the sync record was read before it knew)', async () => {
    const status = fakeStatus({ [NID]: view('synced', { conflicts: [] }) })
    await mountEditor(status)
    status.set({ [NID]: conflictView(both()) })
    draw()
    await flush()
    expect(await savedStrokes()).toHaveLength(0)
  })

  test('the alert and emphasis timers die with the editor', async () => {
    await mountEditor(fakeStatus({ [NID]: conflictView(both()) }), { recorded: PA })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    draw()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    m!.unmount()
    m = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('strings and system notifications', () => {
  const keys = [
    'banner.conflict',
    'banner.conflictDeleted',
    'banner.conflict.resolve',
    'editor.conflictDetected',
    'editor.conflictDetectedDeleted',
    'editor.pageReadOnly',
    'editor.conflictDescription',
  ] as const

  test('every new string exists in ko and en; the key sets stay equal; no raw control bytes', () => {
    for (const k of keys) {
      expect(resources.ko[k]).toBeTruthy()
      expect(resources.en[k]).toBeTruthy()
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(resources.ko[k] + resources.en[k])).toBe(false)
    }
    expect(Object.keys(resources.en).sort()).toEqual(Object.keys(resources.ko).sort())
    expect(resources.ko['editor.conflictDetected']).toContain('{n}')
    expect(resources.en['editor.conflictDetected']).toContain('{n}')
  })

  test('the sources use no system notification and no raw control bytes', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|css|json)$/.test(f)) files.push(p)
      }
    }
    walk('src')
    expect(files.length).toBeGreaterThan(50)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/new\s+Notification\s*\(/)
      expect(text, f).not.toMatch(/Notification\.requestPermission/)
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), f).toBe(false)
    }
  })
})
