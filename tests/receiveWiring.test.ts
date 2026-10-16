// @vitest-environment jsdom
// The receive triggers (load, tab visible, online, the 20,000 ms poll, Web Locks) with a
// stub receiver, and the receive UI through the real shell: remote cards, the ↓ badge,
// the scan placeholder, the wait before a note opens.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type RootResult } from '../src/drive/rootFolder'
import { createRootFolderStore } from '../src/drive/rootFolderStore'
import { I18nContext, createI18n } from '../src/i18n'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { KICK_THROTTLE_MS, POLL_LOCK, POLL_MS, RECEIVE_LOCK, attachReceiveTriggers } from '../src/sync/receiveWiring'
import { SYNC_LOG_DB } from '../src/sync/syncLog'
import { App } from '../src/ui/App'
import { Library, SCAN_PLACEHOLDER_MS } from '../src/ui/library/Library'
import { fakeLocks, signedIn } from './helpers'
import { type RxEnv, makeRxEnv } from './receiveHarness'
import { NID, PA, PB, foreignEdit, mkNote } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true })
HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never

// ---------------------------------------------------------------- triggers
function fakeDoc() {
  const t = new EventTarget() as EventTarget & { visibilityState: string }
  t.visibilityState = 'visible'
  return t
}
function rootStub(ready: boolean) {
  let status = ready ? 'ready' : 'idle'
  const ls = new Set<() => void>()
  return {
    r: { getState: () => ({ status }) as never, subscribe: (f: () => void) => (ls.add(f), () => void ls.delete(f)) },
    set: (s: string) => ((status = s), ls.forEach((f) => f())),
    ls,
  }
}
function manualTimers() {
  const list: { fn: () => void; ms: number; live: boolean }[] = []
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true }
      list.push(t)
      return () => void (t.live = false)
    },
    /** Runs every timer that is set now once. */
    fire() {
      for (const t of list.filter((x) => x.live)) {
        t.live = false
        t.fn()
      }
    },
    live: () => list.filter((t) => t.live),
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('attachReceiveTriggers', () => {
  function setup(o: { ready?: boolean; locks?: LockManager | undefined; doc?: ReturnType<typeof fakeDoc>; clock?: { t: number }; receiver?: { check: () => Promise<void> } } = {}) {
    const receiver = o.receiver ?? { check: vi.fn(async () => {}) }
    const doc = o.doc ?? fakeDoc()
    const win = new EventTarget()
    const root = rootStub(o.ready ?? true)
    const timers = manualTimers()
    const clock = o.clock ?? { t: 1_000_000 }
    const off = attachReceiveTriggers(receiver, root.r, {
      doc: doc as never,
      win: win as never,
      ...('locks' in o ? { locks: o.locks } : { locks: undefined }),
      now: () => clock.t,
      setTimer: timers.setTimer,
    })
    return { receiver, doc, win, root, timers, clock, off }
  }
  const hide = (doc: ReturnType<typeof fakeDoc>, v: 'visible' | 'hidden') => {
    doc.visibilityState = v
    doc.dispatchEvent(new Event('visibilitychange'))
  }

  test('a ready root checks at once; one that becomes ready later checks then, once', async () => {
    const a = setup({ ready: true })
    await tick()
    expect(a.receiver.check).toHaveBeenCalledTimes(1)
    const b = setup({ ready: false })
    await tick()
    expect(b.receiver.check).not.toHaveBeenCalled()
    b.root.set('ready')
    b.root.set('ready')
    await tick()
    expect(b.receiver.check).toHaveBeenCalledTimes(1)
    a.off()
    b.off()
  })

  test('the tab becoming visible checks at once, throttled; hidden does not check', async () => {
    const s = setup()
    await tick()
    hide(s.doc, 'hidden')
    hide(s.doc, 'visible') // closer than the throttle to the load check: skipped
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(1)
    s.clock.t += KICK_THROTTLE_MS
    hide(s.doc, 'hidden')
    hide(s.doc, 'visible')
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(2)
    s.off()
  })

  test('online checks (throttled)', async () => {
    const s = setup()
    await tick()
    s.clock.t += KICK_THROTTLE_MS
    s.win.dispatchEvent(new Event('online'))
    s.win.dispatchEvent(new Event('online'))
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(2)
    s.off()
  })

  test('while visible every 20,000 ms; hidden stops the timer; visible starts it again', async () => {
    const s = setup()
    await tick()
    expect(s.timers.live().map((t) => t.ms)).toEqual([POLL_MS])
    s.timers.fire()
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(2)
    expect(s.timers.live()).toHaveLength(1) // the next period is set
    s.timers.fire()
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(3)
    hide(s.doc, 'hidden')
    expect(s.timers.live()).toHaveLength(0)
    s.timers.fire()
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(3) // hidden: no poll
    s.clock.t += KICK_THROTTLE_MS
    hide(s.doc, 'visible')
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(4)
    expect(s.timers.live()).toHaveLength(1)
    s.off()
  })

  test('a tab that starts hidden does nothing until it is visible', async () => {
    const doc = fakeDoc()
    doc.visibilityState = 'hidden'
    const s = setup({ doc })
    await tick()
    expect(s.receiver.check).not.toHaveBeenCalled()
    expect(s.timers.live()).toHaveLength(0)
    hide(doc, 'visible')
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(1)
    s.off()
  })

  test('cleanup removes the listeners, the timers and the root subscription', async () => {
    const s = setup({ ready: false })
    s.off()
    expect(s.root.ls.size).toBe(0)
    s.root.set('ready')
    hide(s.doc, 'hidden')
    hide(s.doc, 'visible')
    s.win.dispatchEvent(new Event('online'))
    await tick()
    expect(s.receiver.check).not.toHaveBeenCalled()
    const t = setup()
    await tick()
    t.off()
    expect(t.timers.live()).toHaveLength(0)
    t.timers.fire()
    await tick()
    expect(t.receiver.check).toHaveBeenCalledTimes(1)
  })

  test('a timer that fires after cleanup (cancel came too late) checks nothing', async () => {
    const check = vi.fn(async () => {})
    const fns: (() => void)[] = []
    const off = attachReceiveTriggers({ check }, rootStub(true).r, {
      doc: fakeDoc() as never,
      win: new EventTarget() as never,
      locks: undefined,
      setTimer: (fn) => (fns.push(fn), () => {}),
    })
    await tick()
    off()
    fns.forEach((f) => f())
    await tick()
    expect(check).toHaveBeenCalledTimes(1)
  })

  test('a check that throws is swallowed and the poll goes on', async () => {
    const check = vi.fn(async () => {
      throw new Error('boom')
    })
    const s = setup({ receiver: { check } })
    await tick()
    s.timers.fire()
    await tick()
    expect(check).toHaveBeenCalledTimes(2)
    s.off()
  })

  test('two tabs: a check another tab is running is skipped; only the lock holder polls; the other takes over', async () => {
    const locks = fakeLocks()
    let release!: () => void
    const busy = new Promise<void>((r) => (release = r))
    const a = setup({ locks, receiver: { check: vi.fn(() => busy) } })
    const b = setup({ locks })
    await tick()
    expect(a.receiver.check).toHaveBeenCalledTimes(1)
    expect(b.receiver.check).not.toHaveBeenCalled() // A's check holds kkeujeok-receive
    expect(a.timers.live().map((t) => t.ms)).toEqual([POLL_MS]) // A leads
    expect(b.timers.live().map((t) => t.ms)).toEqual([POLL_MS]) // B only retries leadership
    release()
    await tick()
    b.timers.fire() // B's retry: the poll lock is A's
    await tick()
    expect(b.receiver.check).not.toHaveBeenCalled()
    a.timers.fire()
    await tick()
    expect(a.receiver.check).toHaveBeenCalledTimes(2)
    hide(a.doc, 'hidden') // A lets go
    await tick()
    b.timers.fire()
    await tick()
    expect(b.timers.live().map((t) => t.ms)).toEqual([POLL_MS]) // B leads now
    b.timers.fire()
    await tick()
    expect(b.receiver.check).toHaveBeenCalled()
    a.off()
    b.off()
    void RECEIVE_LOCK
    void POLL_LOCK
  })

  test('without the Web Locks API the tab checks and polls on its own', async () => {
    const s = setup({ locks: undefined })
    await tick()
    expect(s.receiver.check).toHaveBeenCalledTimes(1)
    expect(s.timers.live()).toHaveLength(1)
    s.off()
  })
})

