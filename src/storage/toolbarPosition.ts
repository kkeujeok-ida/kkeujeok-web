// Toolbar position: a device setting (localStorage), not in the note and not synced, so logout leaves it.
export const TOOLBAR_KEY = 'kkeujeok.toolbar'
export type Dock = 'top' | 'left' | 'right' | 'bottom'
/** x, y: the toolbar centre as a ratio of the window, only meaningful when dock is 'float'. */
export type ToolbarPos = { dock: Dock | 'float'; x: number; y: number; vertical: boolean }
type Store = Pick<Storage, 'getItem' | 'setItem'>

export const DEFAULT_POS: ToolbarPos = { dock: 'top', x: 0.5, y: 0, vertical: false }

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const ratio = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const round4 = (n: number) => Math.round(n * 10000) / 10000

// Anything that is not a whole, valid position is the default.
function parse(raw: string | null | undefined): ToolbarPos {
  if (raw == null) return { ...DEFAULT_POS }
  const v = JSON.parse(raw) as Record<string, unknown> | null
  const ok = v && ['top', 'left', 'right', 'bottom', 'float'].includes(v.dock as string) && ratio(v.x) && ratio(v.y) && typeof v.vertical === 'boolean'
  if (!ok) return { ...DEFAULT_POS }
  const dock = v.dock as ToolbarPos['dock']
  // A docked toolbar's orientation follows its side; only a floating one remembers its own.
  const vertical = dock === 'float' ? (v.vertical as boolean) : dock === 'left' || dock === 'right'
  return { dock, x: v.x as number, y: v.y as number, vertical }
}

export type ToolbarPositionStore = ReturnType<typeof createToolbarPosition>

export function createToolbarPosition(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: ToolbarPos | null = null
  const read = (): ToolbarPos => {
    if (session) return { ...session }
    try {
      return parse(storage?.getItem(TOOLBAR_KEY))
    } catch {
      return { ...DEFAULT_POS }
    }
  }
  return {
    read,
    write(pos: ToolbarPos): ToolbarPos {
      session = { ...pos, x: round4(pos.x), y: round4(pos.y) }
      try {
        storage?.setItem(TOOLBAR_KEY, JSON.stringify(session))
      } catch {
        // kept for this session only
      }
      return { ...session }
    },
  }
}

let shared: ToolbarPositionStore | undefined
export const sharedToolbarPosition = () => (shared ??= createToolbarPosition())
