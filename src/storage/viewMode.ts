// How the pages are laid out (spec page-view): three axes, a device setting (localStorage), not in the note and not synced, so logout leaves it.
export const PAGE_VIEW_KEY = 'kkeujeok.pageView'
/** The old single-value key: read only, never rewritten or deleted. */
export const VIEW_MODE_KEY = 'kkeujeok.viewMode'
export type PageViewMode = { pagination: 'scroll' | 'turn'; direction: 'vertical' | 'horizontal'; pages: 1 | 2 }
/** The three old modes; the ⋯ menu radios map onto these until 31.6. */
export const VIEW_PRESETS = {
  vertical: { pagination: 'scroll', direction: 'vertical', pages: 1 },
  horizontal: { pagination: 'scroll', direction: 'horizontal', pages: 1 },
  twoPage: { pagination: 'scroll', direction: 'horizontal', pages: 2 },
} as const satisfies Record<string, PageViewMode>
export type PresetName = keyof typeof VIEW_PRESETS
export const PRESET_NAMES = Object.keys(VIEW_PRESETS) as PresetName[]
export const DEFAULT_VIEW: PageViewMode = VIEW_PRESETS.vertical
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** A valid new value (three allowed fields; `pages` the number 1 or 2), else null. */
function valid(v: unknown): PageViewMode | null {
  const o = v as Record<string, unknown> | null
  if (typeof o !== 'object' || o === null) return null
  const { pagination, direction, pages } = o
  if ((pagination !== 'scroll' && pagination !== 'turn') || (direction !== 'vertical' && direction !== 'horizontal') || (pages !== 1 && pages !== 2)) return null
  return { pagination, direction, pages }
}

/** Spec pageview.migrate: a valid new value wins, else the old string is mapped, else the default. */
export function migrateView(old: unknown, next: unknown): PageViewMode {
  return valid(next) ?? (typeof old === 'string' && Object.hasOwn(VIEW_PRESETS, old) ? { ...VIEW_PRESETS[old as PresetName] } : { ...DEFAULT_VIEW })
}

/** What the screen shows: a phone (shortest side < 600) shows 1 page; the stored value is kept. */
export function effectiveView(m: PageViewMode, screen?: { w: number; h: number }): PageViewMode {
  return screen && Math.min(screen.w, screen.h) < 600 && m.pages !== 1 ? { ...m, pages: 1 } : m
}

const json = (raw: string | null | undefined): unknown => {
  try {
    return raw == null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

export type ViewModeStore = ReturnType<typeof createViewMode>

export function createViewMode(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: PageViewMode | null = null
  return {
    read(): PageViewMode {
      if (session) return session
      try {
        const old = (json(storage?.getItem(VIEW_MODE_KEY)) as { mode?: unknown } | null)?.mode
        return migrateView(old, json(storage?.getItem(PAGE_VIEW_KEY)))
      } catch {
        return { ...DEFAULT_VIEW }
      }
    },
    write(mode: PageViewMode): PageViewMode {
      session = mode
      try {
        storage?.setItem(PAGE_VIEW_KEY, JSON.stringify(mode))
      } catch {
        // kept for this session only
      }
      return mode
    },
  }
}

let shared: ViewModeStore | undefined
export const sharedViewMode = () => (shared ??= createViewMode())
