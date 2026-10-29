import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { placeBubble, type Placement } from './bubblePlace'

/** The tail's box: on the bubble's edge facing the bar (placeBubble keeps `tail` off the corners). */
const tailAt = (p: Placement & { w: number; h: number }) => {
  const along = (p.tail ?? 0) - 8
  if (p.side === 'down') return { left: p.left + along, top: p.top - 8 }
  if (p.side === 'up') return { left: p.left + along, top: p.top + p.h }
  if (p.side === 'right') return { left: p.left - 8, top: p.top + along }
  return { left: p.left + p.w, top: p.top + along }
}

/**
 * The modal shell of the toolbar popovers: a scrim that takes the pointer, a speech bubble on the tool button `anchor` (placement: bubblePlace.ts; its tail is a sibling span), Tab cycling the `[tabindex="0"]` stops inside, Esc and a press outside close it.
 * The owner puts focus back in onClose. `relayout` changes when the content's height may have changed.
 */
export function PopoverShell({ anchor, onClose, labelledBy, className, relayout, children }: {
  anchor: HTMLElement | null
  onClose: () => void
  labelledBy: string
  className: string
  relayout?: string | number
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Placement & { w: number; h: number }>()
  // Measured after render (the height depends on the content) and again on resize or when `relayout` changes.
  const place = () => {
    const bar = anchor?.closest('[role="toolbar"]')?.getBoundingClientRect()
    const b = box.current
    if (!anchor || !bar || !b) return
    const [w, h] = [b.offsetWidth, b.offsetHeight]
    setPos({ ...placeBubble(bar, anchor.getBoundingClientRect(), { w, h }, { w: window.innerWidth, h: window.innerHeight }), w, h })
  }
  useLayoutEffect(place, [anchor, relayout]) // eslint-disable-line react-hooks/exhaustive-deps -- place reads the current anchor
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
      const stops = Array.from(box.current?.querySelectorAll<HTMLElement>('[tabindex="0"]') ?? [])
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
      {pos && pos.tail !== null && <span className="pen-popover-tail" data-side={pos.side} style={tailAt(pos)} />}
    </div>
  )
}
