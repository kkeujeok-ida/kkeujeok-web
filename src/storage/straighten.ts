// Line straightening on/off: a device setting (localStorage), default off; not in the note, not synced.
export const STRAIGHTEN_KEY = 'kkeujeok.straighten'

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readStraighten(storage = browserStorage()): boolean {
  try {
    return storage?.getItem(STRAIGHTEN_KEY) === 'true'
  } catch {
    return false
  }
}

let current = readStraighten()
const listeners = new Set<() => void>()

export const getStraighten = () => current
export const subscribeStraighten = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))

export function setStraighten(v: boolean): void {
  current = v
  try {
    browserStorage()?.setItem(STRAIGHTEN_KEY, String(v)) // blocked storage: this session only
  } catch {
    // kept for this session only
  }
  listeners.forEach((fn) => fn())
}
