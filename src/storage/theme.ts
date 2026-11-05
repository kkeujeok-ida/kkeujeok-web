// Light / Dark / All Dark: a per-browser setting (localStorage), not in the note and not synced.
// `data-theme` on <html> is "light" or "dark" (All Dark is Dark for the UI); `data-invert` marks All Dark.
// index.html sets the same attributes before first paint (keep the key in sync).
export type Theme = 'light' | 'dark' | 'alldark'
export const THEME_KEY = 'kkeujeok.theme'
export const THEMES: Theme[] = ['light', 'dark', 'alldark']

const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme)

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readTheme(storage = browserStorage()): Theme {
  try {
    const v = storage?.getItem(THEME_KEY)
    return isTheme(v) ? v : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(t: Theme, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return
  root.dataset.theme = t === 'light' ? 'light' : 'dark'
  if (t === 'alldark') root.dataset.invert = 'true'
  else delete root.dataset.invert
}

let current: Theme = readTheme()
applyTheme(current)
const listeners = new Set<() => void>()

export const getTheme = () => current
export const subscribeTheme = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))
/** Page paper and writing are inverted on screen only (spec invert.md). */
export const isAllDark = () => current === 'alldark'

export function setTheme(t: Theme): void {
  current = t
  try {
    browserStorage()?.setItem(THEME_KEY, t) // blocked storage: this session only
  } catch {
    // kept for this session only
  }
  applyTheme(t)
  listeners.forEach((fn) => fn())
}
