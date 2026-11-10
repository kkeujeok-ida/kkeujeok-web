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
  const i18n = createI18n({ storage: { getItem: () => 'ko', setItem: () => {} }, navigatorLanguage: 'ko' })
  root = createRoot(host)
  act(() => root!.render(createElement(I18nContext.Provider, { value: i18n }, createElement(Settings, { auth: signedIn, onClose: () => {} }))))
})
afterEach(() => {
  act(() => root!.unmount())
  host.remove()
})

const entries = () => [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label] button')]

describe('settings category sidebar', () => {
  test('nav has 5 buttons, each with an h2 section', () => {
    expect(entries().map((b) => b.textContent)).toEqual(['일반', '입력·필기', '도구', '도움말·진단', '계정'])
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(entries().map((b) => b.textContent))
    expect(entries().filter((b) => b.getAttribute('aria-current') === 'true')).toHaveLength(1) // jsdom: all tops 0
  })

  test('click scrolls to the heading, focuses it and marks the entry', () => {
    act(() => entries()[2]!.click())
    const h = host.querySelectorAll('h2')[2]!
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(document.activeElement).toBe(h)
    expect(entries().map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'true', null, null])
  })

  test('items sit under their category', () => {
    const tools = host.querySelectorAll('section.settings-section')[2]!
    expect(tools.querySelector('#visible-tools-label')).not.toBeNull()
  })
})
