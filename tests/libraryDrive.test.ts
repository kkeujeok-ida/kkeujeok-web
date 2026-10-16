// @vitest-environment jsdom
// Library behind the Drive root folder (Story 3.10): preparing, failed cards,
// the missing-root dialog, deferral and foreground re-checks.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRootFolderService, type RootResult } from '../src/drive/rootFolder'
import { createRootFolderStore, type RootFolderStore } from '../src/drive/rootFolderStore'
import { I18nContext, createI18n } from '../src/i18n'
import { createNote } from '../src/ops/ops'
import { createNewNoteDefaults } from '../src/storage/newNoteDefaults'
import { deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { createSyncDeviceStore } from '../src/storage/syncDevice'
import { SYNC_LOG_DB, createSyncLog } from '../src/sync/syncLog'
import { App } from '../src/ui/App'
import { Library } from '../src/ui/library/Library'
import { createFakeDrive } from './fakeDrive'
import { signedIn } from './helpers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const flush = async () => {
  await settle()
  await settle()
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
const qa = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)]
const alert = () => q('[role="alertdialog"]')
const dialogButtons = () => qa<HTMLButtonElement>('[role="alertdialog"] button')
const labels = () => dialogButtons().map((b) => b.textContent)
const click = (el: Element) => act(() => (el as HTMLElement).click())
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))
const byText = (text: string) => qa<HTMLButtonElement>('button').find((b) => b.textContent === text)!

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await deleteNoteDatabase()
  await new Promise<void>((r) => {
    const x = indexedDB.deleteDatabase(SYNC_LOG_DB)
    x.onsuccess = x.onerror = () => r()
  })
})

const i18n = (lang = 'ko-KR') => createI18n({ navigatorLanguage: lang, storage: { getItem: () => null, setItem: () => {} } })

// A store over a scripted service: each call takes the next result (the last one repeats).
function scripted(results: RootResult[], o: { signIn?: () => Promise<string> } = {}) {
  let i = 0
  const call = vi.fn(async () => results[Math.min(i++, results.length - 1)]!)
  const recreate = vi.fn(async () => ({ status: 'ready', folderId: 'new' }) as RootResult)
  const listeners = new Set<() => void>()
  const store = createRootFolderStore({
    service: { checkRoot: call, recreate },
    auth: { getState: () => ({ token: 't' }) as never, subscribe: (f) => (listeners.add(f), () => void listeners.delete(f)), signIn: (o.signIn ?? (async () => 'denied')) as never },
    throttleMs: 0,
  })
  return { store, call, recreate }
}

function mountLibrary(store: RootFolderStore | undefined, signOut = vi.fn()) {
  const defaults = createNewNoteDefaults({ getItem: () => null, setItem: () => {} })
  act(() =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: i18n() },
        createElement(Library, { openStore: () => openNoteStore(), defaults, editedBy: 'Chrome', root: store, signOut }),
      ),
    ),
  )
  return signOut
}

async function seedNote(noteId = 'n1') {
  const r = createNote({
    title: '내 노트', existingTitles: [], background: 'plain', orientation: 'portrait',
    noteId, pageId: `${noteId}-p`, pageRev: 'r', metaRev: 'm', orderRev: 'o',
    now: '2026-10-10T04:20:00.000Z', editedBy: 'Chrome',
  })
  if ('error' in r) throw new Error(r.error)
  const s = openNoteStore()
  await s.writeNote(r.note)
  s.close()
}
const setVisibility = (v: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
}

describe('preparing and failed', () => {
  test('"Drive 준비 중" shows while the root is prepared and goes away when ready', async () => {
    let done!: (r: RootResult) => void
    const store = createRootFolderStore({
      service: { checkRoot: () => new Promise((r) => (done = r)), recreate: async () => ({ status: 'ready' }) },
      auth: { getState: () => ({ token: 't' }) as never, subscribe: () => () => {}, signIn: (async () => 'denied') as never },
    })
    mountLibrary(store)
    await flush()
    expect(q('[role="status"]')?.textContent).toBe('Drive 준비 중')
    await act(async () => done({ status: 'ready', folderId: 'r' }))
    await flush()
    expect(host.textContent).not.toContain('Drive 준비 중')
    expect(alert()).toBeNull()
  })

  test('a network failure: the card and [다시 시도] (one run); notes still show; no dialog', async () => {
    await seedNote()
    const { store, call } = scripted([{ status: 'failed', errorClass: 'backoff' }, { status: 'ready', folderId: 'r' }])
    mountLibrary(store)
    await flush()
    expect(q('[role="alert"]')!.textContent).toContain('연결을 확인하고 다시 시도해 주세요')
    expect(host.textContent).toContain('내 노트')
    expect(alert()).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
    await click(byText('다시 시도'))
    await flush()
    expect(call).toHaveBeenCalledTimes(2)
    expect(q('[role="alert"]')).toBeNull()
  })

  test('each class has its own message; reauth offers [다시 로그인]', async () => {
    const signIn = vi.fn(async () => 'granted')
    const { store, call } = scripted([{ status: 'failed', errorClass: 'reauth' }, { status: 'ready' }], { signIn })
    mountLibrary(store)
    await flush()
    expect(q('[role="alert"]')!.textContent).toContain('다시 로그인해 주세요')
    await click(byText('다시 로그인'))
    await flush()
    expect(signIn).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)

    act(() => root.unmount())
    root = createRoot(host)
    const other = scripted([{ status: 'failed', errorClass: 'fatal' }])
    mountLibrary(other.store)
    await flush()
    expect(q('[role="alert"]')!.textContent).toContain('Drive를 준비하지 못했어요')
  })
})