// ---------------------------------------------------------------- UI
let host: HTMLElement
let root: Root
let env: RxEnv
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const flush = async () => {
  await settle()
  await settle()
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
const i18n = () => createI18n({ navigatorLanguage: 'ko-KR', storage: { getItem: () => null, setItem: () => {} } })
const rootStore = () =>
  createRootFolderStore({
    service: { checkRoot: vi.fn(async () => ({ status: 'ready', folderId: 'ROOT' }) as RootResult), recreate: vi.fn() as never },
    auth: { getState: () => ({ token: 't' }) as never, subscribe: () => () => {}, signIn: (async () => 'denied') as never },
    throttleMs: 0,
  })

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  location.hash = ''
  clearSessionHistories()
})
afterEach(async () => {
  vi.useRealTimers()
  act(() => root.unmount())
  await savesSettled()
  host.remove()
  env?.close()
  await deleteNoteDatabase()
  await new Promise<void>((r) => {
    const x = indexedDB.deleteDatabase(SYNC_LOG_DB)
    x.onsuccess = x.onerror = () => r()
  })
})

async function mountApp(o: { receiver?: unknown } = {}) {
  const store = rootStore()
  await store.check()
  const receiver = (o.receiver ?? env.receiver) as never
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(App, { auth: signedIn, root: store, receiver }))))
  await flush()
  await flush()
}
const cardTitles = () => [...host.querySelectorAll('.cover-title')].map((e) => e.textContent)

