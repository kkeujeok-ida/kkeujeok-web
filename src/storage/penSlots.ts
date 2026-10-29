// The pen slot list: a device setting (localStorage), kept apart from note data
// so logout and disconnect leave it.
import { PEN_WIDTH, defaultPenSlots, type Pen } from '../model/pen'

export const PEN_SLOTS_KEY = 'kkeujeok.pen.slots'
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

// Throws nothing; null when the list or any slot is not valid. A slot without `tool` is a pen (older value).
function parse(raw: string | null | undefined): Pen[] | null {
  if (raw == null) return null
  const list: unknown = JSON.parse(raw)
  if (!Array.isArray(list) || list.length === 0) return null
  const pens: Pen[] = []
  for (const e of list as Record<string, unknown>[]) {
    const { color, width, usePressure, tool = 'pen' } = e ?? {}
    if (tool !== 'pen' && tool !== 'highlighter') return null
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return null
    if (typeof width !== 'number' || !(width >= PEN_WIDTH[tool].min && width <= PEN_WIDTH[tool].max)) return null
    if (typeof usePressure !== 'boolean') return null
    pens.push({ tool, color, width, usePressure })
  }
  return pens
}

export type PenSlotsStore = ReturnType<typeof createPenSlots>

export function createPenSlots(storage: Store | undefined = browserStorage()) {
  // What this session wrote wins over the stored value, even when saving it failed.
  let session: Pen[] | null = null
  const copy = (l: readonly Pen[]) => l.map((p) => ({ ...p }))
  return {
    /** The default slots when nothing valid is stored. */
    read(): Pen[] {
      if (session) return copy(session)
      try {
        return parse(storage?.getItem(PEN_SLOTS_KEY)) ?? copy(defaultPenSlots)
      } catch {
        return copy(defaultPenSlots)
      }
    },
    write(slots: readonly Pen[]): void {
      session = copy(slots)
      try {
        storage?.setItem(PEN_SLOTS_KEY, JSON.stringify(slots.map(({ tool, color, width, usePressure }) => ({ tool, color, width, usePressure }))))
      } catch {
        // kept for this session only
      }
    },
  }
}

let shared: PenSlotsStore | undefined
export const sharedPenSlots = () => (shared ??= createPenSlots())
