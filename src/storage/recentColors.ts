// Recently used pen colors: a device setting (localStorage), one list for pens and highlighters,
// kept apart from note data so logout leaves it.
export const RECENT_COLORS_KEY = 'kkeujeok.pen.recent'
export const MAX_RECENT_COLORS = 6
type Store = Pick<Storage, 'getItem' | 'setItem'>

const HEX = /^#[0-9a-fA-F]{6}$/

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

// Invalid entries are dropped; a broken value gives an empty list.
function parse(raw: string | null | undefined): string[] {
  if (raw == null) return []
  const list: unknown = JSON.parse(raw)
  if (!Array.isArray(list)) return []
  return list.filter((c): c is string => typeof c === 'string' && HEX.test(c)).map((c) => c.toLowerCase()).slice(0, MAX_RECENT_COLORS)
}

export type RecentColorsStore = ReturnType<typeof createRecentColors>

export function createRecentColors(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: string[] | null = null
  const read = (): string[] => {
    if (session) return [...session]
    try {
      return parse(storage?.getItem(RECENT_COLORS_KEY))
    } catch {
      return []
    }
  }
  return {
    read,
    /** `hex` goes to the front (lower case); a color already there moves; the oldest falls off. Returns the new list. */
    push(hex: string): string[] {
      if (!HEX.test(hex)) return read()
      const c = hex.toLowerCase()
      session = [c, ...read().filter((x) => x !== c)].slice(0, MAX_RECENT_COLORS)
      try {
        storage?.setItem(RECENT_COLORS_KEY, JSON.stringify(session))
      } catch {
        // kept for this session only
      }
      return [...session]
    },
  }
}

let shared: RecentColorsStore | undefined
export const sharedRecentColors = () => (shared ??= createRecentColors())