describe('the library', () => {
  test('page load: the first check draws a remote card from the summary, no note is downloaded', async () => {
    env = await makeRxEnv()
    await env.remoteUpload(mkNote({ title: '다른 기기 노트' }))
    await mountApp()
    expect(cardTitles()).toEqual(['다른 기기 노트'])
    expect(env.drive.count('downloadRevision')).toBe(0)
    expect(q('.cover-badge')).toBeNull()
    expect(q('a.cover-card')!.getAttribute('href')).toBe(`#/notes/${NID}`)
  })

  test('a changed note shows the ↓ 받는 중 badge while it is received, and not after', async () => {
    env = await makeRxEnv()
    const note = mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
    const { fileId } = await env.seedSynced(note)
    await mountApp()
    expect(q('.cover-badge')).toBeNull()
    await env.remoteUpload(foreignEdit(note, PB, 'b2'), { fileId })
    let during: string | null | undefined
    env.drive.hooks.beforeCall = (m) => {
      if (m === 'downloadRevision') during = q('.cover-badge')?.textContent
    }
    await act(async () => void (await env.receiver.check()))
    await flush()
    expect(during).toBe('받는 중')
    expect(q('.cover-badge')).toBeNull()
  })

  test('another tab changed the notes: the library reloads from IndexedDB', async () => {
    env = await makeRxEnv()
    await mountApp()
    expect(cardTitles()).toEqual(['새 노트']) // the empty library's own card
    await env.store.remote.put({ noteId: NID, fileId: 'f', headRevisionId: 'r1', title: '새 카드', folderId: null, coverId: null, modifiedAt: '2026-10-10T04:20:00.000Z' })
    await act(async () => void (await env.receiver.onMessage({ t: 'changed' })))
    await flush()
    expect(cardTitles()).toEqual(['새 카드'])
  })

  test('the scan placeholder shows only after 1,000 ms and goes with the scan', async () => {
    vi.useFakeTimers()
    const ls = new Set<() => void>()
    let state = { version: 0, receiving: new Set<string>(), scanning: true }
    const scan = (scanning: boolean) => {
      state = { ...state, scanning } // a new snapshot, as the receiver makes
      act(() => ls.forEach((f) => f()))
    }
    const receiver = {
      getState: () => state,
      subscribe: (f: () => void) => (ls.add(f), () => void ls.delete(f)),
    }
    const store = openNoteStore()
    act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(Library, { openStore: () => store, receiver }))))
    await act(async () => void (await vi.advanceTimersByTimeAsync(SCAN_PLACEHOLDER_MS - 1)))
    expect(host.querySelectorAll('.cover-card-placeholder')).toHaveLength(0)
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)))
    expect(host.querySelectorAll('.cover-card-placeholder')).toHaveLength(3)
    expect(q('.cover-card-placeholder')!.closest('li')!.getAttribute('aria-hidden')).toBe('true')
    scan(false)
    expect(host.querySelectorAll('.cover-card-placeholder')).toHaveLength(0)
    // a scan that ends before the second shows nothing
    scan(true)
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)))
    scan(false)
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)))
    expect(host.querySelectorAll('.cover-card-placeholder')).toHaveLength(0)
    store.close()
  })
})

