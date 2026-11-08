// Pressure curve: a device setting (localStorage), not in the note and not synced, so logout leaves it.
import { PRESETS, validCurveValues, type PressureCurve } from '../model/pressureCurve'

export const PRESSURE_CURVE_KEY = 'kkeujeok.pressureCurve'
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** A stored preset name or four valid values; anything else is `normal`. */
export function parseCurve(raw: string | null | undefined): PressureCurve {
  try {
    const v: unknown = raw == null ? null : JSON.parse(raw)
    if (typeof v === 'string' && (PRESETS as readonly string[]).includes(v)) return v as PressureCurve
    if (validCurveValues(v)) return v
  } catch {
    // falls through to normal
  }
  return 'normal'
}

let current: PressureCurve | null = null
const listeners = new Set<() => void>()

export function getPressureCurve(storage = browserStorage()): PressureCurve {
  if (current) return current // read once, so the snapshot is stable
  try {
    current = parseCurve(storage?.getItem(PRESSURE_CURVE_KEY))
  } catch {
    current = 'normal'
  }
  return current
}
export const subscribePressureCurve = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))

/** An invalid curve is not accepted (returns false). */
export function setPressureCurve(c: PressureCurve, storage = browserStorage()): boolean {
  if (typeof c !== 'string' && !validCurveValues(c)) return false
  current = c
  try {
    storage?.setItem(PRESSURE_CURVE_KEY, JSON.stringify(c)) // blocked storage: this session only
  } catch {
    // kept for this session only
  }
  listeners.forEach((fn) => fn())
  return true
}
