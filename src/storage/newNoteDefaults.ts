// The default background and orientation of the next new note: a device setting
// (localStorage), kept apart from note data so logout and disconnect leave it.
import { BACKGROUNDS } from '../model/note'

export const NEW_NOTE_DEFAULTS_KEY = 'kkeujeok.newNote.defaults'
export const ORIENTATIONS = ['portrait', 'landscape'] as const

export type Background = (typeof BACKGROUNDS)[number]
export type Orientation = (typeof ORIENTATIONS)[number]
export type NewNoteDefaults = { background: Background; orientation: Orientation }
type Store = Pick<Storage, 'getItem' | 'setItem'>

const FALLBACK: NewNoteDefaults = { background: 'plain', orientation: 'portrait' }

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function createNewNoteDefaults(storage: Store | undefined = browserStorage()) {
  // What this session created wins over the stored value, even when saving it failed.
  let session: NewNoteDefaults | null = null
  return {
    read(): NewNoteDefaults {
      if (session) return { ...session }
      try {
        const raw = JSON.parse(storage?.getItem(NEW_NOTE_DEFAULTS_KEY) ?? 'null') as Partial<NewNoteDefaults> | null
        return {
          background: BACKGROUNDS.find((b) => b === raw?.background) ?? FALLBACK.background,
          orientation: ORIENTATIONS.find((o) => o === raw?.orientation) ?? FALLBACK.orientation,
        }
      } catch {
        return { ...FALLBACK }
      }
    },
    write(d: NewNoteDefaults): void {
      session = { ...d }
      try {
        storage?.setItem(NEW_NOTE_DEFAULTS_KEY, JSON.stringify(d))
      } catch {
        // kept for this session only
      }
    },
  }
}
