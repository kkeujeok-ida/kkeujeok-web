// Left-handed: a per-browser setting (localStorage), not in the note and not synced. Popovers and menus open on the opposite side; the web page overview opens on the left.
export const LEFT_HANDED_KEY = 'kkeujeok.leftHanded'

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readLeftHanded(storage = browserStorage()): boolean {
  try {
    return storage?.getItem(LEFT_HANDED_KEY) === 'true'
  } catch {
    return false
  }
}

let current = readLeftHanded()
const listeners = new Set<() => void>()

export const getLeftHanded = () => current
export const subscribeLeftHanded = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))

export function setLeftHanded(v: boolean): void {
  current = v
  try {
    browserStorage()?.setItem(LEFT_HANDED_KEY, String(v)) // blocked storage: this session only
  } catch {
    // kept for this session only
  }
  listeners.forEach((fn) => fn())
}
