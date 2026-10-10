// @vitest-environment jsdom
// Interaction tests for the shell: collapse on resize, Settings open/close with
// focus, live language switch, and that every control is a native element.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { I18nContext, STORAGE_KEY, createI18n, resolveLocale } from '../src/i18n'
import { App } from '../src/ui/App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root

function mount(navigatorLanguage = 'ko-KR') {
  const store = new Map<string, string>()
  const i18n = createI18n({
    navigatorLanguage,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    },
    applyLang: (l) => void (document.documentElement.lang = l),
  })
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(App))))
  return { i18n, store }
}
const setWidth = (w: number) =>
  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
    window.dispatchEvent(new Event('resize'))
  })
const settingsButton = () => host.querySelector<HTMLButtonElement>('nav button')!

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setWidth(1200)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('sidebar', () => {
  test('collapses below 840px and keeps its labels for screen readers', () => {
    mount()
    const nav = host.querySelector('nav')!
    expect(nav.className).toBe('sidebar')
    setWidth(839)
    expect(nav.className).toBe('sidebar collapsed')
    const label = settingsButton().querySelector('span')!
    expect(label.className).toBe('sr-only')
    expect(label.textContent).toBe('설정')
    setWidth(840)
    expect(nav.className).toBe('sidebar')
  })

  test('product name is Kkeujeok in both languages', () => {
    mount('en-US')
    expect(host.querySelector('.brand')!.textContent).toBe('Kkeujeok')
    mount('ko-KR')
    expect(host.querySelector('.brand')!.textContent).toBe('Kkeujeok')
  })
})

describe('settings', () => {
  test('opens with focus on its heading and returns focus to the entry on close', () => {
    mount()
    expect(host.querySelector('.settings')).toBeNull()
    act(() => settingsButton().click())
    expect(host.querySelector('.settings')).not.toBeNull()
    expect(document.activeElement).toBe(host.querySelector('#settings-title'))
    const close = host.querySelector<HTMLButtonElement>('.settings-header button')!
    act(() => close.click())
    expect(host.querySelector('.settings')).toBeNull()
    expect(document.activeElement).toBe(settingsButton())
  })

  test('shows only language and privacy; logout and disconnect are absent', () => {
    mount()
    act(() => settingsButton().click())
    const text = host.querySelector('.settings')!.textContent!
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(3)
    expect(host.querySelector('a[href="/privacy"]')).not.toBeNull()
    expect(text).not.toMatch(/로그아웃|연결 해제|Log out|Disconnect/)
  })

  test('picking English switches the text and <html lang> without a reload, and is remembered', () => {
    const { store } = mount('ko-KR')
    expect(document.documentElement.lang).toBe('ko')
    act(() => settingsButton().click())
    const english = host.querySelector<HTMLInputElement>('input[value="en"]')!
    act(() => english.click())
    expect(document.documentElement.lang).toBe('en')
    expect(settingsButton().textContent).toBe('Settings')
    expect(store.get(STORAGE_KEY)).toBe('en')
  })
})

describe('keyboard', () => {
  test('every control is a native button, link or radio, and none is a div or span', () => {
    mount()
    act(() => settingsButton().click())
    const controls = [...host.querySelectorAll('[onclick], [role="button"], [tabindex]:not([tabindex="-1"])')]
    expect(controls.map((e) => e.tagName)).toEqual([])
    const native = host.querySelectorAll('button, a[href], input')
    expect(native.length).toBeGreaterThanOrEqual(5)
    expect(settingsButton().tagName).toBe('BUTTON')
  })
})

describe('locale matching', () => {
  test('only "ko" and "ko-*" are Korean', () => {
    expect(resolveLocale('system', 'ko')).toBe('ko')
    expect(resolveLocale('system', 'ko-KR')).toBe('ko')
    expect(resolveLocale('system', 'kok-IN')).toBe('en')
  })
})
