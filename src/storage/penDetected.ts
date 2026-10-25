// Whether a pen was ever seen on this device: a device setting (localStorage), not in the note and not synced.
export const PEN_DETECTED_KEY = 'kkeujeok.penDetected'
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export type PenDetectedStore = ReturnType<typeof createPenDetected>

export function createPenDetected(storage: Store | undefined = browserStorage()) {
  let session = false
  return {
    read(): boolean {
      if (session) return true
      try {
        const raw = storage?.getItem(PEN_DETECTED_KEY)
        return raw != null && (JSON.parse(raw) as { detected?: unknown } | null)?.detected === true
      } catch {
        return false
      }
    },
    mark(): void {
      session = true
      try {
        storage?.setItem(PEN_DETECTED_KEY, JSON.stringify({ detected: true }))
      } catch {
        // kept for this session only
      }
    },
  }
}

let shared: PenDetectedStore | undefined
export const sharedPenDetected = () => (shared ??= createPenDetected())
