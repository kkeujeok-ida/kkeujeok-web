// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { I18nContext, createI18n, resources, type Key } from '../src/i18n'
import { signedIn } from './helpers'
import { App } from '../src/ui/App'
import { CONTACT_URL, isPrivacyPath } from '../src/ui/PrivacyPolicy'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function open(path: string, lang: string, saved?: string) {
  history.pushState(null, '', path)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const i18n = createI18n({
    navigatorLanguage: lang,
    storage: { getItem: () => saved ?? null, setItem: () => {} },
    applyLang: (l) => void (document.documentElement.lang = l),
  })
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(App, { auth: signedIn }))))
  return { host, root }
}
let mounted: ReturnType<typeof open> | undefined
const close = () => {
  if (mounted) act(() => mounted!.root.unmount())
  mounted?.host.remove()
  mounted = undefined
}
afterEach(() => {
  close()
  history.replaceState(null, '', '/') // the path must not leak into the next test
})

describe('/privacy', () => {
  test('path match allows a trailing slash only', () => {
    expect(isPrivacyPath('/privacy')).toBe(true)
    expect(isPrivacyPath('/privacy/')).toBe(true)
    expect(isPrivacyPath('/')).toBe(false)
    expect(isPrivacyPath('/privacy/x')).toBe(false)
  })

  test('Korean page: title, tab title, lang, h1/h2 and the six facts', () => {
    mounted = open('/privacy', 'ko-KR')
    const { host } = mounted
    expect(host.querySelector('h1')!.textContent).toBe('Kkeujeok 개인정보처리방침')
    expect(document.title).toBe('Kkeujeok 개인정보처리방침')
    expect(document.documentElement.lang).toBe('ko')
    expect(host.querySelectorAll('h2')).toHaveLength(6)
    expect(host.querySelector('nav')).toBeNull()
    const text = host.textContent!
    const facts = [
      'Google Drive에만',
      '운영자는 노트에 접근할 수 없',
      'drive.file',
      'Kkeujeok이 만든 파일만',
      '서버가 없',
      '분석',
      '크래시',
      '암호화하지 않',
      '연결을 해제',
      '권한을 철회',
      CONTACT_URL,
    ]
    for (const fact of facts) expect(text).toContain(fact)
    expect(host.querySelector(`a[href="${CONTACT_URL}"]`)).not.toBeNull()
    const revoke = host.querySelector<HTMLAnchorElement>('a[href="https://myaccount.google.com/permissions"]')
    expect(revoke).not.toBeNull()
    expect(revoke!.rel).toContain('noopener')
  })

  test('saved language beats the browser; unknown value falls back to browser', () => {
    mounted = open('/privacy/', 'ko-KR', 'en')
    expect(document.title).toBe('Kkeujeok Privacy Policy')
    expect(document.documentElement.lang).toBe('en')
    close()
    mounted = open('/privacy', 'ko-KR', 'xx')
    expect(document.title).toBe('Kkeujeok 개인정보처리방침')
  })

  test('other paths render the app shell', () => {
    mounted = open('/', 'ko-KR')
    expect(mounted.host.querySelector('nav')).not.toBeNull()
    expect(mounted.host.querySelector('.privacy')).toBeNull()
  })

  test('every privacy key exists in both languages', () => {
    const keys = Object.keys(resources.ko).filter((k) => k.startsWith('privacy.')) as Key[]
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => !resources.en[k])).toEqual([])
  })
})

test('vercel.json rewrites unknown paths to index.html', () => {
  const cfg = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf8'))
  expect(cfg.rewrites).toContainEqual({ source: '/(.*)', destination: '/index.html' })
})
