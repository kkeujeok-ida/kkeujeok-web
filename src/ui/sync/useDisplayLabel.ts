import { useEffect, useRef, useState } from 'react'
import type { DisplayLabel } from '../../sync/syncRules'

/** Once drawn, a busy label (`saving`, `receiving`) stays at least this long, so a short sync is still seen. */
export const SAVING_MIN_MS = 800
/** A polite status announcement at most this often (UX-DR85). */
export const ANNOUNCE_GAP_MS = 10_000

const busy = (l: DisplayLabel) => l === 'saving' || l === 'receiving'

/** The label to draw: `raw`, except that a busy label is drawn at once and then held. Timers die with the component. */
export function useDisplayLabel(raw: DisplayLabel): DisplayLabel {
  const [shown, setShown] = useState<DisplayLabel>(raw)
  const since = useRef(Date.now())
  useEffect(() => {
    if (shown === raw) return
    if (!busy(shown)) {
      if (busy(raw)) since.current = Date.now()
      setShown(raw)
      return
    }
    const id = setTimeout(() => {
      if (busy(raw)) since.current = Date.now()
      setShown(raw)
    }, Math.max(0, SAVING_MIN_MS - (Date.now() - since.current)))
    return () => clearTimeout(id)
  }, [raw, shown])
  return busy(raw) && !busy(shown) ? raw : shown // a busy label shows in the same render
}

/**
 * What to announce for the drawn label: nothing at first; a change is polite, at most once per
 * 10 s (the newest label goes out when the gap is over); entering `notSaved` is assertive at once.
 */
export function useAnnouncement(label: DisplayLabel, text: (l: DisplayLabel) => string): { polite: string; assertive: string } {
  const [out, setOut] = useState({ polite: '', assertive: '' })
  const prev = useRef(label)
  const last = useRef(-Infinity)
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    if (prev.current === label) return
    prev.current = label
    if (label === 'notSaved') {
      setOut({ polite: '', assertive: textRef.current(label) })
      return
    }
    const wait = Math.max(0, last.current + ANNOUNCE_GAP_MS - Date.now())
    const id = setTimeout(() => {
      last.current = Date.now()
      setOut({ polite: textRef.current(label), assertive: '' })
    }, wait)
    return () => clearTimeout(id)
  }, [label])
  return out
}
