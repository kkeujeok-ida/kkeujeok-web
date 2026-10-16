// @vitest-environment jsdom
// The screens of Drive changes that are not ours (Story 3.18): the deleted and new-version banners and
// their place in the slot, the snackbar, the "열 수 없음" card and its sheet, the read-only editor.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resources } from '../src/i18n'
import type { Note, Stroke } from '../src/model/note'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore, type NoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { Library } from '../src/ui/library/Library'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Banner } from '../src/ui/sync/Banner'
import { REVIVE_SNACKBAR_MS, ReviveSnackbar } from '../src/ui/sync/ReviveSnackbar'
import { type Mounted, SyncUiProvider, fakeAuth, fakeNet, fakeStatus, mountUi, view } from './syncUiHarness'
import { NID, mkNote } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true })
HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never

const N2 = '01926f3a-0000-7000-8000-0000000000a2'
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
const downloads: string[] = []
beforeEach(() => {
  downloads.length = 0
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download)
  })
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  m?.unmount()
  m = undefined
  await savesSettled()
  stores.forEach((s) => s.close())
  stores = []
  clearSessionHistories()
  location.hash = ''
  await deleteNoteDatabase()
})

const rx = (o: { revived?: number; revive?: () => Promise<void> } = {}) => {
  let state = { version: 0, receiving: new Set<string>(), scanning: false, revived: o.revived ?? 0 }
  const ls = new Set<() => void>()
  return {
    subscribe: (f: () => void) => (ls.add(f), () => void ls.delete(f)),
    getState: () => state,
    revive: vi.fn<(id: string) => Promise<void>>(o.revive ?? (async () => {})),
    bump() {
      state = { ...state, revived: state.revived + 1 }
      act(() => ls.forEach((f) => f()))
    },
    listeners: () => ls.size,
  }
}
type Receiver = ReturnType<typeof rx>
type P = {
  auth?: ReturnType<typeof fakeAuth>
  status?: ReturnType<typeof fakeStatus>
  net?: ReturnType<typeof fakeNet>
  receiver?: Receiver
  uploads?: { syncNow: (id: string) => Promise<void> }
  exportLog?: () => Promise<{ name: string; text: string }>
}
const provider = (p: P, child: ReturnType<typeof createElement>) =>
  createElement(
    SyncUiProvider,
    {
      auth: (p.auth ?? fakeAuth()) as never,
      status: p.status ?? fakeStatus(),
      net: p.net ?? fakeNet(),
      receiver: (p.receiver ?? rx()) as never,
      ...(p.uploads && { uploads: p.uploads }),
      ...(p.exportLog && { exportLog: p.exportLog }),
    },
    child,
  )
const deleted = view('error', { hasUnsent: false, lastError: { class: 'deleted', reason: 'trashed' }, fileId: 'F1' })
const newer = view('error', { hasUnsent: true, lastError: { class: 'unreadable', reason: 'unsupportedVersion' }, fileId: 'F1' })