describe('missing-root dialog', () => {
  test('title, button order, default focus on [새로 만들기], focus trapped, Esc = later', async () => {
    const { store } = scripted([{ status: 'missing' }])
    mountLibrary(store)
    await flush()
    expect(alert()!.textContent).toContain('Drive에서 Kkeujeok 폴더를 찾을 수 없어요')
    expect(labels()).toEqual(['새로 만들기', '나중에', '로그아웃'])
    const [create, later, out] = dialogButtons()
    expect(document.activeElement).toBe(create)
    act(() => out!.focus())
    key(out!, 'Tab')
    expect(document.activeElement).toBe(create) // wraps
    key(create!, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(out) // wraps back
    key(out!, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(later)
    key(later!, 'Escape')
    expect(alert()).toBeNull()
  })

  test('[나중에]: editing stays possible; the question returns when the tab is visible again', async () => {
    await seedNote()
    const { store } = scripted([{ status: 'missing' }])
    mountLibrary(store)
    await flush()
    await click(dialogButtons()[1]!)
    expect(alert()).toBeNull()
    expect(host.textContent).toContain('내 노트')
    expect(q('.fab-button')).not.toBeNull()
    setVisibility('visible')
    await flush()
    expect(alert()).not.toBeNull()
  })

  test('[새로 만들기] recreates; the dialog is gone and the indicator shows', async () => {
    let done!: (r: RootResult) => void
    const { store, recreate } = scripted([{ status: 'missing' }])
    recreate.mockImplementation(() => new Promise((r) => (done = r)))
    mountLibrary(store)
    await flush()
    await click(dialogButtons()[0]!)
    expect(recreate).toHaveBeenCalledTimes(1)
    expect(alert()).toBeNull()
    expect(host.textContent).toContain('Drive 준비 중')
    await act(async () => done({ status: 'ready', folderId: 'new' }))
    await flush()
    expect(host.textContent).not.toContain('Drive 준비 중')
  })

  test('[로그아웃] calls the sign-out only', async () => {
    await seedNote()
    const { store } = scripted([{ status: 'missing' }])
    const signOut = mountLibrary(store)
    await flush()
    await click(dialogButtons()[2]!)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  test('the dialog goes away by itself when the root turns out to exist again', async () => {
    const { store } = scripted([{ status: 'missing' }, { status: 'ready', folderId: 'r' }])
    mountLibrary(store)
    await flush()
    expect(alert()).not.toBeNull()
    setVisibility('visible')
    await flush()
    expect(alert()).toBeNull()
  })

  test('the new-note sheet covers the library: the question waits for it to close', async () => {
    const { store } = scripted([{ status: 'ready', folderId: 'r' }, { status: 'missing' }])
    mountLibrary(store)
    await flush()
    await click(q('.fab-button')!)
    await click(q('[role="menuitem"]')!)
    expect(q('[role="dialog"]')).not.toBeNull()
    setVisibility('visible') // the re-check finds it missing
    await flush()
    expect(alert()).toBeNull()
    key(document.activeElement!, 'Escape') // close the sheet
    await flush()
    expect(q('[role="dialog"]')).toBeNull()
    expect(alert()).not.toBeNull()
  })
})

describe('behind the app shell', () => {
  test('Settings covers the library: the question waits and is asked when the library is back', async () => {
    const { store } = scripted([{ status: 'missing' }])
    act(() =>
      root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(App, { auth: signedIn, root: store }))),
    )
    await flush()
    expect(alert()).not.toBeNull()
    await click(dialogButtons()[1]!) // later
    await click(q('nav button')!) // Settings
    setVisibility('visible')
    await flush()
    expect(alert()).toBeNull()
    await click(byText('닫기'))
    await flush()
    expect(alert()).not.toBeNull()
  })

  test('without a root store the library asks nothing', async () => {
    mountLibrary(undefined)
    await flush()
    expect(alert()).toBeNull()
    expect(host.textContent).not.toContain('Drive')
  })
})

describe('with the real service and a fake Drive', () => {
  test('first sign-in prepares one root; the notes are not touched', async () => {
    await seedNote()
    const drive = createFakeDrive()
    const log = createSyncLog()
    const account = { sub: 's1', email: 'a@x.com' }
    const ndb = openNoteDb()
    const service = createRootFolderService({
      client: drive,
      open: () => ({ device: createSyncDeviceStore(ndb), notes: openNoteStore(), close: () => {} }),
      log,
      account: () => account,
    })
    const store = createRootFolderStore({
      service,
      auth: { getState: () => ({ token: 't' }) as never, subscribe: () => () => {}, signIn: (async () => 'denied') as never },
    })
    mountLibrary(store)
    await flush()
    await flush()
    expect(store.getState().status).toBe('ready')
    expect(drive.roots()).toHaveLength(1)
    expect(alert()).toBeNull()
    expect(host.textContent).toContain('내 노트')
    ndb.close()
    log.close()
  })
})
