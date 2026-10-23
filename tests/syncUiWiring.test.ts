// @vitest-environment jsdom
// The sync display inside the screens (Story 3.16): the banner slot and its priority, [다시 로그인],
// card badges and disabled cards, the indicator in the editor corner, and the shell's provider.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Note } from '../src/model/note'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore, type NoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { App } from '../src/ui/App'
import { Library } from '../src/ui/library/Library'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Banner } from '../src/ui/sync/Banner'
import { type Mounted, SyncUiProvider, fakeAuth, fakeNet, fakeStatus, mountUi, view } from './syncUiHarness'
import { fakeLocks, signedIn } from './helpers'
import { NID, mkNote } from './uploadHarness'

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

const N2 = '01926f3a-0000-7000-8000-0000000000a2'
const N3 = '01926f3a-0000-7000-8000-0000000000a3'
const N4 = '01926f3a-0000-7000-8000-0000000000a4'
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
afterEach(async () => {
  m?.unmount()
  m = undefined
  await savesSettled()
  stores.forEach((s) => s.close())
  stores = []
  clearSessionHistories()
  delete (navigator as { locks?: unknown }).locks
  location.hash = ''
  await deleteNoteDatabase()
})

type P = { auth?: ReturnType<typeof fakeAuth>; status?: ReturnType<typeof fakeStatus>; net?: ReturnType<typeof fakeNet>; uploads?: { syncNow: () => Promise<void>; resume?: () => Promise<void> }; receiving?: string[] }
function provider(p: P, child: ReturnType<typeof createElement>) {
  const state = { version: 0, receiving: new Set(p.receiving ?? []), scanning: false }
  const receiver = { subscribe: () => () => {}, getState: () => state }
  return createElement(
    SyncUiProvider,
    {
      auth: (p.auth ?? fakeAuth()) as never,
      status: p.status ?? fakeStatus(),
      net: p.net ?? fakeNet(),
      receiver,
      ...(p.uploads && { uploads: p.uploads }),
    },
    child,
  )
}

describe('the banner slot', () => {
  const text = () => m!.q('[data-banner]')?.textContent
  const kinds = () => m!.qa('[data-banner]').map((e) => e.getAttribute('data-banner')!)

  test('no banner while everything is fine', () => {
    m = mountUi(provider({ status: fakeStatus({ a: view('pending') }) }, createElement(Banner)))
    expect(kinds()).toEqual([])
  })

  test('offline: the text, polite, no button, no close; gone when the connection is back', () => {
    const net = fakeNet(true)
    m = mountUi(provider({ net }, createElement(Banner)))
    const b = m.q('[data-banner="offline"]')!
    expect(b.textContent).toBe('연결이 끊겼어요. 변경은 이 브라우저에 보관 중이에요.')
    expect(b.getAttribute('role')).toBe('status')
    expect(b.getAttribute('aria-live')).toBe('polite')
    expect(b.querySelector('button, a')).toBeNull()
    net.set(false)
    expect(kinds()).toEqual([])
  })

  test('English texts', () => {
    m = mountUi(provider({ net: fakeNet(true) }, createElement(Banner)), 'en')
    expect(text()).toBe("You're offline. Your changes are kept in this browser.")
  })

  test('token expired (the flag): text and [다시 로그인], polite', () => {
    m = mountUi(provider({ auth: fakeAuth({ expired: true }) }, createElement(Banner)))
    const b = m.q('[data-banner="reauth"]')!
    expect(b.firstElementChild!.tagName.toLowerCase()).toBe('svg')
    expect(b.textContent).toBe('로그인이 만료됐어요. 변경은 이 브라우저에 보관 중이에요.다시 로그인')
    expect(b.getAttribute('role')).toBe('status')
    expect(b.querySelector('button')!.textContent).toBe('다시 로그인')
  })

  test('token expired (a note stopped with class reauth) shows the same banner', () => {
    m = mountUi(provider({ status: fakeStatus({ a: view('error', { lastError: { class: 'reauth', status: 401 } }) }) }, createElement(Banner)))
    expect(kinds()).toEqual(['reauth'])
  })

  test('storage full: assertive, the text and [Drive 공간 관리] as a new-tab link', () => {
    m = mountUi(provider({ status: fakeStatus({ a: view('error', { lastError: { class: 'quota', status: 403 } }) }) }, createElement(Banner)))
    const b = m.q('[data-banner="quota"]')!
    expect(b.getAttribute('role')).toBe('alert')
    expect(b.textContent).toBe('Drive 저장 공간이 부족해요. 변경은 이 브라우저에 보관 중이에요.Drive 공간 관리')
    const a = b.querySelector('a')!
    expect(a.href).toBe('https://drive.google.com/settings/storage')
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener noreferrer')
  })

  test('a note in error of another class is no banner', () => {
    m = mountUi(provider({ status: fakeStatus({ a: view('error', { lastError: { class: 'fatal' } }) }) }, createElement(Banner)))
    expect(kinds()).toEqual([])
  })

  test('an old quota error on a note that is no longer in error is no banner', () => {
    m = mountUi(provider({ status: fakeStatus({ a: view('pending', { lastError: { class: 'quota' } }) }) }, createElement(Banner)))
    expect(kinds()).toEqual([])
  })

  test('everything at once: one banner; as each ends the next shows', () => {
    const auth = fakeAuth({ expired: true })
    const net = fakeNet(true)
    const status = fakeStatus({ a: view('error', { lastError: { class: 'quota' } }) })
    const at = (otherTab: boolean) => provider({ auth, net, status }, createElement(Banner, { otherTab }))
    m = mountUi(at(true))
    const seen: string[][] = [kinds()]
    m.render(at(false)) // the other tab let go
    seen.push(kinds())
    auth.set({ expired: false }) // signed in again
    seen.push(kinds())
    status.set({}) // the quota error is gone
    seen.push(kinds())
    net.set(false) // the connection is back
    seen.push(kinds())
    expect(seen).toEqual([['otherTab'], ['reauth'], ['quota'], ['offline'], []])
  })

  test('without the provider only the other-tab banner exists', () => {
    m = mountUi(createElement(Banner, { otherTab: true }))
    expect(kinds()).toEqual(['otherTab'])
    expect(text()).toBe('다른 탭에서 이 노트를 편집 중이에요. 여기서 편집하려면 그 탭을 닫아 주세요.')
    m.unmount()
    m = mountUi(createElement(Banner))
    expect(kinds()).toEqual([])
  })
})

