// How the note list is shown: a device setting (localStorage), not in the note and not synced, so logout leaves it.
export const LIBRARY_VIEW_KEY = 'kkeujeok.libraryView'
export const LIBRARY_LAYOUTS = ['grid', 'list'] as const
export const LIBRARY_SIZES = ['small', 'standard', 'large'] as const
export type LibraryLayout = (typeof LIBRARY_LAYOUTS)[number]
export type LibrarySize = (typeof LIBRARY_SIZES)[number]
export type LibraryView = { layout: LibraryLayout; size: LibrarySize }
/** The original card flow. */
export const LIBRARY_VIEW_DEFAULT: LibraryView = { layout: 'list', size: 'large' }
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Anything but known names for both gives the default. */
export function parseLibraryView(raw: string | null | undefined): LibraryView {
  if (raw == null) return LIBRARY_VIEW_DEFAULT
  const m = (JSON.parse(raw) as Partial<Record<keyof LibraryView, unknown>> | null) ?? {}
  const layout = LIBRARY_LAYOUTS.find((v) => v === m.layout)
  const size = LIBRARY_SIZES.find((v) => v === m.size)
  return layout && size ? { layout, size } : LIBRARY_VIEW_DEFAULT
}

export type LibraryViewStore = ReturnType<typeof createLibraryView>

export function createLibraryView(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: LibraryView | null = null
  return {
    read(): LibraryView {
      if (session) return session
      try {
        return parseLibraryView(storage?.getItem(LIBRARY_VIEW_KEY))
      } catch {
        return LIBRARY_VIEW_DEFAULT
      }
    },
    write(v: LibraryView): void {
      session = v
      try {
        storage?.setItem(LIBRARY_VIEW_KEY, JSON.stringify(v))
      } catch {
        // kept for this session only
      }
    },
  }
}

let shared: LibraryViewStore | undefined
export const sharedLibraryView = () => (shared ??= createLibraryView())
