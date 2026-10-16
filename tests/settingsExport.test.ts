// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { Settings } from '../src/ui/Settings'
import { signedIn } from './helpers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root | undefined
let downloads: { name: string; blob: Blob }[]
const blobs = new Map<string, Blob>()

beforeEach(() => {
  downloads = []
  let n = 0
  URL.createObjectURL = (b: Blob | MediaSource) => {
    const u = `blob:test/${n++}`
    blobs.set(u, b as Blob)
    return u
  }
  URL.revokeObjectURL = () => {}
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! })
  })
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  host.remove()
  vi.restoreAllMocks()
})

function mount(exportLog: () => Promise<{ name: string; text: string }>, lang = 'en') {
  const i18n = createI18n({ storage: { getItem: () => lang, setItem: () => {} }, navigatorLanguage: 'en' })
  root = createRoot(host)
  act(() =>
    root!.render(createElement(I18nContext.Provider, { value: i18n }, createElement(Settings, { auth: signedIn, onClose: () => {}, exportLog }))),
  )
}
const exportBtn = () => [...host.querySelectorAll('button')].find((b) => /sync log|동기화 로그/.test(b.textContent!))!
const press = () => act(async () => void exportBtn().click())

describe('sync log export in Settings', () => {
  test('a native button; pressing it downloads the .jsonl file', async () => {
    mount(async () => ({ name: 'kkeujeok-sync-log-2026-10-16.jsonl', text: '{"type":"header"}\n' }))
    const b = exportBtn()
    expect(b.tagName).toBe('BUTTON') // Enter and Space activate a native button
    expect(b.type).toBe('button')
    expect(b.textContent).toBe('Export sync log')
    await press()
    expect(downloads.map((d) => d.name)).toEqual(['kkeujeok-sync-log-2026-10-16.jsonl'])
    expect(await downloads[0]!.blob.text()).toBe('{"type":"header"}\n')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  test('label is Korean in the Korean UI', () => {
    mount(async () => ({ name: 'a', text: '' }), 'ko')
    expect(exportBtn().textContent).toBe('동기화 로그 내보내기')
  })

  test('a second press while one is running is ignored', async () => {
    let finish!: (v: { name: string; text: string }) => void
    const fn = vi.fn(() => new Promise<{ name: string; text: string }>((res) => (finish = res)))
    mount(fn)
    await press()
    await press()
    expect(fn).toHaveBeenCalledTimes(1)
    await act(async () => finish({ name: 'a.jsonl', text: '' }))
    expect(downloads).toHaveLength(1)
    await press() // free again
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('a failure shows a message in role="alert"; a retry clears it', async () => {
    let ok = false
    mount(async () => {
      if (!ok) throw new Error('db')
      return { name: 'a.jsonl', text: '' }
    })
    await press()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Could not export the log. Please try again')
    expect(downloads).toHaveLength(0)
    ok = true
    await press()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(downloads).toHaveLength(1)
  })

  test('closing Settings while the export runs: no download side effects break, nothing is shown after', async () => {
    let fail!: (e: Error) => void
    mount(() => new Promise((_, rej) => (fail = rej)))
    await press()
    act(() => root!.unmount())
    root = undefined
    await act(async () => fail(new Error('late')))
    expect(host.textContent).toBe('')
    expect(downloads).toHaveLength(0)
  })
})
