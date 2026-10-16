// @vitest-environment jsdom
// The tab-close warning (Story 3.16): only with unsent changes or a stroke being saved, never otherwise.
import { createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { registerOpenNote } from '../src/sync/openNotes'
import { unsentNow } from '../src/ui/sync/syncUi'
import { type Mounted, SyncUiProvider, fakeAuth, fakeNet, fakeStatus, mountUi, view } from './syncUiHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let m: Mounted | undefined
let offs: (() => void)[] = []
afterEach(() => {
  m?.unmount()
  m = undefined
  offs.forEach((f) => f())
  offs = []
})

function mount(status: ReturnType<typeof fakeStatus>) {
  m = mountUi(createElement(SyncUiProvider, { auth: fakeAuth() as never, status, net: fakeNet() }, createElement('div')))
}
function closeTab() {
  const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
  window.dispatchEvent(e)
  return e
}
const openNote = (unsaved?: () => boolean) =>
  offs.push(registerOpenNote('n1', { flush: async () => true, current: () => ({}) as never, applyMerge: () => ({}) as never, ...(unsaved && { unsaved }) }))

describe('beforeunload', () => {
  test('unsent changes: the browser asks', () => {
    mount(fakeStatus({ n1: view('pending') }))
    const e = closeTab()
    expect(e.defaultPrevented).toBe(true)
  })

  test('an error with unsent changes (quota, expired token) still asks', () => {
    mount(fakeStatus({ n1: view('error', { lastError: { class: 'quota' } }) }))
    expect(closeTab().defaultPrevented).toBe(true)
  })

  test('everything on Drive: it does not ask', () => {
    mount(fakeStatus({ n1: view('synced', { hasUnsent: false }), n2: view('synced', { hasUnsent: false }) }))
    const e = closeTab()
    expect(e.defaultPrevented).toBe(false)
  })

  test('no notes at all, or not read yet: it does not ask', () => {
    mount(fakeStatus({}, false))
    expect(closeTab().defaultPrevented).toBe(false)
  })

  test('a stroke being saved asks even when the store still says synced', () => {
    mount(fakeStatus({ n1: view('synced', { hasUnsent: false }) }))
    openNote(() => true)
    expect(closeTab().defaultPrevented).toBe(true)
  })

  test('an open note with nothing unsaved does not ask', () => {
    mount(fakeStatus({ n1: view('synced', { hasUnsent: false }) }))
    openNote(() => false)
    expect(closeTab().defaultPrevented).toBe(false)
  })

  test('an open note that cannot say is not a reason to ask', () => {
    mount(fakeStatus({ n1: view('synced', { hasUnsent: false }) }))
    openNote()
    expect(closeTab().defaultPrevented).toBe(false)
  })

  test('the answer follows the store as it changes', () => {
    const s = fakeStatus({ n1: view('pending') })
    mount(s)
    expect(closeTab().defaultPrevented).toBe(true)
    s.set({ n1: view('synced', { hasUnsent: false }) })
    expect(closeTab().defaultPrevented).toBe(false)
    s.set({ n1: view('pending') })
    expect(closeTab().defaultPrevented).toBe(true)
  })

  test('the shell going away removes the listener', () => {
    mount(fakeStatus({ n1: view('pending') }))
    m!.unmount()
    expect(closeTab().defaultPrevented).toBe(false)
  })

  test('one listener per provider, however often it renders', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const s = fakeStatus({ n1: view('pending') })
    mount(s)
    s.set({ n1: view('syncing') })
    s.set({ n1: view('pending') })
    expect(add.mock.calls.filter((c) => c[0] === 'beforeunload')).toHaveLength(1)
    add.mockRestore()
  })

  test('unsentNow is the same question without the browser', () => {
    expect(unsentNow({ anyUnsent: () => false })).toBe(false)
    expect(unsentNow({ anyUnsent: () => true })).toBe(true)
  })
})

describe('refreshes', () => {
  test('the store is read at start, when the tab is visible again and when the connection is back', () => {
    const s = fakeStatus({})
    mount(s)
    expect(s.refreshAll).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(s.refreshAll).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(s.refreshAll).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('online'))
    expect(s.refreshAll).toHaveBeenCalledTimes(3)
    m!.unmount()
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(s.refreshAll).toHaveBeenCalledTimes(3)
  })
})
