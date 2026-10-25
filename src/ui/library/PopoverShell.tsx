import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

/**
 * The modal shell of the toolbar popovers: a scrim that takes the pointer, a dialog placed below the toolbar of `anchor` (above it when that sits in the lower half)
 * (pushed up when it would run off the bottom), Tab cycling the `[tabindex="0"]` stops inside, Esc and a press outside close it.
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
  // Below the toolbar; pushed up when it would run off the bottom; recomputed on resize.
  const place = () => {
    const r = anchor?.closest('[role="toolbar"]')?.getBoundingClientRect()
    if (!r) return undefined
    const margin = 12
    const width = Math.min(320, window.innerWidth - margin * 2)
    if (r.height > r.width) {
      // A vertical toolbar: beside it, on the side with room, so it is not covered.
      const right = r.right + margin
      const left = right + width <= window.innerWidth - margin ? right : Math.max(margin, r.left - margin - width)
      return { above: null, top: Math.max(margin, r.top), left }
    }
    return {
      // A toolbar in the lower half of the window: the dialog goes above it.
      above: (r.top + r.bottom) / 2 > window.innerHeight / 2 ? r.top : null,
      top: Math.max(margin, r.bottom),
      left: Math.max(margin, Math.min(r.left, window.innerWidth - width - margin)),
    }
  }
  const [pos, setPos] = useState(place)
  const [top, setTop] = useState<number>()
  useEffect(() => {
    const on = () => setPos(place())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
    // place reads the current anchor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor])
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight
    if (pos && h) setTop(Math.max(12, Math.min(pos.above !== null ? pos.above - h : pos.top, window.innerHeight - 12 - 8 - h)))
  }, [pos, relayout])

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
        style={pos && { left: pos.left, top: top ?? pos.top }}
      >
        {children}
      </div>
    </div>
  )
}
