// The shape tool's own pen (spec/shape.md "Shape tool bar"): a device setting apart from the pen slots.
import { PEN_WIDTH, defaultShapePen, type Pen } from '../model/pen'

export const SHAPE_PEN_KEY = 'kkeujeok.pen.shape'
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

// Throws nothing the caller sees; null when nothing valid is stored.
function parse(raw: string | null | undefined): Pen | null {
  if (raw == null) return null
  const e = JSON.parse(raw) as Record<string, unknown> | null
  const { color, width, brush } = e ?? {}
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return null
  if (typeof width !== 'number' || !(width >= PEN_WIDTH.pen.min && width <= PEN_WIDTH.pen.max)) return null
  const ok = !!brush && typeof brush === 'object' && !Array.isArray(brush) && Object.keys(brush).length > 0
  return { ...defaultShapePen, color, width, ...(ok ? { brush: brush as Record<string, unknown> } : {}) }
}

export type ShapePenStore = ReturnType<typeof createShapePen>

export function createShapePen(storage: Store | undefined = browserStorage()) {
  let session: Pen | null = null
  const copy = (p: Pen): Pen => ({ ...p, ...(p.brush && { brush: structuredClone(p.brush) }) })
  return {
    /** The default when nothing valid is stored. */
    read(): Pen {
      if (session) return copy(session)
      try {
        return parse(storage?.getItem(SHAPE_PEN_KEY)) ?? copy(defaultShapePen)
      } catch {
        return copy(defaultShapePen)
      }
    },
    write(pen: Pen): void {
      session = copy(pen)
      try {
        storage?.setItem(SHAPE_PEN_KEY, JSON.stringify({ color: pen.color, width: pen.width, ...(pen.brush && { brush: pen.brush }) }))
      } catch {
        // kept for this session only
      }
    },
  }
}

let shared: ShapePenStore | undefined
export const sharedShapePen = () => (shared ??= createShapePen())
