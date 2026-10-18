// @vitest-environment jsdom
// The uploads as the person triggers them: close the note, hide the tab, connection
// back, page load - through the real shell, editor, coordinator and uploader over
// the fake Drive. Nothing runs after unmount.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type RootResult } from '../src/drive/rootFolder'
import { createRootFolderStore, uploadsAllowed } from '../src/drive/rootFolderStore'
import { I18nContext, createI18n } from '../src/i18n'
import { decodeKkj } from '../src/model/kkjCodec'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { savesSettled } from '../src/storage/saveQueue'
import { getOpenNote, openNoteIds } from '../src/sync/openNotes'
import { connectivity } from '../src/drive/connectivity'
import { type Versions, createVersionRestorer, createVersionSource } from '../src/sync/versionHistory'
import { attachUploadTriggers, defaultVersions } from '../src/sync/uploadWiring'
import { createUploadCoordinator } from '../src/sync/uploadCoordinator'
import { SYNC_LOG_DB } from '../src/sync/syncLog'
import { App } from '../src/ui/App'
import { signedIn } from './helpers'
import { type Env, NID, makeEnv, mkNote } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has neither Path2D nor a canvas.
class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true })
HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never

let host: HTMLElement
let root: Root
let env: Env
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const flush = async () => {
  await settle()
  await settle()
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
const click = (el: Element) => act(() => (el as HTMLElement).click())
const canvas = () => q<HTMLCanvasElement>('canvas.editor-canvas')!
let clock = 1000
const fire = (name: string, x: number, y: number) =>
  act(() => {
    const e = new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', clientX: x, clientY: y, pressure: 0.5, button: 0, buttons: 1 })
    Object.defineProperty(e, 'timeStamp', { value: (clock += 10) })
    canvas().dispatchEvent(e)
  })
const stroke = () => {
  fire('pointerdown', 100, 100)
  fire('pointermove', 140, 120)
  fire('pointerup', 180, 100)
}
const setVisibility = (v: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
}
const i18n = () => createI18n({ navigatorLanguage: 'ko-KR', storage: { getItem: () => null, setItem: () => {} } })

function rootStore() {
  const call = vi.fn(async () => ({ status: 'ready', folderId: 'ROOT' }) as RootResult)
  const store = createRootFolderStore({
    service: { checkRoot: call, recreate: call },
    auth: { getState: () => ({ token: 't' }) as never, subscribe: () => () => {}, signIn: (async () => 'denied') as never },
    throttleMs: 0,
  })
  return store
}

async function mountApp(seed = true) {
  const store = rootStore()
  env = await makeEnv({ allowed: () => uploadsAllowed(store) })
  if (seed) await env.store.writeNote(mkNote())
  const uploads = createUploadCoordinator({
    store: env.store,
    uploader: env.uploader,
    log: env.deps.log,
    allowed: () => uploadsAllowed(store),
    online: () => true,
    flushOpen: async () => void (await Promise.all(openNoteIds().map((id) => getOpenNote(id)?.flush()))),
    locks: undefined,
  })
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(App, { auth: signedIn, root: store, uploads }))))
  await flush()
  await flush()
  return { store, uploads }
}
const files = () => env.drive.byKkeujeokId(NID)
const revCount = () => files()[0]?.revs.length ?? 0
const strokesInHead = async () => {
  const note = (await decodeKkj(files()[0]!.revs.at(-1)!.bytes)).note!
  return note.pages[0]!.elements.length
}
const openEditor = async () => {
  location.hash = `#/notes/${NID}`
  await flush()
  await flush()
  expect(canvas()).not.toBeNull()
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  location.hash = ''
  clearSessionHistories()
})
afterEach(async () => {
  act(() => root.unmount())
  await savesSettled()
  host.remove()
  env?.close()
  await deleteNoteDatabase()
  await new Promise<void>((r) => {
    const x = indexedDB.deleteDatabase(SYNC_LOG_DB)
    x.onsuccess = x.onerror = () => r()
  })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

describe('triggers through the app', () => {
  test('page load: the unsent closed note is uploaded as soon as the root folder is ready', async () => {
    await mountApp()
    expect(revCount()).toBe(1)
    expect((await env.sync()).info.state).toBe('synced')
  })

  test('closing the note uploads it, with the last stroke; an idle open note is not uploaded', async () => {
    await mountApp()
    await openEditor()
    stroke()
    await flush()
    await flush()
    expect(revCount()).toBe(1) // open and idle: nothing goes
    click(q('.editor-back')!)
    await flush()
    await flush()
    await flush()
    expect(q('.editor')).toBeNull()
    expect(revCount()).toBe(2)
    expect(await strokesInHead()).toBe(1) // the last editor save was on disk before the upload read it
    expect((await env.sync()).info.state).toBe('synced')
  })

  test('the tab being hidden uploads the open note; the editor stays; the next edits go on the next trigger', async () => {
    await mountApp()
    await openEditor()
    stroke()
    setVisibility('hidden')
    await flush()
    await flush()
    expect(revCount()).toBe(2)
    expect(await strokesInHead()).toBe(1)
    expect(canvas()).not.toBeNull()
    setVisibility('visible')
    stroke()
    await flush()
    expect(revCount()).toBe(2) // visible again: no upload
    click(q('.editor-back')!)
    await flush()
    await flush()
    await flush()
    expect(revCount()).toBe(3)
    expect(await strokesInHead()).toBe(2)
  })

  test('pagehide uploads like a hidden tab', async () => {
    await mountApp()
    await openEditor()
    stroke()
    act(() => void window.dispatchEvent(new Event('pagehide')))
    await flush()
    await flush()
    expect(revCount()).toBe(2)
  })

  test('the connection coming back uploads closed unsent notes, not the open one', async () => {
    await mountApp()
    await openEditor()
    stroke()
    await flush()
    const other = '01926f3a-0000-7000-8000-0000000000a9'
    await env.store.writeNote(mkNote({ noteId: other, title: '다른 노트' }))
    act(() => void window.dispatchEvent(new Event('online')))
    await flush()
    await flush()
    expect(env.drive.byKkeujeokId(other)).toHaveLength(1)
    expect(revCount()).toBe(1) // the open note waits until it is closed
  })

  test('after unmount no event uploads anything', async () => {
    await mountApp()
    await openEditor()
    stroke()
    await flush()
    act(() => root.unmount()) // unmounting the editor closes the note: that upload is legitimate
    await savesSettled()
    await flush()
    expect(revCount()).toBe(2)
    const calls = env.drive.calls.length
    setVisibility('hidden')
    act(() => void window.dispatchEvent(new Event('pagehide')))
    act(() => void window.dispatchEvent(new Event('online')))
    await flush()
    expect(env.drive.calls.length).toBe(calls)
    root = createRoot(host) // for afterEach
  })
})

describe('defaultVersions (Story 3.25)', () => {
  const uploads = { noteClosed: async () => {} } as never
  test('returns the source, the restorer and a probe; the probe follows navigator.onLine and the connectivity; one instance per coordinator', async () => {
    const v = defaultVersions(signedIn as never, uploads)
    expect(Object.keys(v).sort()).toEqual(['probe', 'restorer', 'source'])
    expect(typeof v.restorer.restore).toBe('function')
    expect(typeof v.source.load).toBe('function')
    expect(defaultVersions(signedIn as never, uploads)).toBe(v) // no second store connection
    expect(await v.probe()).toBe(true)
    connectivity().networkFailed()
    expect(await v.probe()).toBe(false)
    connectivity().networkOk()
    expect(await v.probe()).toBe(true)
    const nav = vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await v.probe()).toBe(false)
    nav.mockRestore()
  })

  test('the app offers [버전 기록] in the editor menu when it has the feature', async () => {
    const store = rootStore()
    env = await makeEnv({ allowed: () => uploadsAllowed(store) })
    await env.store.writeNote(mkNote())
    const source = createVersionSource(env.drive)
    const versions: Versions = {
      source,
      restorer: createVersionRestorer({ drive: env.drive, store: env.store, coordinator: {} as never, source, editedBy: () => 'x' }),
      probe: async () => true,
    }
    act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(App, { auth: signedIn, root: store, syncUi: { versions } }))))
    await flush()
    location.hash = `#/notes/${NID}`
    await flush()
    await flush()
    click(q('button[aria-label="더 보기"]')!)
    expect([...host.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent)).toContain('버전 기록')
  })
})

