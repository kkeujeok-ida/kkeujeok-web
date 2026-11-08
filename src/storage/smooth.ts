// Stroke smoothing level: a device setting (localStorage), default off; not in the note, not synced.
import { SMOOTH_LEVELS, type SmoothLevel } from '../model/smooth'

export const SMOOTH_KEY = 'kkeujeok.smooth'

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readSmooth(storage = browserStorage()): SmoothLevel {
  try {
    const v = storage?.getItem(SMOOTH_KEY)
    return (SMOOTH_LEVELS as readonly (string | null | undefined)[]).includes(v) ? (v as SmoothLevel) : 'off'
  } catch {
    return 'off'
  }
}

let current = readSmooth()
const listeners = new Set<() => void>()

export const getSmooth = () => current
export const subscribeSmooth = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))

export function setSmooth(v: SmoothLevel): void {
  current = v
  try {
    browserStorage()?.setItem(SMOOTH_KEY, v) // blocked storage: this session only
  } catch {
    // kept for this session only
  }
  listeners.forEach((fn) => fn())
}
