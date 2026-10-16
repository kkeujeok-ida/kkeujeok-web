import { useEffect, useRef, useState } from 'react'
import type { DisplayLabel } from '../../sync/syncRules'

/** `saving` is drawn only after this long in `syncing` (UX-DR38). */
export const SAVING_DELAY_MS = 1000
/** Once drawn, `saving` stays at least this long. */
export const SAVING_MIN_MS = 600
/** A polite status announcement at most this often (UX-DR85). */
export const ANNOUNCE_GAP_MS = 10_000

/** The label to draw: `raw`, except that `saving` is delayed and then held. Timers die with the component. */
export function useDisplayLabel(raw: DisplayLabel): DisplayLabel {
  const [shown, setShown] = useState<DisplayLabel>(raw)
  const since = useRef(0)
  useEffect(() => {
    let id: ReturnType<typeof setTimeout> | undefined
    if (raw === 'saving') {
      if (shown !== 'saving') {
        id = setTimeout(() => {
          since.current = Date.now()
          setShown('saving')
        }, SAVING_DELAY_MS)
      }
    } else if (shown === 'saving') {
      id = setTimeout(() => setShown(raw), Math.max(0, SAVING_MIN_MS - (Date.now() - since.current)))
    } else if (shown !== raw) {
      setShown(raw)
    }
    return () => clearTimeout(id)
  }, [raw, shown])
  return shown
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