describe('the banner slot with the new kinds', () => {
  const kinds = () => m!.qa('[data-banner]').map((e) => e.getAttribute('data-banner')!)

  test('deleted: the text and [다시 살리기] [닫기], polite, in the right place of the order', () => {
    const status = fakeStatus({ [NID]: deleted })
    const auth = fakeAuth({ expired: true })
    const net = fakeNet(true)
    m = mountUi(provider({ status, auth, net }, createElement(Banner, { noteId: NID, onClose: () => {} })))
    expect(kinds()).toEqual(['deleted'])
    const b = m.q('[data-banner="deleted"]')!
    expect(b.firstElementChild!.tagName.toLowerCase()).toBe('svg')
    expect(b.querySelector('.editor-banner-text')!.textContent).toBe('다른 기기에서 지운 노트예요.')
    expect([...b.querySelectorAll('button')].map((x) => x.textContent)).toEqual(['다시 살리기', '닫기'])
    expect(b.getAttribute('role')).toBe('status')
    expect(b.getAttribute('aria-live')).toBe('polite')
    // another tab's banner is above it, the token banner below
    m.render(provider({ status, auth, net }, createElement(Banner, { noteId: NID, otherTab: true, onClose: () => {} })))
    expect(kinds()).toEqual(['otherTab'])
  })

  test('new version: the text, no button; below deleted, above the token banner', () => {
    const status = fakeStatus({ [NID]: newer })
    const auth = fakeAuth({ expired: true })
    m = mountUi(provider({ status, auth }, createElement(Banner, { noteId: NID })))
    expect(kinds()).toEqual(['newVersion'])
    expect(m.q('[data-banner]')!.textContent).toBe('새 버전에서 만든 노트예요. 앱을 업데이트하면 편집할 수 있어요.')
    expect(m.q('[data-banner] button')).toBeNull()
    status.set({ [NID]: deleted })
    expect(kinds()).toEqual(['deleted'])
    status.set({ [NID]: view('pending') })
    expect(kinds()).toEqual(['reauth'])
  })

  test('the banner belongs to its note: another note deleted, a banner without a note, the library', () => {
    const status = fakeStatus({ [N2]: deleted })
    m = mountUi(provider({ status }, createElement(Banner, { noteId: NID })))
    expect(kinds()).toEqual([])
    m.render(provider({ status }, createElement(Banner)))
    expect(kinds()).toEqual([])
  })

  test('English texts', () => {
    m = mountUi(provider({ status: fakeStatus({ [NID]: deleted }) }, createElement(Banner, { noteId: NID, onClose: () => {} })), 'en')
    expect(m.q('.editor-banner-text')!.textContent).toBe('This note was deleted on another device.')
    expect([...m.qa('[data-banner] button')].map((x) => x.textContent)).toEqual(['Restore', 'Close'])
    m.render(provider({ status: fakeStatus({ [NID]: newer }) }, createElement(Banner, { noteId: NID })))
    expect(m.q('.editor-banner-text')!.textContent).toBe('This note was made in a newer version. Update the app to edit it.')
  })

  test('[다시 살리기] restores, then uploads; a second press while it runs is ignored; [닫기] calls onClose', async () => {
    let done!: () => void
    const receiver = rx({ revive: () => new Promise<void>((r) => (done = r)) })
    const order: string[] = []
    receiver.revive.mockImplementation(async (id: string) => {
      order.push(`revive ${id}`)
      await new Promise<void>((r) => (done = r))
    })
    const uploads = { syncNow: vi.fn(async (id: string) => void order.push(`syncNow ${id}`)) }
    const onClose = vi.fn()
    m = mountUi(provider({ receiver, uploads, status: fakeStatus({ [NID]: deleted }) }, createElement(Banner, { noteId: NID, onClose })))
    const [revive, close] = m.qa<HTMLButtonElement>('[data-banner] button')
    act(() => revive!.click())
    act(() => revive!.click())
    expect(receiver.revive).toHaveBeenCalledTimes(1)
    expect(revive!.getAttribute('aria-busy')).toBe('true')
    await act(async () => done())
    expect(order).toEqual([`revive ${NID}`, `syncNow ${NID}`])
    expect(revive!.getAttribute('aria-busy')).toBe('false')
    act(() => close!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('nothing is set after the banner is gone while [다시 살리기] runs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let done!: () => void
    const receiver = rx()
    receiver.revive.mockImplementation(() => new Promise<void>((r) => (done = r)))
    m = mountUi(provider({ receiver, status: fakeStatus({ [NID]: deleted }) }, createElement(Banner, { noteId: NID, onClose: () => {} })))
    act(() => m!.q<HTMLButtonElement>('[data-banner] button')!.click())
    m.unmount()
    await act(async () => done())
    expect(err).not.toHaveBeenCalled()
  })
})

describe('the snackbar', () => {
  test('shows once for each restored note, goes away by itself, and is silent before anything happens', () => {
    vi.useFakeTimers()
    const receiver = rx()
    m = mountUi(provider({ receiver }, createElement(ReviveSnackbar)))
    const bar = () => m!.q('[role="status"].snackbar')!
    expect(bar().textContent).toBe('')
    receiver.bump()
    expect(bar().textContent).toBe('다른 기기에서 지운 노트에 보내지 않은 변경이 있어 되살렸어요.')
    act(() => void vi.advanceTimersByTime(REVIVE_SNACKBAR_MS - 1))
    expect(bar().textContent).not.toBe('')
    act(() => void vi.advanceTimersByTime(1))
    expect(bar().textContent).toBe('')
    receiver.bump() // a second note: again
    expect(bar().textContent).not.toBe('')
  })

  test('a count that was already above zero when it mounted shows nothing; no timer is left after unmount', () => {
    vi.useFakeTimers()
    const receiver = rx({ revived: 2 })
    m = mountUi(provider({ receiver }, createElement(ReviveSnackbar)))
    expect(m.q('.snackbar')!.textContent).toBe('')
    receiver.bump()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    m.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(receiver.listeners()).toBe(0)
  })

  test('English text', () => {
    const receiver = rx()
    m = mountUi(provider({ receiver }, createElement(ReviveSnackbar)), 'en')
    receiver.bump()
    expect(m.q('.snackbar')!.textContent).toBe('This note was deleted on another device but had unsent changes, so it was restored.')
  })
})

describe('the "열 수 없음" card and its sheet', () => {
  async function seed(...ids: string[]) {
    const s = openStore()
    for (const id of ids) await s.writeNote(mkNote({ noteId: id, title: `노트 ${id.slice(-2)}` }) as Note)
  }
  const sheet = () => m!.q('[role="dialog"]')
  const cardButtons = () => m!.qa<HTMLButtonElement>('button.cover-card-disabled')

  async function library(p: P, o: { store?: () => NoteStore } = {}) {
    const receiver = p.receiver ?? rx()
    m = mountUi(provider({ ...p, receiver }, createElement(Library, { openStore: o.store ?? openStore, editedBy: 'x', receiver: receiver as never })))
    await flush()
  }
  async function blockedCard(reason: 'unreadable' | 'unsupportedVersion' = 'unreadable') {
    const s = openStore()
    await s.remote.put({ noteId: N2, fileId: 'RF', headRevisionId: 'rev9', title: '원격 노트', folderId: null, coverId: null, modifiedAt: '2026-10-10T04:20:00.000Z', blocked: reason })
  }

  test.each(['unreadable', 'unsupportedVersion'] as const)('a remote-only blocked card (%s) is one disabled button; the sheet has the Drive link and the log, no file download', async (reason) => {
    await blockedCard(reason)
    await library({})
    expect(cardButtons()).toHaveLength(1)
    const card = cardButtons()[0]!
    expect(card.textContent).toBe('열 수 없음')
    expect(card.getAttribute('aria-haspopup')).toBe('dialog')
    expect(m!.q('a.cover-card')).toBeNull()
    act(() => card.click())
    const d = sheet()!
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.querySelector('p:not(.dialog-title)')!.textContent).toBe('이 노트 파일을 읽을 수 없어요. 파일은 그대로 두었어요.')
    const link = d.querySelector<HTMLAnchorElement>('a')!
    expect(link.textContent).toBe('Drive에서 보기')
    expect(link.getAttribute('href')).toBe('https://drive.google.com/file/d/RF/view')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    expect([...d.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['동기화 로그 내보내기', '닫기'])
    expect(document.activeElement).toBe(link)
  })

  test('Tab stays inside the sheet, Esc closes it and focus goes back to the card', async () => {
    await blockedCard()
    await library({})
    const card = cardButtons()[0]!
    card.focus()
    act(() => card.click())
    const items = [...sheet()!.querySelectorAll<HTMLElement>('a[href], button')]
    expect(items.length).toBe(3)
    const key = (k: string, init: KeyboardEventInit = {}) =>
      act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))
    items[items.length - 1]!.focus()
    key('Tab')
    expect(document.activeElement).toBe(items[0])
    key('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(items[items.length - 1])
    key('Escape')
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(card)
  })

  test('[닫기] closes it the same way', async () => {
    await blockedCard()
    await library({})
    const card = cardButtons()[0]!
    act(() => card.click())
    act(() => [...sheet()!.querySelectorAll('button')].find((b) => b.textContent === '닫기')!.click())
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(card)
  })

  test('a local note whose remote file is broken is the same card; with unsent changes the sheet offers the device copy', async () => {
    await seed(NID)
    const status = fakeStatus({ [NID]: view('error', { hasUnsent: true, fileId: 'F1', lastError: { class: 'unreadable', reason: 'parse', status: undefined } as never }) })
    await library({ status })
    expect(m!.q('a.cover-card')).toBeNull()
    act(() => cardButtons()[0]!.click())
    expect([...sheet()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['동기화 로그 내보내기', '파일로 내려받기', '닫기'])
    expect(sheet()!.textContent).toContain('보내지 않은 변경은 이 기기에 그대로 있어요.')
    await act(async () => [...sheet()!.querySelectorAll('button')].find((b) => b.textContent === '파일로 내려받기')!.click())
    await flush()
    expect(downloads).toEqual([`노트 a1-${NID.slice(0, 8)}.kkj`])
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe('')
  })

  test('a local note without a Drive file has no Drive link', async () => {
    await seed(NID)
    const status = fakeStatus({ [NID]: view('error', { hasUnsent: false, fileId: null, lastError: { class: 'unreadable', reason: 'parse' } }) })
    await library({ status })
    act(() => cardButtons()[0]!.click())
    expect(sheet()!.querySelector('a')).toBeNull()
  })

  test('the device copy cannot be saved: the sheet says so and stays', async () => {
    await seed(NID)
    const status = fakeStatus({ [NID]: view('error', { hasUnsent: true, fileId: 'F1', lastError: { class: 'unreadable', reason: 'parse' } }) })
    await library({ status }, { store: () => ({ ...openStore(), loadNote: async () => null }) as NoteStore })
    act(() => cardButtons()[0]!.click())
    await act(async () => [...sheet()!.querySelectorAll('button')].find((b) => b.textContent === '파일로 내려받기')!.click())
    await flush()
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe('파일을 내려받지 못했어요. 다시 시도해 주세요')
    expect(downloads).toEqual([])
  })

  test('[동기화 로그 내보내기] saves the log; a failure is told', async () => {
    await blockedCard()
    const exportLog = vi.fn(async () => ({ name: 'sync-log.jsonl', text: '{}' }))
    await library({ exportLog })
    act(() => cardButtons()[0]!.click())
    const log = () => [...sheet()!.querySelectorAll('button')].find((b) => b.textContent === '동기화 로그 내보내기')!
    await act(async () => log().click())
    expect(downloads).toEqual(['sync-log.jsonl'])
    m!.unmount()
    m = undefined
    downloads.length = 0
    await blockedCard()
    await library({ exportLog: async () => Promise.reject(new Error('x')) })
    act(() => cardButtons()[0]!.click())
    await act(async () => log().click())
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe('로그를 내보내지 못했어요. 다시 시도해 주세요')
  })

  test('a local note of a newer format is an ordinary card that opens', async () => {
    await seed(NID)
    await library({ status: fakeStatus({ [NID]: newer }) })
    expect(m!.q('a.cover-card')!.getAttribute('href')).toContain(NID)
    expect(cardButtons()).toHaveLength(0)
  })

  test('English sheet', async () => {
    await blockedCard()
    m = mountUi(provider({}, createElement(Library, { openStore, editedBy: 'x' })), 'en')
    await flush()
    act(() => cardButtons()[0]!.click())
    expect(sheet()!.getAttribute('aria-label')).toBe("Note that can't be opened")
    expect(sheet()!.textContent).toContain("This note file can't be read. The file was left as it is.")
    expect(sheet()!.querySelector('a')!.textContent).toBe('View in Drive')
  })
})

describe('the writing screen', () => {
  async function mountEditor(p: P, receiver?: object) {
    const s = openNoteStore()
    await s.writeNote(mkNote({ noteId: NID, title: '필기' }) as Note)
    s.close()
    m = mountUi(provider(p, createElement(NoteEditor, { noteId: NID, openStore, ...(receiver && { receiver: receiver as never }) })))
    await flush()
  }
  const savedStrokes = async () => {
    const s = openNoteStore()
    const r = await s.loadNote(NID)
    s.close()
    return (r?.note?.pages[0]?.elements ?? []) as Stroke[]
  }
  const draw = () => {
    const c = m!.q<HTMLCanvasElement>('canvas.editor-canvas')!
    const ev = (n: string, x: number) =>
      act(() => void c.dispatchEvent(new PointerEvent(n, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', clientX: x, clientY: 30, pressure: 0.5, buttons: 1 })))
    ev('pointerdown', 20)
    ev('pointermove', 40)
    ev('pointerup', 60)
  }

  test('a note of a newer format opens read-only: banner, disabled pen, no stroke is saved', async () => {
    await mountEditor({ status: fakeStatus({ [NID]: newer }) })
    expect(m!.q('.editor')!.firstElementChild!.getAttribute('data-banner')).toBe('newVersion')
    expect(m!.q('.editor-banner-text')!.textContent).toBe('새 버전에서 만든 노트예요. 앱을 업데이트하면 편집할 수 있어요.')
    expect(m!.q('[role="radio"]')!.getAttribute('aria-disabled')).toBe('true')
    draw()
    await flush()
    expect(await savedStrokes()).toHaveLength(0)
  })

  test('a note becomes read-only when the newer file is found while it is open', async () => {
    const status = fakeStatus({ [NID]: view('synced') })
    await mountEditor({ status })
    draw()
    await flush()
    expect(await savedStrokes()).toHaveLength(1)
    status.set({ [NID]: newer })
    expect(m!.q('[data-banner]')!.getAttribute('data-banner')).toBe('newVersion')
    draw()
    await flush()
    expect(await savedStrokes()).toHaveLength(1)
  })

  test('the sync record already says newer-format before the status store has read: no first stroke gets in', async () => {
    const s = openNoteStore()
    await s.writeNote(mkNote({ noteId: NID, title: '필기' }) as Note)
    await s.updateSync(NID, (c) => ({ ...c, fileId: 'F1', state: 'error', lastError: { class: 'unreadable', reason: 'unsupportedVersion', head: 'rev9' } }))
    s.close()
    m = mountUi(provider({ status: fakeStatus({}, false) }, createElement(NoteEditor, { noteId: NID, openStore })))
    await flush()
    draw()
    await flush()
    expect(await savedStrokes()).toHaveLength(0)
  })

  test('a deleted note: the banner shows, editing is still possible; [닫기] leaves, and the receiver is told only after the editor is gone', async () => {
    const receiver = { beforeOpen: vi.fn(async () => {}), noteOpened: vi.fn(async () => {}), noteClosed: vi.fn(async () => {}) }
    await mountEditor({ status: fakeStatus({ [NID]: deleted }) }, receiver)
    expect(m!.q('.editor')!.firstElementChild!.getAttribute('data-banner')).toBe('deleted')
    expect([...m!.qa('[data-banner] button')].map((b) => b.textContent)).toEqual(['다시 살리기', '닫기'])
    expect(m!.q('[role="radio"]')!.getAttribute('aria-disabled')).toBeNull()
    location.hash = `#/notes/${NID}`
    await act(async () => [...m!.qa<HTMLButtonElement>('[data-banner] button')].find((b) => b.textContent === '닫기')!.click())
    await flush()
    expect(location.hash).not.toContain('/notes/') // back to the library
    expect(receiver.noteClosed).not.toHaveBeenCalled()
    m!.unmount()
    m = undefined
    await flush()
    expect(receiver.noteClosed).toHaveBeenCalledTimes(1)
    expect(receiver.noteClosed).toHaveBeenCalledWith(NID)
  })

  test('a remount of the same note (leave and reopen at once) is not a close', async () => {
    const receiver = { beforeOpen: vi.fn(async () => {}), noteOpened: vi.fn(async () => {}), noteClosed: vi.fn(async () => {}) }
    const p = { status: fakeStatus({ [NID]: deleted }) }
    await mountEditor(p, receiver)
    m!.render(provider(p, createElement(NoteEditor, { key: 'again', noteId: NID, openStore, receiver: receiver as never })))
    await flush()
    expect(receiver.noteClosed).not.toHaveBeenCalled()
    m!.unmount()
    m = undefined
    await flush()
    expect(receiver.noteClosed).toHaveBeenCalledTimes(1)
  })

  test('the indicator explains a deleted note and a newer one', async () => {
    const status = fakeStatus({ [NID]: deleted })
    await mountEditor({ status })
    act(() => m!.q<HTMLButtonElement>('.sync-indicator-button')!.click())
    expect(m!.q('.sync-popover p')!.textContent).toBe('다른 기기에서 지운 노트예요. 이 기기의 사본은 그대로 있어요.')
    status.set({ [NID]: newer })
    expect(m!.q('.sync-popover p')!.textContent).toBe('새 버전에서 만든 노트라서 여기서는 읽기만 돼요.')
  })
})

describe('strings', () => {
  const keys = [
    'banner.deleted',
    'banner.deleted.revive',
    'banner.deleted.close',
    'banner.newVersion',
    'sync.revived',
    'sync.detail.deleted',
    'sync.detail.newVersion',
    'sync.detail.unreadable',
    'cannotOpen.label',
    'cannotOpen.body',
    'cannotOpen.unsent',
    'cannotOpen.openDrive',
    'cannotOpen.exportFile',
    'cannotOpen.exportFailed',
    'dialog.close',
  ] as const
  test('every new string exists in ko and en, and the two languages have the same keys', () => {
    for (const k of keys) {
      expect(resources.ko[k], k).toBeTruthy()
      expect(resources.en[k], k).toBeTruthy()
    }
    expect(Object.keys(resources.en).sort()).toEqual(Object.keys(resources.ko).sort())
  })
})
