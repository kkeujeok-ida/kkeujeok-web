// User brush presets: a device setting (localStorage), not in the note and not synced (Story 25.6).
// A note stores the brush parameters its strokes used, so deleting a preset never changes a note.
import { PEN_TOOLS, PEN_WIDTH, type Pen, type PenTool } from '../model/pen'

export const BRUSH_PRESETS_KEY = 'kkeujeok.brushPresets'
export const MAX_PRESETS = 20
export const MAX_PRESET_NAME = 30

export type BrushPreset = { id: string; name: string; tool: PenTool; width: number; usePressure: boolean; brush?: Record<string, unknown> }
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Invalid entries are skipped, never the whole list. */
export function parsePresets(raw: string | null | undefined): BrushPreset[] {
  try {
    const list: unknown = raw == null ? [] : JSON.parse(raw)
    if (!Array.isArray(list)) return []
    const out: BrushPreset[] = []
    for (const e of list as Record<string, unknown>[]) {
      const { id, name, tool, width, usePressure, brush } = e ?? {}
      if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) continue
      if (!PEN_TOOLS.includes(tool as PenTool)) continue
      const r = PEN_WIDTH[tool as PenTool]
      if (typeof width !== 'number' || !(width >= r.min && width <= r.max) || typeof usePressure !== 'boolean') continue
      const ok = !!brush && typeof brush === 'object' && !Array.isArray(brush) && Object.keys(brush).length > 0
      out.push({ id, name: name.slice(0, MAX_PRESET_NAME), tool: tool as PenTool, width, usePressure, ...(ok ? { brush: brush as Record<string, unknown> } : {}) })
    }
    return out.slice(0, MAX_PRESETS)
  } catch {
    return []
  }
}

export function createBrushPresets(storage: Store | undefined = browserStorage()) {
  let session: BrushPreset[] | null = null // what this session wrote wins, even if saving failed
  const read = (): BrushPreset[] => {
    if (session) return structuredClone(session)
    try {
      return parsePresets(storage?.getItem(BRUSH_PRESETS_KEY))
    } catch {
      return []
    }
  }
  const write = (list: BrushPreset[]) => {
    session = structuredClone(list)
    try {
      storage?.setItem(BRUSH_PRESETS_KEY, JSON.stringify(list))
    } catch {
      // kept for this session only
    }
    return list
  }
  return {
    read,
    /** Saves the pen's settings under `name`; a full list or an empty name changes nothing (returns null). */
    save(name: string, pen: Pen, id: string = crypto.randomUUID()): BrushPreset[] | null {
      const n = name.trim().slice(0, MAX_PRESET_NAME)
      const list = read()
      if (!n || list.length >= MAX_PRESETS) return null
      const { tool, width, usePressure, brush } = pen
      return write([...list, { id, name: n, tool, width, usePressure, ...(brush ? { brush: structuredClone(brush) } : {}) }])
    },
    remove: (id: string): BrushPreset[] => write(read().filter((p) => p.id !== id)),
  }
}

let shared: ReturnType<typeof createBrushPresets> | undefined
export const sharedBrushPresets = () => (shared ??= createBrushPresets())
