import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from 'react'
import type { Dock, ToolbarPos, ToolbarPositionStore } from '../../storage/toolbarPosition'
import { DOCKS, applyDock, centerOf, clampCenter, dockRect, nearestDock, ratioOf, sizeAt, type Pt, type Size } from './toolbarDock'

/** A press that moves farther than this many px starts dragging the toolbar. */
const DRAG_PX = 6
const winSize = (): Size => ({ w: window.innerWidth, h: window.innerHeight })

export type Outline = { dock: Dock; left: number; top: number; width: number; height: number; near: boolean }

/** The toolbar's place: the stored position, the window and toolbar measures, and dragging the handle. */
export function useToolbarDock(store: ToolbarPositionStore, bar: RefObject<HTMLElement | null>, active: boolean) {
  const [pos, setPos] = useState<ToolbarPos>(() => store.read())
  const [win, setWin] = useState<Size>(winSize)
  const [size, setSize] = useState<Size>({ w: 0, h: 0 })
  const [drag, setDrag] = useState<{ center: Pt } | null>(null)
  const press = useRef<{ id: number; x: number; y: number; off: Pt; on: boolean } | null>(null)
  const justDragged = useRef(false)

  useEffect(() => {
    const on = () => setWin(winSize())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const measure = useCallback(() => {
    const r = bar.current?.getBoundingClientRect()
    if (r && r.width > 0 && r.height > 0) setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }))
  }, [bar])
  useLayoutEffect(measure, [measure, pos, win, active])
  useEffect(() => {
    const el = bar.current
    if (!el || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [bar, measure, active])

  const cancel = useCallback(() => {
    press.current = null
    setDrag(null)
  }, [])
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      // The button is still held: its release must not click the handle open (cleared on that release).
      justDragged.current = true
      cancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [drag, cancel])

  const commit = (next: ToolbarPos) => setPos(store.write(next))
  const vertical = pos.vertical
  const shape = sizeAt(vertical, size)
  const center = drag ? clampCenter(drag.center, shape, win) : centerOf(pos, size, win)
  const floating = pos.dock !== 'top' || !!drag
  const style: CSSProperties | undefined = floating && size.w > 0 ? { left: center.x, top: center.y } : undefined
  const near = drag ? nearestDock(drag.center, size, win) : null
  const outlines: Outline[] = drag
    ? DOCKS.map((d) => {
        const r = dockRect(d, size, win)
        return { dock: d, left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top, near: d === near }
      })
    : []

  const handleProps = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      const r = bar.current?.getBoundingClientRect()
      if (e.button !== 0 || !r) return
      press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, off: { x: e.clientX - (r.left + r.right) / 2, y: e.clientY - (r.top + r.bottom) / 2 }, on: false }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const p = press.current
      if (!p || p.id !== e.pointerId) return
      if (!p.on) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= DRAG_PX) return
        p.on = true
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }
      setDrag({ center: { x: e.clientX - p.off.x, y: e.clientY - p.off.y } })
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const p = press.current
      if (!p && justDragged.current) setTimeout(() => (justDragged.current = false), 0)
      if (!p || p.id !== e.pointerId) return
      press.current = null
      if (!p.on) return
      justDragged.current = true
      setTimeout(() => (justDragged.current = false), 0)
      const c = { x: e.clientX - p.off.x, y: e.clientY - p.off.y }
      const d = nearestDock(c, size, win)
      commit(d ? applyDock(pos, d) : { dock: 'float', ...ratioOf(clampCenter(c, shape, win), win), vertical: pos.vertical })
      setDrag(null)
    },
    onPointerCancel: () => cancel(),
  }

  // Which side the position menu opens on, toward the free room.
  const menuSide: 'below' | 'above' | 'right' | 'left' =
    pos.dock === 'top' ? 'below' : pos.dock === 'bottom' ? 'above' : pos.dock === 'left' ? 'right' : pos.dock === 'right' ? 'left' : center.y > win.h / 2 ? 'above' : 'below'

  return {
    pos,
    vertical,
    style,
    dragging: !!drag,
    floating,
    outlines,
    handleProps,
    menuSide,
    clickWasDrag: () => justDragged.current,
    dockTo: (d: Dock) => commit(applyDock(pos, d)),
  }
}
export type ToolbarDock = ReturnType<typeof useToolbarDock>
