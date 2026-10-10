// ko/en UI strings. The language choice lives in this browser's localStorage,
// apart from note data (AD-13).
import { createContext, useContext, useSyncExternalStore } from 'react'
import en from './en.json'
import ko from './ko.json'

export type Locale = 'ko' | 'en'
export type Choice = 'system' | Locale
export type Key = keyof typeof ko

export const resources: Record<Locale, Record<Key, string>> = { ko, en }
export const STORAGE_KEY = 'kkeujeok.language'

const isChoice = (v: unknown): v is Choice => v === 'system' || v === 'ko' || v === 'en'

export function resolveLocale(choice: Choice, navigatorLanguage: string | undefined): Locale {
  if (choice !== 'system') return choice
  // "ko" or "ko-KR", not other languages whose code starts with "ko" (e.g. "kok").
  return /^ko(-|$)/i.test(navigatorLanguage ?? '') ? 'ko' : 'en'
}

interface Env {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined
  navigatorLanguage?: string | undefined
  applyLang?: (locale: Locale) => void
}

export function createI18n({ storage, navigatorLanguage, applyLang }: Env) {
  let choice: Choice = 'system'
  try {
    const saved = storage?.getItem(STORAGE_KEY)
    if (isChoice(saved)) choice = saved // unknown values fall back to system
  } catch {
    // storage blocked: session-only
  }
  const compute = () => ({ choice, locale: resolveLocale(choice, navigatorLanguage) })
  let state = compute()
  applyLang?.(state.locale)
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    setChoice(next: Choice) {
      choice = next
      try {
        storage?.setItem(STORAGE_KEY, next)
      } catch {
        // kept for this session only
      }
      state = compute()
      applyLang?.(state.locale)
      listeners.forEach((fn) => fn())
    },
  }
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export const i18n = createI18n({
  storage: browserStorage(),
  navigatorLanguage: globalThis.navigator?.language,
  applyLang: (l) => {
    if (typeof document !== 'undefined') document.documentElement.lang = l
  },
})

export const I18nContext = createContext(i18n)

export function useI18n() {
  const store = useContext(I18nContext)
  const { choice, locale } = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { choice, locale, setChoice: store.setChoice, t: (key: Key) => resources[locale][key] }
}
