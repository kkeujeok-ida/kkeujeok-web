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
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  Element.prototype.scrollIntoView = vi.fn()
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  const i18n = createI18n({ storage: { getItem: () => 'en', setItem: () => {} }, navigatorLanguage: 'en' })
  root = createRoot(host)
  act(() => root!.render(createElement(I18nContext.Provider, { value: i18n }, createElement(Settings, { auth: signedIn, onClose: () => {} }))))
})
afterEach(() => {
  act(() => root!.unmount())
  host.remove()
})

const input = () => {
  if (!host.querySelector('#settings-search-input')) act(() => host.querySelector<HTMLButtonElement>('.library-search-button')!.click())
  return host.querySelector<HTMLInputElement>('#settings-search-input')!
}
function type(v: string) {
  const el = input()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const sections = () => [...host.querySelectorAll<HTMLElement>('section.settings-section')]
const navs = () => [...host.querySelectorAll<HTMLElement>('nav button')]
const status = () => host.querySelector('.settings-search-status')!

describe('settings search', () => {
  test('field is labelled', () => {
    expect(host.querySelector('.library-search-button')?.getAttribute('aria-label')).toBe('Search settings')
    expect(input().getAttribute('aria-label')).toBe('Search settings')
    expect(document.activeElement).toBe(input())
  })

  test('filters items, hides empty sections and shows counts', () => {
    type('theme')
    expect(sections().map((s) => s.hidden)).toEqual([false, true, true, true, true])
    expect(navs().map((b) => b.hidden)).toEqual([false, true, true, true, true])
    expect(navs()[0]!.textContent).toBe('General1')
    expect(status().textContent).toBe('Results: 1')
    expect(host.querySelector('input[name="language"]')!.closest('.settings-item')!.hasAttribute('hidden')).toBe(true)
  })

  test('no match announces no results', () => {
    type('zzz')
    expect(status().textContent).toBe('No results')
    expect(sections().every((s) => s.hidden)).toBe(true)
  })

  test('clear button and Esc restore everything and the scroll position', () => {
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true })
    type('theme')
    act(() => host.querySelector<HTMLButtonElement>('.library-search button')!.click())
    expect(sections().some((s) => s.hidden)).toBe(false)
    expect(navs()[0]!.textContent).toBe('General')
    expect(window.scrollTo).toHaveBeenCalledWith(0, 120)
    type('pen')
    act(() => void input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(input().value).toBe('')
    expect(sections().some((s) => s.hidden)).toBe(false)
  })

  test('blank query shows everything with no count', () => {
    type('  ')
    expect(sections().some((s) => s.hidden)).toBe(false)
    expect(status().textContent).toBe('')
  })

  test('hidden items keep their state', () => {
    const before = host.querySelector<HTMLInputElement>('input[type="range"]')!
    type('theme')
    type('')
    expect(host.querySelector('input[type="range"]')).toBe(before)
  })
})
