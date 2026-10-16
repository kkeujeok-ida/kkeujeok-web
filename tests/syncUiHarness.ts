// Shared pieces of the sync display tests (Story 3.16): a status store the test drives by
// hand, an auth stand-in, a connection stand-in, and a mounted provider.
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import type { NoteSyncView, SyncStatus } from '../src/sync/syncStatus'
import { SyncUiProvider } from '../src/ui/sync/syncUi'

export const view = (state: NoteSyncView['state'], o: Partial<NoteSyncView> = {}): NoteSyncView => ({
  state,
  hasUnsent: state !== 'synced',
  lastError: null,
  ...o,
})

export function fakeStatus(initial: Record<string, NoteSyncView> = {}, loaded = true) {
  let snap = { version: 0, loaded, notes: new Map(Object.entries(initial)) as ReadonlyMap<string, NoteSyncView> }
  const listeners = new Set<() => void>()
  const api = {
    getSnapshot: () => snap,
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    refreshAll: vi.fn(async () => {}),
    anyUnsent: () => [...snap.notes.values()].some((v) => v.hasUnsent),
    dispose: vi.fn(),
    listenerCount: () => listeners.size,
    set(notes: Record<string, NoteSyncView>, isLoaded = true) {
      snap = { version: snap.version + 1, loaded: isLoaded, notes: new Map(Object.entries(notes)) }
      act(() => listeners.forEach((fn) => fn()))
    },
  }
  return api as typeof api & SyncStatus
}

export function fakeNet(offline = false) {
  let state = { offline }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    set(next: boolean) {
      state = { offline: next }
      act(() => listeners.forEach((fn) => fn()))
    },
  }
}

export function fakeAuth(o: { expired?: boolean; sub?: string | null; reauth?: () => Promise<'granted' | 'cancelled' | 'denied' | 'network'> } = {}) {
  let state = { token: 't', account: o.sub === null ? null : { sub: o.sub ?? 's1', email: 'a@x.com' }, notice: null, busy: false, expired: o.expired ?? false }
  const listeners = new Set<() => void>()
  const api = {
    getState: () => state,
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    reauth: vi.fn(o.reauth ?? (async () => 'granted' as const)),
    set(p: Partial<typeof state>) {
      state = { ...state, ...p }
      act(() => listeners.forEach((fn) => fn()))
    },
  }
  return api
}

export function i18nFor(lang: 'ko' | 'en') {
  return createI18n({ navigatorLanguage: lang, storage: { getItem: () => lang, setItem: () => {} } })
}

export type Mounted = { host: HTMLElement; root: Root; render: (node: ReactNode) => void; unmount: () => void; q: <T extends Element = HTMLElement>(s: string) => T | null; qa: <T extends Element = HTMLElement>(s: string) => T[] }

export function mountUi(node: ReactNode, lang: 'ko' | 'en' = 'ko'): Mounted {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor(lang) }, node)))
  let gone = false
  return {
    host,
    root,
    render: (n) => act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor(lang) }, n))),
    unmount() {
      if (gone) return
      gone = true
      act(() => root.unmount())
      host.remove()
    },
    q: (s) => host.querySelector(s),
    qa: (s) => [...host.querySelectorAll(s)] as never,
  }
}

export { SyncUiProvider }
export const sleep = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
export const tick = () => act(async () => void (await Promise.resolve()))
