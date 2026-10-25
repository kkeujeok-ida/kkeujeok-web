// How the pages are laid out: a device setting (localStorage), not in the note and not synced, so logout leaves it.
export const VIEW_MODE_KEY = 'kkeujeok.viewMode'
export type ViewMode = 'vertical' | 'horizontal' | 'twoPage'
export const VIEW_MODES: readonly ViewMode[] = ['vertical', 'horizontal', 'twoPage']
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const parse = (raw: string | null | undefined): ViewMode => {
  if (raw == null) return 'vertical'
  const m = (JSON.parse(raw) as { mode?: unknown } | null)?.mode
  return VIEW_MODES.find((v) => v === m) ?? 'vertical'
}

export type ViewModeStore = ReturnType<typeof createViewMode>

export function createViewMode(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: ViewMode | null = null
  return {
    read(): ViewMode {
      if (session) return session
      try {
        return parse(storage?.getItem(VIEW_MODE_KEY))
      } catch {
        return 'vertical'
      }
    },
    write(mode: ViewMode): ViewMode {
      session = mode
      try {
        storage?.setItem(VIEW_MODE_KEY, JSON.stringify({ mode }))
      } catch {
        // kept for this session only
      }
      return mode
    },
  }
}

let shared: ViewModeStore | undefined
export const sharedViewMode = () => (shared ??= createViewMode())
