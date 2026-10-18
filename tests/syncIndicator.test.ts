// @vitest-environment jsdom
// The sync indicator of the writing screen: labels from the state machine rule, the timing of
// "syncing", announcements, and the popover with its actions (Story 3.16).
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resources } from '../src/i18n'
import { displayRule } from '../src/sync/syncRules'
import { SyncIndicator } from '../src/ui/sync/SyncIndicator'
import { ANNOUNCE_GAP_MS, SAVING_MIN_MS } from '../src/ui/sync/useDisplayLabel'
import { type Mounted, SyncUiProvider, fakeAuth, fakeNet, fakeStatus, mountUi, view } from './syncUiHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const N = 'n1'
let m: Mounted | undefined
let downloads: string[]
beforeEach(() => {
  downloads = []
  URL.createObjectURL = () => 'blob:x'
  URL.revokeObjectURL = () => {}
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download)
  })
})
afterEach(() => {
  m?.unmount()
  m = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Opts = {
  lang?: 'ko' | 'en'
  uploads?: { syncNow: (id: string) => Promise<void>; resume?: () => Promise<void> }
  receiving?: boolean
  expired?: boolean
  exportLog?: () => Promise<{ name: string; text: string }>
}
function mount(status: ReturnType<typeof fakeStatus>, o: Opts = {}) {
  const receiving = new Set<string>(o.receiving ? [N] : [])
  const state = { version: 0, receiving, scanning: false }
  const receiver = { subscribe: () => () => {}, getState: () => state }
  m = mountUi(
    createElement(
      SyncUiProvider,
      {
        auth: fakeAuth({ expired: o.expired }) as never,
        status,
        net: fakeNet(),
        receiver,
        uploads: o.uploads ?? { syncNow: vi.fn(async () => {}) },
        exportLog: o.exportLog ?? (async () => ({ name: 'log.jsonl', text: '{}\n' })),
      },
      createElement(SyncIndicator, { noteId: N }),
    ),
    o.lang ?? 'ko',
  )
  return m
}
const button = () => m!.q<HTMLButtonElement>('.sync-indicator-button')!
const name = () => button().getAttribute('aria-label')
const text = (b: HTMLElement) => b.textContent!.trim()
const btn = (label: string) => m!.qa<HTMLButtonElement>('.sync-popover button, .sync-popover a').find((b) => text(b) === label)

describe('names and labels', () => {
  test.each([
    ['synced', '저장됨', 'Saved'],
    ['pending', '저장 대기', 'Waiting to save'],
    ['conflict', '두 버전', 'Two versions'],
    ['error', '저장 안 됨', 'Not saved'],
  ] as const)('%s: icon-only button with the label in its name and tooltip, ko and en', (state, ko, en) => {
    mount(fakeStatus({ [N]: view(state) }))
    expect(name()).toBe(`동기화 상태: ${ko}. 자세히 보기`)
    expect(button().title).toBe(ko)
    expect(text(button())).toBe('') // no visible text
    expect(button().querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    m!.unmount()
    mount(fakeStatus({ [N]: view(state) }), { lang: 'en' })
    expect(name()).toBe(`Sync status: ${en}. Show details`)
  })

  test('the label is the one of the state machine rule, never offline', () => {
    for (const state of ['synced', 'pending', 'conflict', 'error'] as const) {
      const r = displayRule({ state, platform: 'web', online: false }) as { label: string }
      expect(r.label).not.toBe('offline')
    }
    mount(fakeStatus({ [N]: view('pending') }))
    expect(button().className).toContain('sync-pending')
  })

  test('a note being received reads "최신 내용 받는 중"', () => {
    mount(fakeStatus({ [N]: view('synced') }), { receiving: true })
    expect(name()).toBe('동기화 상태: 최신 내용 받는 중. 자세히 보기')
  })

  test('an expired token shows a pending note as not saved', () => {
    mount(fakeStatus({ [N]: view('pending') }), { expired: true })
    expect(name()).toContain('저장 안 됨')
  })

  test('nothing until the note is known', () => {
    mount(fakeStatus({}, false))
    expect(m!.q('.sync-indicator')).toBeNull()
  })

  test('ko and en have every key the indicator uses', () => {
    for (const k of Object.keys(resources.ko).filter((x) => x.startsWith('sync.') || x.startsWith('banner.'))) {
      expect(resources.en).toHaveProperty(k)
    }
  })
})

describe('syncing is drawn at once and held', () => {
  beforeEach(() => void vi.useFakeTimers())
  const adv = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

  test('"동기화 중" is drawn as soon as the note syncs, with a spinner', () => {
    const s = fakeStatus({ [N]: view('pending') })
    mount(s)
    s.set({ [N]: view('syncing') })
    expect(name()).toContain('동기화 중')
    expect(button().querySelector('svg')!.getAttribute('class')).toContain('sync-spin')
  })

  test('a very short sync stays visible for the minimum time, then reads saved', () => {
    const s = fakeStatus({ [N]: view('pending') })
    mount(s)
    s.set({ [N]: view('syncing') })
    adv(50)
    s.set({ [N]: view('synced', { hasUnsent: false }) })
    adv(SAVING_MIN_MS - 51)
    expect(name()).toContain('동기화 중')
    adv(1)
    expect(name()).toContain('저장됨')
  })

  test('once drawn it stays the minimum time from when it was drawn', () => {
    const s = fakeStatus({ [N]: view('pending') })
    mount(s)
    s.set({ [N]: view('syncing') })
    adv(SAVING_MIN_MS + 100)
    s.set({ [N]: view('synced', { hasUnsent: false }) })
    adv(1)
    expect(name()).toContain('저장됨')
  })

  test('unmounting leaves no timer', () => {
    const s = fakeStatus({ [N]: view('pending') })
    mount(s)
    s.set({ [N]: view('syncing') })
    m!.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('announcements', () => {
  beforeEach(() => void vi.useFakeTimers())
  const adv = (ms: number) => act(() => void vi.advanceTimersByTime(ms))
  const polite = () => m!.q('.sync-indicator [role="status"]')!.textContent
  const assertive = () => m!.q('.sync-indicator [role="alert"]')!.textContent

  test('nothing at first; a change is polite, at most once per 10 s, the newest wins', () => {
    const s = fakeStatus({ [N]: view('synced', { hasUnsent: false }) })
    mount(s)
    expect(polite()).toBe('')
    s.set({ [N]: view('pending') })
    adv(1)
    expect(polite()).toBe('저장 대기')
    s.set({ [N]: view('synced', { hasUnsent: false }) })
    adv(ANNOUNCE_GAP_MS - 100)
    expect(polite()).toBe('저장 대기') // the gap is not over
    s.set({ [N]: view('pending') })
    s.set({ [N]: view('conflict') })
    adv(ANNOUNCE_GAP_MS)
    expect(polite()).toBe('두 버전')
  })

  test('entering not-saved is assertive at once, whatever the gap', () => {
    const s = fakeStatus({ [N]: view('pending') })
    mount(s)
    s.set({ [N]: view('synced', { hasUnsent: false }) })
    adv(1)
    s.set({ [N]: view('error', { lastError: { class: 'fatal' } }) })
    expect(assertive()).toBe('저장 안 됨')
    expect(polite()).toBe('')
  })

  test('unmounting leaves no timer', () => {
    const s = fakeStatus({ [N]: view('synced', { hasUnsent: false }) })
    mount(s)
    s.set({ [N]: view('pending') })
    m!.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the popover', () => {
  const open = () => act(() => void button().click())

  test('opens on press with the description and [지금 동기화]; Esc closes and focus returns', () => {
    mount(fakeStatus({ [N]: view('pending') }))
    expect(button().getAttribute('aria-expanded')).toBe('false')
    open()
    expect(button().getAttribute('aria-expanded')).toBe('true')
    const pop = m!.q('.sync-popover')!
    expect(pop.textContent).toContain('노트를 닫으면 Drive에 저장해요.')
    expect(btn('지금 동기화')).toBeTruthy()
    expect(btn('다시 시도')).toBeUndefined()
    expect(document.activeElement).toBe(btn('지금 동기화'))
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(m!.q('.sync-popover')).toBeNull()
    expect(document.activeElement).toBe(button())
  })

  test('a press outside closes it', () => {
    mount(fakeStatus({ [N]: view('pending') }))
    open()
    act(() => void document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(m!.q('.sync-popover')).toBeNull()
  })

  test('[지금 동기화] syncs this note once, even when pressed again while it runs', async () => {
    let finish!: () => void
    const syncNow = vi.fn(() => new Promise<void>((r) => (finish = r)))
    mount(fakeStatus({ [N]: view('pending') }), { uploads: { syncNow } })
    open()
    await act(async () => void btn('지금 동기화')!.click())
    await act(async () => void btn('지금 동기화')!.click())
    expect(syncNow).toHaveBeenCalledTimes(1)
    expect(syncNow).toHaveBeenCalledWith(N)
    expect(btn('지금 동기화')!.getAttribute('aria-busy')).toBe('true')
    await act(async () => finish())
    expect(btn('지금 동기화')!.getAttribute('aria-busy')).toBe('false')
    await act(async () => void btn('지금 동기화')!.click())
    expect(syncNow).toHaveBeenCalledTimes(2)
  })

  test('an action that settles after unmount touches nothing', async () => {
    let finish!: () => void
    const syncNow = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount(fakeStatus({ [N]: view('pending') }), { uploads: { syncNow } })
    open()
    await act(async () => void btn('지금 동기화')!.click())
    m!.unmount()
    await act(async () => finish())
    expect(err).not.toHaveBeenCalled()
  })

  test('not saved: the reason, [다시 시도] and [동기화 로그 내보내기] next to [지금 동기화]', async () => {
    const syncNow = vi.fn(async () => {})
    mount(fakeStatus({ [N]: view('error', { lastError: { class: 'fatal' } }) }), { uploads: { syncNow } })
    open()
    expect(m!.q('.sync-popover')!.textContent).toContain('변경은 이 브라우저에 보관 중이에요. 다시 시도하거나 동기화 로그를 내보내 주세요.')
    expect(btn('지금 동기화')).toBeTruthy()
    await act(async () => void btn('다시 시도')!.click())
    expect(syncNow).toHaveBeenCalledWith(N)
    await act(async () => void btn('동기화 로그 내보내기')!.click())
    expect(downloads).toEqual(['log.jsonl'])
    expect(m!.q('.sync-popover a')).toBeNull() // no storage link for other errors
  })

  test('a failed export says so; a second press while it runs is ignored', async () => {
    let fail!: () => void
    const exportLog = vi.fn(() => new Promise<{ name: string; text: string }>((_r, rej) => (fail = () => rej(new Error('x')))))
    mount(fakeStatus({ [N]: view('error', { lastError: { class: 'fatal' } }) }), { exportLog })
    open()
    await act(async () => void btn('동기화 로그 내보내기')!.click())
    await act(async () => void btn('동기화 로그 내보내기')!.click())
    expect(exportLog).toHaveBeenCalledTimes(1)
    await act(async () => fail())
    expect(m!.q('.sync-popover [role="alert"]')!.textContent).toBe('로그를 내보내지 못했어요. 다시 시도해 주세요')
  })

  test('quota: the Drive text and [Drive 공간 관리] as a new-tab link', () => {
    mount(fakeStatus({ [N]: view('error', { lastError: { class: 'quota', status: 403, reason: 'storageQuotaExceeded' } }) }))
    open()
    expect(m!.q('.sync-popover')!.textContent).toContain('Drive 저장 공간이 부족해요.')
    const a = m!.q<HTMLAnchorElement>('.sync-popover a')!
    expect(a.textContent).toBe('Drive 공간 관리')
    expect(a.href).toBe('https://drive.google.com/settings/storage')
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener noreferrer')
  })

  test('token expired: the sign-in text', () => {
    mount(fakeStatus({ [N]: view('error', { lastError: { class: 'reauth' } }) }))
    open()
    expect(m!.q('.sync-popover')!.textContent).toContain('로그인이 만료됐어요.')
  })

  test('English popover', () => {
    mount(fakeStatus({ [N]: view('error', { lastError: { class: 'fatal' } }) }), { lang: 'en' })
    open()
    expect(btn('Sync now')).toBeTruthy()
    expect(btn('Try again')).toBeTruthy()
    expect(btn('Export sync log')).toBeTruthy()
  })

  test('Tab wraps inside the open popover', () => {
    mount(fakeStatus({ [N]: view('error', { lastError: { class: 'fatal' } }) }))
    open()
    const items = m!.qa<HTMLElement>('.sync-popover button')
    items.at(-1)!.focus()
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => void items.at(-1)!.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(items[0])
  })

  test('listeners are gone after unmount', () => {
    const s = fakeStatus({ [N]: view('pending') })
    mount(s)
    open()
    const before = document.body.innerHTML.length
    m!.unmount()
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(s.listenerCount()).toBe(0)
    expect(before).toBeGreaterThan(0)
  })
})
