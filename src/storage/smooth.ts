// Stroke smoothing level: a device setting (localStorage), default off; not in the note, not synced.
import { SMOOTH_MAX } from '../model/smooth'

export const SMOOTH_KEY = 'kkeujeok.smooth'

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** 0..SMOOTH_MAX. An old build stored a name: it maps to a level. */
export function readSmooth(storage = browserStorage()): number {
  try {
    const v = storage?.getItem(SMOOTH_KEY)
    const old: Record<string, number> = { light: 3, normal: 5, strong: 8 }
    if (v != null && v in old) return old[v]!
    const n = Number(v)
    return v != null && Number.isInteger(n) ? Math.min(SMOOTH_MAX, Math.max(0, n)) : 0
  } catch {
    return 0
  }
}

let current = readSmooth()
const listeners = new Set<() => void>()

export const getSmooth = () => current
export const subscribeSmooth = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))

export function setSmooth(v: number): void {
  current = v
  try {
    browserStorage()?.setItem(SMOOTH_KEY, String(v)) // blocked storage: this session only
  } catch {
    // kept for this session only
  }
  listeners.forEach((fn) => fn())
}