describe('attachUploadTriggers', () => {
  function stubs(ready = false) {
    const c = { hidden: vi.fn(async () => {}), unsent: vi.fn(async () => {}), rootReady: vi.fn(async () => {}) }
    let status = ready ? 'ready' : 'idle'
    const listeners = new Set<() => void>()
    const r = {
      getState: () => ({ status }) as never,
      subscribe: (f: () => void) => (listeners.add(f), () => void listeners.delete(f)),
    }
    return { c, r, setStatus: (s: string) => ((status = s), listeners.forEach((f) => f())), listeners }
  }

  test('each event calls its trigger; cleanup removes every listener', () => {
    const { c, r, setStatus, listeners } = stubs()
    const off = attachUploadTriggers(c, r)
    setVisibility('hidden')
    expect(c.hidden).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    expect(c.hidden).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('pagehide'))
    expect(c.hidden).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('online'))
    expect(c.unsent).toHaveBeenCalledTimes(1)
    setStatus('ready')
    expect(c.rootReady).toHaveBeenCalledTimes(1)
    setStatus('ready') // no new transition
    expect(c.rootReady).toHaveBeenCalledTimes(1)
    off()
    expect(listeners.size).toBe(0)
    setVisibility('hidden')
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('online'))
    setStatus('idle')
    setStatus('ready')
    expect(c.hidden).toHaveBeenCalledTimes(2)
    expect(c.unsent).toHaveBeenCalledTimes(1)
    expect(c.rootReady).toHaveBeenCalledTimes(1)
  })

  test('a root that is already ready starts at once', () => {
    const { c, r } = stubs(true)
    const off = attachUploadTriggers(c, r)
    expect(c.rootReady).toHaveBeenCalledTimes(1)
    off()
  })
})
