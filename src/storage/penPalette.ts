import { PEN_PALETTE, type PenTool } from '../model/pen'

// The palette a person edited per tool: a device setting (localStorage), not in the note and not synced, so logout leaves it.
export const PALETTE_KEY = 'kkeujeok.penPalette'
export const PALETTE_MAX = 18 // 3 rows of 6
export const PALETTE_COLUMNS = 6
type Store = Pick<Storage, 'getItem' | 'setItem'>
type Saved = Partial<Record<PenTool, string[]>>

const HEX = /^#[0-9a-f]{6}$/i

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const defaults = (tool: PenTool) => [...PEN_PALETTE[tool].colors]

/** 1..18 valid `#rrggbb` (lowercased, no duplicates), else null. */
const valid = (v: unknown): string[] | null => {
  if (!Array.isArray(v) || v.length < 1 || v.length > PALETTE_MAX || !v.every((c) => typeof c === 'string' && HEX.test(c))) return null
  const list = v.map((c: string) => c.toLowerCase())
  return new Set(list).size === list.length ? list : null
}

export type PenPaletteStore = ReturnType<typeof createPenPalette>

export function createPenPalette(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  const session: Saved = {}
  const stored = (): Saved => {
    try {
      const raw = storage?.getItem(PALETTE_KEY)
      return raw ? ((JSON.parse(raw) as Saved | null) ?? {}) : {}
    } catch {
      return {}
    }
  }
  const read = (tool: PenTool): string[] => session[tool] ?? valid(stored()[tool]) ?? defaults(tool)
  return {
    read,
    /** An invalid list is ignored (the current palette is returned). */
    write(tool: PenTool, colors: readonly string[]): string[] {
      const list = valid(colors)
      if (!list) return read(tool)
      session[tool] = list
      try {
        storage?.setItem(PALETTE_KEY, JSON.stringify({ ...stored(), [tool]: list }))
      } catch {
        // kept for this session only
      }
      return list
    },
    reset: (tool: PenTool): string[] => {
      session[tool] = defaults(tool)
      try {
        storage?.setItem(PALETTE_KEY, JSON.stringify({ ...stored(), [tool]: undefined }))
      } catch {
        // kept for this session only
      }
      return session[tool]
    },
  }
}

let shared: PenPaletteStore | undefined
export const sharedPenPalette = () => (shared ??= createPenPalette())
