// Eraser settings: a device setting (localStorage), not in the note and not synced, so logout leaves it.
export const ERASER_KEY = 'kkeujeok.eraser'
/** The eraser diameter in pt (the device default of spec/erase.md; no UI to change it). */
export const ERASER_WIDTH = 12
export type EraserMode = 'stroke' | 'partial'
export type EraserSettings = { mode: EraserMode; returnToPen: boolean }
type Store = Pick<Storage, 'getItem' | 'setItem'>

const DEFAULTS: EraserSettings = { mode: 'stroke', returnToPen: false }

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

// A value that is not exactly {mode, returnToPen} of the right types is the defaults.
function parse(raw: string | null | undefined): EraserSettings {
  if (raw == null) return { ...DEFAULTS }
  const v = JSON.parse(raw) as Record<string, unknown> | null
  const ok = v && (v.mode === 'stroke' || v.mode === 'partial') && typeof v.returnToPen === 'boolean'
  return ok ? { mode: v.mode as EraserMode, returnToPen: v.returnToPen as boolean } : { ...DEFAULTS }
}

export type EraserSettingsStore = ReturnType<typeof createEraserSettings>

export function createEraserSettings(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: EraserSettings | null = null
  const read = (): EraserSettings => {
    if (session) return { ...session }
    try {
      return parse(storage?.getItem(ERASER_KEY))
    } catch {
      return { ...DEFAULTS }
    }
  }
  return {
    read,
    write(patch: Partial<EraserSettings>): EraserSettings {
      session = { ...read(), ...patch }
      try {
        storage?.setItem(ERASER_KEY, JSON.stringify(session))
      } catch {
        // kept for this session only
      }
      return { ...session }
    },
  }
}

let shared: EraserSettingsStore | undefined
export const sharedEraserSettings = () => (shared ??= createEraserSettings())