describe('[다시 로그인]', () => {
  const press = () => act(async () => void m!.q<HTMLButtonElement>('[data-banner="reauth"] button')!.click())

  function setup(reauth: () => Promise<'granted' | 'cancelled' | 'denied' | 'network'>, sub: string | null = 's1') {
    const auth = fakeAuth({ expired: true, reauth, sub })
    const resume = vi.fn(async () => {})
    const status = fakeStatus()
    m = mountUi(provider({ auth, status, uploads: { syncNow: async () => {}, resume } }, createElement(Banner)))
    return { auth, resume, status }
  }

  test('same account: uploads resume once and the stores are read again', async () => {
    const { auth, resume, status } = setup(async () => 'granted')
    await press()
    expect(auth.reauth).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(status.refreshAll).toHaveBeenCalledTimes(2) // mount + after
  })

  test('another account: nothing uploads, the mismatch gate decides', async () => {
    const { auth, resume } = setup(async () => {
      auth.set({ account: { sub: 'other', email: 'b@x.com' } } as never)
      return 'granted'
    })
    await press()
    expect(resume).not.toHaveBeenCalled()
  })

  test('the popup is closed or denied: the banner stays, nothing resumes', async () => {
    for (const outcome of ['cancelled', 'denied', 'network'] as const) {
      const { resume } = setup(async () => outcome)
      await press()
      expect(resume).not.toHaveBeenCalled()
      expect(m!.q('[data-banner="reauth"]')).not.toBeNull()
      m!.unmount()
    }
  })

  test('pressed twice while the popup is open: one request', async () => {
    let finish!: () => void
    const { auth, resume } = setup(() => new Promise((r) => (finish = () => r('granted'))))
    await press()
    await press()
    expect(auth.reauth).toHaveBeenCalledTimes(1)
    expect(m!.q('[data-banner="reauth"] button')!.getAttribute('aria-busy')).toBe('true')
    await act(async () => finish())
    expect(resume).toHaveBeenCalledTimes(1)
    expect(m!.q('[data-banner="reauth"] button')!.getAttribute('aria-busy')).toBe('false')
  })

  test('the screen went away while the popup was open: nothing resumes, nothing is set', async () => {
    let finish!: () => void
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { resume } = setup(() => new Promise((r) => (finish = () => r('granted'))))
    await press()
    m!.unmount()
    await act(async () => finish())
    expect(resume).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  test('a failing resume leaves the banner flow usable', async () => {
    const auth = fakeAuth({ expired: true })
    const resume = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined)
    m = mountUi(provider({ auth, uploads: { syncNow: async () => {}, resume } }, createElement(Banner)))
    await press()
    await press()
    expect(resume).toHaveBeenCalledTimes(2)
  })
})

async function seedNotes(): Promise<void> {
  const s = openNoteStore()
  for (const [id, title] of [[NID, 'A'], [N2, 'B'], [N3, 'C'], [N4, 'D']] as const) await s.writeNote(mkNote({ noteId: id, title }))
  s.close()
}

describe('the library', () => {
  async function mountLibrary(p: P) {
    await seedNotes()
    m = mountUi(provider(p, createElement(Library, { openStore, editedBy: 'x' })))
    await flush()
  }
  const card = (title: string) => m!.qa('.cover-grid li').find((li) => li.querySelector('.cover-title')?.textContent === title)!
  const described = (title: string) => {
    const el = card(title).querySelector('.cover-card')!
    return (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)!.textContent).join(' | ')
  }

  test('badges: none for saved; icon and text for the others, with the right colour class', async () => {
    await mountLibrary({
      status: fakeStatus({
        [NID]: view('synced', { hasUnsent: false }),
        [N2]: view('pending'),
        [N3]: view('conflict'),
        [N4]: view('error', { lastError: { class: 'fatal' } }),
      }),
    })
    expect(card('A').querySelector('.cover-badge')).toBeNull()
    const b = card('B').querySelector('.cover-badge')!
    expect(b.textContent).toBe('저장 대기')
    expect(b.querySelector('svg')).not.toBeNull()
    expect(b.className).toContain('sync-badge')
    expect(card('C').querySelector('.cover-badge')!.className).toContain('sync-badge-twoVersions')
    expect(card('C').querySelector('.cover-badge')!.textContent).toBe('두 버전')
    expect(card('D').querySelector('.cover-badge')!.className).toContain('sync-badge-notSaved')
    expect(card('D').querySelector('.cover-badge')!.textContent).toBe('저장 안 됨')
  })

  test('the card description carries the status before the date; saved has only the date', async () => {
    await mountLibrary({ status: fakeStatus({ [NID]: view('synced', { hasUnsent: false }), [N3]: view('conflict') }) })
    expect(described('C')).toMatch(/^두 버전 \| .+/)
    expect(described('A')).not.toContain('두 버전')
    expect(card('C').querySelector('.cover-card')!.getAttribute('aria-labelledby')).toBeTruthy()
  })

  test('a note being received has the 받는 중 badge', async () => {
    await mountLibrary({ status: fakeStatus({ [NID]: view('synced', { hasUnsent: false }) }), receiving: [NID] })
    expect(card('A').querySelector('.cover-badge')!.textContent).toBe('받는 중')
    expect(described('A')).toContain('받는 중')
  })

  test('syncing: the top display and the card say "동기화 중" at once, hold for a short sync, then go; polite', async () => {
    const status = fakeStatus({ [NID]: view('pending') })
    await mountLibrary({ status })
    const top = () => m!.q('.library > .library-syncing, .library > [aria-live="polite"]')!
    expect(top().textContent).toBe('')
    status.set({ [NID]: view('syncing') })
    expect(top().textContent).toBe('동기화 중')
    expect(card('A').querySelector('.cover-badge')!.textContent).toBe('동기화 중')
    status.set({ [NID]: view('synced', { hasUnsent: false }) }) // a sync that took no time
    expect(top().textContent).toBe('동기화 중')
    expect(card('A').querySelector('.cover-badge')).not.toBeNull()
    await act(async () => void (await new Promise((r) => setTimeout(r, 900))))
    expect(top().textContent).toBe('')
    expect(card('A').querySelector('.cover-badge')).toBeNull()
  })

  test('nothing is known yet: no badge', async () => {
    await mountLibrary({ status: fakeStatus({}, false) })
    expect(m!.qa('.cover-badge')).toHaveLength(0)
  })

  test('offline: the banner is the first thing, cards are disabled and not links; back online they open again', async () => {
    const net = fakeNet(true)
    await mountLibrary({ net, status: fakeStatus({ [N2]: view('pending') }) })
    const section = m!.q('.library')!
    expect(section.firstElementChild!.getAttribute('data-banner')).toBe('offline')
    expect(m!.qa('a.cover-card')).toHaveLength(0)
    const c = card('B').querySelector('.cover-card')!
    expect(c.className).toContain('cover-card-disabled')
    expect(c.getAttribute('aria-disabled')).toBe('true')
    expect(c.getAttribute('href')).toBeNull()
    expect(card('B').querySelector('.cover-badge')!.textContent).toBe('저장 대기') // the state still shows
    net.set(false)
    expect(m!.qa('a.cover-card').length).toBe(4)
    expect(m!.q('[data-banner]')).toBeNull()
  })

  test('the library keeps its own screen without a provider', async () => {
    await seedNotes()
    m = mountUi(createElement(Library, { openStore, editedBy: 'x' }))
    await flush()
    expect(m.qa('a.cover-card')).toHaveLength(4)
    expect(m.qa('.cover-badge')).toHaveLength(0)
  })
})