const IDLE_STATE = { version: 0, receiving: new Set<string>(), scanning: false }
describe('opening a note', () => {
  function stubReceiver() {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    return {
      release,
      beforeOpen: vi.fn(() => gate),
      noteOpened: vi.fn(async () => {}),
      getState: () => IDLE_STATE,
      subscribe: () => () => {},
      check: vi.fn(async () => {}),
    }
  }

  test('the editor waits for the receive; "최신 내용 받는 중" shows after 1,000 ms; then the editor opens and the remote head is asked once', async () => {
    env = await makeRxEnv()
    await env.store.writeNote(mkNote())
    const stub = stubReceiver()
    await mountApp({ receiver: stub })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    location.hash = `#/notes/${NID}`
    await act(async () => void (await vi.advanceTimersByTimeAsync(900)))
    expect(q('.editor')!.getAttribute('aria-busy')).toBe('true')
    expect(q('.editor')!.textContent).toContain('불러오는 중')
    expect(q('canvas.editor-canvas')).toBeNull()
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)))
    expect(q('.editor')!.textContent).toContain('최신 내용 받는 중')
    expect(stub.noteOpened).not.toHaveBeenCalled()
    vi.useRealTimers()
    stub.release()
    await flush()
    await flush()
    expect(q('canvas.editor-canvas')).not.toBeNull()
    expect(stub.beforeOpen).toHaveBeenCalledWith(NID)
    expect(stub.noteOpened).toHaveBeenCalledTimes(1)
    expect(stub.noteOpened).toHaveBeenCalledWith(NID)
  })

  test('a receive that fails opens the device copy', async () => {
    env = await makeRxEnv()
    await env.store.writeNote(mkNote())
    const stub = stubReceiver()
    stub.beforeOpen.mockRejectedValue(new Error('offline'))
    await mountApp({ receiver: stub })
    location.hash = `#/notes/${NID}`
    await flush()
    await flush()
    expect(q('canvas.editor-canvas')).not.toBeNull()
  })

  test('leaving while it waits: nothing is shown or asked afterwards', async () => {
    env = await makeRxEnv()
    await env.store.writeNote(mkNote())
    const stub = stubReceiver()
    await mountApp({ receiver: stub })
    location.hash = `#/notes/${NID}`
    await flush()
    location.hash = ''
    await flush()
    stub.release()
    await flush()
    await flush()
    expect(q('canvas.editor-canvas')).toBeNull()
    expect(stub.noteOpened).not.toHaveBeenCalled()
  })

  test('a remote card opens after its download (the real receiver)', async () => {
    env = await makeRxEnv()
    await env.remoteUpload(mkNote({ title: '카드 노트' }))
    await mountApp()
    expect(cardTitles()).toEqual(['카드 노트'])
    location.hash = `#/notes/${NID}`
    await flush()
    await flush()
    await flush()
    expect(env.drive.count('downloadRevision')).toBe(1)
    expect(q('canvas.editor-canvas')).not.toBeNull()
    expect(await env.store.remote.get(NID)).toBeNull()
  })

  test('a card whose download fails goes back to the library', async () => {
    env = await makeRxEnv()
    await env.remoteUpload(mkNote({ title: '카드 노트' }))
    await mountApp()
    env.drive.failAlways('downloadRevision', new (await import('../src/drive/driveClient')).DriveError('http', 404, 'notFound'))
    location.hash = `#/notes/${NID}`
    await flush()
    await flush()
    await flush()
    expect(q('canvas.editor-canvas')).toBeNull()
    expect(location.hash).toBe('#/')
    expect(cardTitles()).toEqual(['카드 노트'])
  })
})

test('logout cleans up: no store is reopened by a library that was left (db deleted stays deleted)', async () => {
  env = await makeRxEnv()
  await mountApp()
  act(() => root.unmount())
  await deleteNoteDatabase()
  await flush()
  expect((await indexedDB.databases()).some((d) => d.name === 'kkeujeok-notes')).toBe(false)
  void openNoteDb
  root = createRoot(host)
})
