// How many tools the toolbar shows at once: a device setting (localStorage), not in the note and not synced, so logout leaves it.
export const VISIBLE_TOOLS_KEY = 'kkeujeok.toolbarVisibleTools'
export const VISIBLE_TOOLS_DEFAULT = 7
export const VISIBLE_TOOLS_MIN = 3
export const VISIBLE_TOOLS_MAX = 12
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Anything but a number gives the default; a number is rounded and kept in 3..12. */
export const clampVisibleTools = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(VISIBLE_TOOLS_MAX, Math.max(VISIBLE_TOOLS_MIN, Math.round(v))) : VISIBLE_TOOLS_DEFAULT

const parse = (raw: string | null | undefined): number => (raw == null ? VISIBLE_TOOLS_DEFAULT : clampVisibleTools((JSON.parse(raw) as { n?: unknown } | null)?.n))

export type VisibleToolsStore = ReturnType<typeof createVisibleTools>

export function createVisibleTools(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: number | null = null
  return {
    read(): number {
      if (session !== null) return session
      try {
        return parse(storage?.getItem(VISIBLE_TOOLS_KEY))
      } catch {
        return VISIBLE_TOOLS_DEFAULT
      }
    },
    write(n: number): number {
      session = clampVisibleTools(n)
      try {
        storage?.setItem(VISIBLE_TOOLS_KEY, JSON.stringify({ n: session }))
      } catch {
        // kept for this session only
      }
      return session
    },
  }
}

let shared: VisibleToolsStore | undefined
export const sharedVisibleTools = () => (shared ??= createVisibleTools())