describe('the writing screen', () => {
  async function mountEditor(p: P, id = NID) {
    const s = openNoteStore()
    await s.writeNote(mkNote({ noteId: id, title: '필기' }) as Note)
    s.close()
    m = mountUi(provider(p, createElement(NoteEditor, { noteId: id, openStore })))
    await flush()
  }

  test('the indicator sits in the right corner next to the ⋯ button, icon only, with its name', async () => {
    await mountEditor({ status: fakeStatus({ [NID]: view('pending') }) })
    const corner = m!.q('.editor-more .editor-corner')!
    const btn = corner.querySelector<HTMLButtonElement>('.sync-indicator-button')!
    expect(btn.getAttribute('aria-label')).toBe('동기화 상태: 저장 대기. 자세히 보기')
    expect(btn.closest('.sync-indicator')!.parentElement).toBe(corner)
    expect(btn.closest('.sync-indicator')!.nextElementSibling).toBe(corner.querySelector('[aria-label="더 보기"]'))
    expect(corner.querySelector('[aria-label="더 보기"]')).not.toBeNull()
    expect(btn.textContent).toBe('')
  })

  test('the banner is the first child of the screen and pushes the rest down', async () => {
    await mountEditor({ net: fakeNet(true), status: fakeStatus({ [NID]: view('pending') }) })
    const section = m!.q('.editor')!
    expect(section.firstElementChild!.getAttribute('data-banner')).toBe('offline')
    expect(m!.qa('[data-banner]')).toHaveLength(1)
  })

  test('editing goes on while the banner shows (the canvas is there and writable)', async () => {
    await mountEditor({ net: fakeNet(true), auth: fakeAuth({ expired: true }) })
    expect(m!.q('canvas.editor-canvas')).not.toBeNull()
    expect(m!.q('[data-banner]')!.getAttribute('data-banner')).toBe('reauth')
    expect(m!.q('.editor-banner button')!.textContent).toBe('다시 로그인')
  })

  test('F6 starts at the banner', async () => {
    await mountEditor({ net: fakeNet(true) })
    m!.q<HTMLCanvasElement>('canvas.editor-canvas')!.focus()
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(m!.q('[data-banner]'))
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(m!.q('.editor-corner button'))
  })

  test('F6 goes to the banner action when it has one', async () => {
    await mountEditor({ auth: fakeAuth({ expired: true }) })
    m!.q<HTMLCanvasElement>('canvas.editor-canvas')!.focus()
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(m!.q('[data-banner] button'))
  })

  test('the other-tab banner beats the others and keeps its markup; the lock holder shows the next in order', async () => {
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true })
    const p = () => ({ net: fakeNet(true), auth: fakeAuth({ expired: true }), status: fakeStatus({ [NID]: view('error', { lastError: { class: 'quota' } }) }) })
    await mountEditor(p())
    const second = mountUi(provider(p(), createElement(NoteEditor, { noteId: NID, openStore, lockWaitMs: 0 })))
    await flush()
    try {
      const banners = second.qa('[data-banner]')
      expect(banners.map((b) => b.getAttribute('data-banner'))).toEqual(['otherTab'])
      expect(banners[0]!.className).toBe('editor-banner')
      expect(banners[0]!.querySelector('button')).toBeNull()
      expect(m!.qa('[data-banner]').map((b) => b.getAttribute('data-banner'))).toEqual(['reauth'])
    } finally {
      second.unmount()
    }
  })
})

describe('the shell', () => {
  test('it provides the display: the offline banner and disabled cards reach the library', async () => {
    await seedNotes()
    const net = fakeNet(true)
    const status = fakeStatus({ [NID]: view('pending') })
    m = mountUi(createElement(App, { auth: signedIn, syncUi: { status, net } }))
    await flush()
    expect(m.q('.library')!.firstElementChild!.getAttribute('data-banner')).toBe('offline')
    expect(m.qa('a.cover-card')).toHaveLength(0)
    expect(status.refreshAll).toHaveBeenCalled()
  })

  test('unmounting the shell stops everything the provider started', async () => {
    const status = fakeStatus({ [NID]: view('pending') })
    m = mountUi(createElement(App, { auth: signedIn, syncUi: { status, net: fakeNet() } }))
    await flush()
    expect(status.listenerCount()).toBeGreaterThan(0)
    m.unmount()
    expect(status.listenerCount()).toBe(0)
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
