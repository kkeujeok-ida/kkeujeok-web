import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { getLeftHanded, subscribeLeftHanded } from '../../storage/leftHanded'
import { placeBubble, type Placement } from './bubblePlace'

/** The tail's box: on the bubble's edge facing the bar (placeBubble keeps `tail` off the corners). */
const tailAt = (p: Placement & { w: number; h: number }) => {
  const along = (p.tail ?? 0) - 8
  if (p.side === 'down') return { left: p.left + along, top: p.top - 8 }
  if (p.side === 'up') return { left: p.left + along, top: p.top + p.h }
  if (p.side === 'right') return { left: p.left - 8, top: p.top + along }
  return { left: p.left + p.w, top: p.top + along }
}

const ASIDE_MIN = 160 // the narrowest the aside may get before it scrolls sideways

/**
 * The modal shell of the toolbar popovers: a scrim that takes the pointer, a speech bubble on the tool button `tool` inside the toolbar `anchor` (placement: bubblePlace.ts; its tail is a sibling span), Tab cycling the `[tabindex="0"]` stops inside, Esc and a press outside close it.
 * The owner puts focus back in onClose. `relayout` changes when the content's height may have changed.
 */
export function PopoverShell({ anchor, tool, onClose, labelledBy, className, relayout, aside, children }: {
  anchor: HTMLElement | null // the toolbar
  tool: string // selector of the tool button inside it that the tail points at
  onClose: () => void
  labelledBy: string
  className: string
  relayout?: string | number
  /** Columns outside the bubble, to its right (advanced settings, presets). They come after the bubble in the Tab and reading order. */
  aside?: ReactNode
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const lefty = useSyncExternalStore(subscribeLeftHanded, getLeftHanded)
  const [pos, setPos] = useState<Placement & { w: number; h: number }>()
  const asideBox = useRef<HTMLDivElement>(null)
  const [asideH, setAsideH] = useState(0)
  useLayoutEffect(() => {
    const h = asideBox.current?.offsetHeight ?? 0
    if (h !== asideH) setAsideH(h)
  }) // the aside's height depends on its content; settles after one pass
  // Measured after render (the height depends on the content) and again on resize or when `relayout` changes.
  const place = () => {
    const bar = anchor?.closest('[role="toolbar"]')?.getBoundingClientRect()
    const b = box.current
    if (!anchor || !bar || !b) return
    const [w, h] = [b.offsetWidth, b.offsetHeight]
    setPos({ ...placeBubble(bar, (anchor.querySelector(tool) ?? anchor).getBoundingClientRect(), { w, h }, { w: window.innerWidth, h: window.innerHeight }, lefty), w, h })
  }
  useLayoutEffect(place, [anchor, relayout, lefty]) // eslint-disable-line react-hooks/exhaustive-deps -- place reads the current anchor
  useEffect(() => {
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      e.preventDefault() // the stops inside: [tabindex="0"], in document order
      const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[tabindex="0"]') ?? [])
      if (stops.length === 0) return
      const at = stops.indexOf(document.activeElement as HTMLElement)
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]!.focus()
    }
  }

  return (
    <div
      className="pen-popover-scrim"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={box}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={pos && { left: pos.left, top: pos.top }}
      >
        {children}
      </div>
      {pos && aside && (() => {
        // Beside the bubble, away from the toolbar: a bubble left of the bar (right-edge or left-handed bar) puts the aside further left, not on the bar.
        const roomR = window.innerWidth - (pos.left + pos.w + 8) - 12, roomL = pos.left - 8 - 12
        const toLeft = pos.side === 'left' || (roomR < ASIDE_MIN && roomL > roomR)
        const room = Math.max(ASIDE_MIN, toLeft ? roomL : roomR)
        return (
          <div
            ref={asideBox}
            className="pen-popover-aside"
            role="group"
            aria-labelledby={labelledBy}
            style={{ ...(toLeft ? { right: window.innerWidth - pos.left + 8 } : { left: pos.left + pos.w + 8 }), top: Math.max(12, Math.min(pos.top, window.innerHeight - asideH - 12)), maxWidth: room }}
          >
            {aside}
          </div>
        )
      })()}
      {pos && pos.tail !== null && <span className="pen-popover-tail" data-side={pos.side} style={tailAt(pos)} />}
    </div>
  )
}
