import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { I18nContext, STORAGE_KEY, createI18n, resolveLocale, resources, type Locale } from '../src/i18n'
import { App, isSidebarExpanded } from '../src/ui/App'
import { Settings } from '../src/ui/Settings'

const memory = (initial?: string) => {
  const m = new Map<string, string>(initial ? [[STORAGE_KEY, initial]] : [])
  return {
    m,
    storage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    },
  }
}
const render = (el: ReactElement, lang = 'ko-KR') =>
  renderToStaticMarkup(
    createElement(I18nContext.Provider, { value: createI18n({ navigatorLanguage: lang }) }, el),
  )

describe('resources', () => {
  test('ko and en have the same keys', () => {
    const ko = Object.keys(resources.ko)
    const en = Object.keys(resources.en)
    expect([
      ...ko.filter((k) => !en.includes(k)).map((k) => `en is missing ${k}`),
      ...en.filter((k) => !ko.includes(k)).map((k) => `ko is missing ${k}`),
    ]).toEqual([])
  })
  test('product name is the same in every language', () => {
    expect(resources.ko['app.name']).toBe('Kkeujeok')
    expect(resources.en['app.name']).toBe('Kkeujeok')
  })
})

describe('language decision', () => {
  test('first run follows the browser: ko-* is Korean, everything else English', () => {
    expect(resolveLocale('system', 'ko-KR')).toBe('ko')
    expect(resolveLocale('system', 'fr-FR')).toBe('en')
    expect(resolveLocale('system', undefined)).toBe('en')
  })
  test('a saved choice beats the browser language; unknown values are ignored', () => {
    expect(createI18n({ storage: memory('ko').storage, navigatorLanguage: 'fr-FR' }).getState().locale).toBe('ko')
    expect(createI18n({ storage: memory('xx').storage, navigatorLanguage: 'fr-FR' }).getState().locale).toBe('en')
    expect(createI18n({ storage: memory('xx').storage, navigatorLanguage: 'ko-KR' }).getState().choice).toBe('system')
  })
  test('choosing updates state, <html lang>, storage and listeners without reload', () => {
    const { m, storage } = memory()
    const langs: Locale[] = []
    const s = createI18n({ storage, navigatorLanguage: 'ko-KR', applyLang: (l) => langs.push(l) })
    let notified = 0
    s.subscribe(() => notified++)
    s.setChoice('en')
    expect(s.getState().locale).toBe('en')
    expect(langs).toEqual(['ko', 'en'])
    expect(m.get(STORAGE_KEY)).toBe('en')
    expect(notified).toBe(1)
  })
  test('blocked storage keeps the choice for the session', () => {
    const boom = () => {
      throw new Error('blocked')
    }
    const s = createI18n({ storage: { getItem: boom, setItem: boom }, navigatorLanguage: 'ko-KR' })
    s.setChoice('en')
    expect(s.getState().locale).toBe('en')
  })
})

describe('shell', () => {
  test('sidebar expands at 840px and collapses at 839px', () => {
    expect(isSidebarExpanded(840)).toBe(true)
    expect(isSidebarExpanded(839)).toBe(false)
  })
  test('app shows the product name, settings entry and an empty library', () => {
    const html = render(createElement(App))
    expect(html).toContain('Kkeujeok')
    expect(html).toContain('설정')
    expect(html).toContain('aria-label="서재"')
  })
  test('settings has language and privacy only, in the current language', () => {
    const html = render(createElement(Settings, { onClose: () => {} }), 'fr-FR')
    expect(html).toContain('Language')
    expect(html).toContain('href="/privacy"')
    expect(html.match(/type="radio"/g)).toHaveLength(3)
    expect(html).not.toMatch(/logout|disconnect|로그아웃|연결 해제/i)
  })
  // Keyboard reachability is checked on the live DOM in tests/shell-dom.test.ts:
  // static markup never carries event handlers, so it cannot show a clickable div.
})
