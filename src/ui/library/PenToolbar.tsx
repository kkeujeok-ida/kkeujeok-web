import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type Ref } from 'react'
import { colorNameKey, type Pen } from '../../model/pen'
import { fmt, useI18n } from '../../i18n'
import type { EraserMode } from '../../storage/eraserSettings'
import { sharedVisibleTools } from '../../storage/toolbarVisibleTools'
import type { Dock } from '../../storage/toolbarPosition'
import type { ToolbarDock } from './useToolbarDock'

const DOCK_KEYS = { top: 'editor.dockTop', left: 'editor.dockLeft', right: 'editor.dockRight', bottom: 'editor.dockBottom' } as const
/** Without an owner the toolbar stays on top and the handle's menu does nothing. */
const STATIC_DOCK = { pos: { dock: 'top', x: 0.5, y: 0, vertical: false }, vertical: false, style: undefined, dragging: false, floating: false, outlines: [], handleProps: {}, menuSide: 'below', clickWasDrag: () => false, dockTo: () => {} } as unknown as ToolbarDock
const DOCK_ORDER: Dock[] = ['top', 'left', 'right', 'bottom']

/** A press that moves farther than this many px starts dragging the slot. */
const DRAG_PX = 6

/**
 * The floating toolbar: grip (inert, hidden from the a11y tree) | pen slots |
 * divider | undo, redo. Slots are one radiogroup; activating the selected one
 * opens the pen popover (onEdit). The slot buttons carry data-slot for the owner.
 */
export function PenToolbar({ pens, selected, onSelect, onEdit, onAdd, onMove, tool, onToolChange, eraserMode, onEraserEdit, onImage, dock = STATIC_DOCK, onDocked, canUndo, canRedo, onUndo, onRedo, readOnly = false, ref }: {
  pens: readonly Pen[]
  selected: number
  onSelect: (i: number) => void
  onEdit: (i: number) => void
  /** [+]: the owner copies the selected slot to the end. */
  onAdd: () => void
  /** A slot dragged or moved with Alt+arrows from one place to another. */
  onMove: (from: number, to: number) => void
  /** The lasso and the text tool are toggles: pressed = that tool, else the pen. The lasso works read-only too (selecting changes nothing); the text tool does not. */
  tool: 'pen' | 'eraser' | 'lasso' | 'text'
  onToolChange: (t: 'pen' | 'eraser' | 'lasso' | 'text') => void
  /** The eraser works per stroke or partly: shown in its name and icon. Clicking the selected eraser calls onEraserEdit (its popover). */
  eraserMode: EraserMode
  onEraserEdit: () => void
  /** [이미지]: opens the file picker (Story 4.13). Without it (no image host) the button is off. */
  onImage?: () => void
  /** Where the toolbar sits and how the handle drags it (the owner holds it for the snap outlines). */
  dock?: ToolbarDock
  /** The position menu docked the toolbar at a side. */
  onDocked?: (d: Dock) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** Another tab is editing: slots and history are shown but off. */
  readOnly?: boolean
  ref?: Ref<HTMLDivElement>
}) {
  const { t } = useI18n()
  // Roving tab index: one toolbar item is a tab stop, the arrows move between items.
  const [stop, setStop] = useState('')
  const keys = ['handle', ...pens.map((_, i) => `slot-${i}`), 'add', 'undo', 'redo', 'eraser', 'lasso', 'text', 'image']
  const tabKey = keys.includes(stop) ? stop : `slot-${selected}`
  const rv = (key: string) => ({ 'data-roving': key, tabIndex: key === tabKey ? 0 : -1 })
  const slotsEl = useRef<HTMLDivElement>(null)
  const vertical = dock.vertical
  const [menu, setMenu] = useState(false)
  const handle = useRef<HTMLButtonElement>(null)
  const menuEl = useRef<HTMLDivElement>(null)
  const current = DOCK_ORDER.includes(dock.pos.dock as Dock) ? (dock.pos.dock as Dock) : null
  // The menu opens on the current item (the top one when floating).
  useLayoutEffect(() => {
    if (menu) menuEl.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[Math.max(0, DOCK_ORDER.indexOf(current ?? 'top'))]?.focus()
    // only when it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const down = (e: globalThis.PointerEvent) => {
      if (!menuEl.current?.contains(e.target as Node) && !handle.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [menu])
  // Starting a drag closes the menu.
  useEffect(() => {
    if (dock.dragging) setMenu(false)
  }, [dock.dragging])
  const closeMenu = () => {
    setMenu(false)
    handle.current?.focus()
  }
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : e.key === 'ArrowUp' ? Math.max(0, at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1
    if (to >= 0) items[to]?.focus()
    else if (e.key === 'Escape' || e.key === 'Tab') closeMenu()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  const refocus = useRef<number | null>(null)
  const drag = useRef<{ id: number; from: number; x: number; y: number; on: boolean } | null>(null)
  const justDragged = useRef(false)
  const [dx, setDx] = useState<{ from: number; dx: number } | null>(null)
  const slotEl = (i: number) => slotsEl.current?.querySelector<HTMLElement>(`[data-slot="${i}"]`)
  useEffect(() => {
    if (refocus.current !== null) slotEl(refocus.current)?.focus()
    refocus.current = null
  })
  // The selected slot (a new one, a key) is kept in view of the scrolling slot area.
  useEffect(() => {
    slotEl(selected)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selected, pens.length])
  // The wheel scrolls the slot area sideways, only when it overflows.
  useEffect(() => {
    const el = slotsEl.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (vertical) {
        // Vertical: the wheel scrolls the slot area as it is, only when it overflows.
        if (el.scrollHeight <= el.clientHeight) return
        e.preventDefault()
        el.scrollTop += e.deltaY
        return
      }
      if (e.deltaX !== 0 || e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [vertical])
  const onToolbarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-roving]')
    if (!item || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.shiftKey) return
    const [back, fwd] = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
    const dir = e.key === back ? -1 : e.key === fwd ? 1 : 0
    const slot = item.dataset.slot
    if (e.altKey) {
      if (!dir || slot === undefined) return
      e.preventDefault()
      const from = Number(slot)
      const to = from + dir
      if (readOnly || to < 0 || to >= pens.length) return
      refocus.current = to
      onMove(from, to)
      return
    }
    if (!dir && e.key !== 'Home' && e.key !== 'End') return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-roving]')]
    const at = items.indexOf(item)
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + dir))
    e.preventDefault()
    items[to]?.focus()
  }
  const endDrag = (e: PointerEvent<HTMLButtonElement>, drop: boolean) => {
    const d = drag.current
    drag.current = null
    setDx(null)
    if (!d?.on) return
    justDragged.current = true
    setTimeout(() => (justDragged.current = false), 0)
    const bar = e.currentTarget.closest('.pen-toolbar')?.getBoundingClientRect()
    if (!drop || !bar || e.clientX < bar.left || e.clientX > bar.right || e.clientY < bar.top || e.clientY > bar.bottom) return
    // The slot place nearest to where it was dropped.
    let to = d.from
    let best = Infinity
    pens.forEach((_, i) => {
      const r = slotEl(i)?.getBoundingClientRect()
      // The dragged slot is measured where it sits without its translateX.
      const shift = i === d.from ? (vertical ? e.clientY - d.y : e.clientX - d.x) : 0
      const gap = r ? Math.abs((vertical ? e.clientY : e.clientX) - (vertical ? (r.top + r.bottom) / 2 : (r.left + r.right) / 2) + shift) : Infinity
      if (gap < best) [best, to] = [gap, i]
    })
    if (to !== d.from) {
      refocus.current = to
      onMove(d.from, to)
    }
  }
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('editor.toolbar')}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={'pen-toolbar' + (vertical ? ' is-vertical' : '') + (dock.floating ? ' is-floating' : '') + (dock.dragging ? ' is-dragging' : '')}
      style={dock.style}
      onKeyDown={onToolbarKey}
      onFocus={(e: FocusEvent<HTMLDivElement>) => {
        const k = (e.target as HTMLElement).closest<HTMLElement>('[data-roving]')?.dataset.roving
        if (k) setStop(k)
      }}
    >
      <button
        ref={handle}
        type="button"
        className="toolbar-grip"
        aria-label={t('editor.toolbarMove')}
        title={t('editor.toolbarMove')}
        aria-haspopup="menu"
        aria-expanded={menu}
        {...rv('handle')}
        {...dock.handleProps}
        onClick={() => {
          if (dock.clickWasDrag()) return // the click that ends a drag
          setMenu((o) => !o)
        }}
      >
        <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
          {/* Horizontal ⋯ when the bar is vertical (a 90 degree turn), see spec/toolbar-orientation.md */}
          {[3.5, 8, 12.5].map((p) => (
            <circle key={p} cx={vertical ? p : 8} cy={vertical ? 8 : p} r="1.25" fill="currentColor" />
          ))}
        </svg>
      </button>
      {menu && (
        <div ref={menuEl} role="menu" aria-label={t('editor.toolbarPosition')} className={`toolbar-position-menu menu-${dock.menuSide}`} onKeyDown={onMenuKey}>
          {DOCK_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              role="menuitemradio"
              aria-checked={current === d}
              tabIndex={-1}
              className="editor-menu-item"
              onClick={() => {
                dock.dockTo(d)
                onDocked?.(d)
                closeMenu()
              }}
            >
              {t(DOCK_KEYS[d])}
            </button>
          ))}
        </div>
      )}
      <div ref={slotsEl} role="radiogroup" className="pen-slots" style={{ '--visible-tools': sharedVisibleTools().read() } as CSSProperties}>
        {pens.map((pen, i) => {
          const label = fmt(t(pen.tool === 'highlighter' ? 'editor.highlighterSlot' : 'editor.penSlot'), { color: t(colorNameKey(pen.color)), width: pen.width.toFixed(1), n: i + 1 })
          const on = i === selected
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={label}
              aria-disabled={readOnly || undefined}
              title={readOnly ? t('editor.readOnlyTip') : label}
              data-slot={i}
              className={(on ? 'pen-slot pen-slot-selected' : 'pen-slot') + (dx?.from === i ? ' pen-slot-dragging' : '')}
              style={dx?.from === i ? { transform: vertical ? `translateY(${dx.dx}px)` : `translateX(${dx.dx}px)` } : undefined}
              {...rv(`slot-${i}`)}
              onFocus={(e) => e.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}
              onPointerDown={(e) => {
                if (!readOnly && e.button === 0) drag.current = { id: e.pointerId, from: i, x: e.clientX, y: e.clientY, on: false }
              }}
              onPointerMove={(e) => {
                const d = drag.current
                if (!d || d.id !== e.pointerId) return
                if (!d.on) {
                  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= DRAG_PX) return
                  d.on = true
                  e.currentTarget.setPointerCapture?.(e.pointerId)
                }
                setDx({ from: d.from, dx: vertical ? e.clientY - d.y : e.clientX - d.x })
              }}
              onPointerUp={(e) => endDrag(e, true)}
              onPointerCancel={(e) => endDrag(e, false)}
              onClick={() => {
                if (justDragged.current) return // the click that ends a drag
                if (readOnly) return
                if (on) onEdit(i)
                else onSelect(i)
              }}
            >
              <svg className="pen-nib" viewBox="0 0 20 36" aria-hidden="true">
                <path
                  d={pen.tool === 'highlighter' ? 'M3 0V22.3L6 36H14L17 22.3V0M3 22.3H17' : 'M3 0V22.3L10 36L17 22.3V0M3 22.3H17'}
                  fill="none"
                  stroke={pen.color}
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
              <span className="pen-width" aria-hidden="true">{pen.width.toFixed(1)}</span>
              {on && (
                <svg className="pen-caret" viewBox="0 0 8 4" aria-hidden="true">
                  <path d="M0 0H8L4 4Z" fill="currentColor" />
                </svg>
              )}
              {on && <span className="pen-underline" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        aria-label={t('editor.addSlot')}
        title={readOnly ? t('editor.readOnlyTip') : t('editor.addSlotTip')}
        aria-disabled={readOnly || undefined}
        className="pen-add"
        {...rv('add')}
        onClick={() => !readOnly && onAdd()}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor" />
        </svg>
      </button>
      <span className="toolbar-divider" aria-hidden="true" />
      {(
        [
          ['undo', canUndo, onUndo, 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z'],
          ['redo', canRedo, onRedo, 'M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z'],
        ] as const
      ).map(([name, enabled, run, d]) => (
        <button
          key={name}
          type="button"
          // aria-disabled, not disabled: focus stays on the button.
          aria-disabled={!enabled}
          aria-label={t(`editor.${name}`)}
          title={readOnly ? t('editor.readOnlyTip') : t(`editor.${name}Tip`)}
          className={enabled ? 'toolbar-action' : 'toolbar-action toolbar-action-disabled'}
          {...rv(name)}
          onClick={() => enabled && run()}
        >
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d={d} fill="currentColor" />
          </svg>
        </button>
      ))}
      <button
        type="button"
        aria-pressed={tool === 'eraser'}
        aria-label={fmt(t('editor.eraserLabel'), { mode: t(eraserMode === 'partial' ? 'editor.eraserPartial' : 'editor.eraserStroke') })}
        title={readOnly ? t('editor.readOnlyTip') : t('editor.eraserTip')}
        aria-disabled={readOnly || undefined}
        className="toolbar-action"
        data-tool="eraser"
        {...rv('eraser')}
        onClick={() => !readOnly && (tool === 'eraser' ? onEraserEdit() : onToolChange('eraser'))}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round">
            <path d="M15 3.5L20.5 9L10 19.5L4.5 14ZM8.7 9.8L14.2 15.3" />
            {eraserMode === 'partial' && <path d="M3 22H7M10 22H14M17 22H21" />}
          </g>
        </svg>
      </button>
      <button
        type="button"
        aria-pressed={tool === 'lasso'}
        aria-label={t('editor.lasso')}
        title={t('editor.lassoTip')}
        className="toolbar-action"
        data-tool="lasso"
        {...rv('lasso')}
        onClick={() => onToolChange(tool === 'lasso' ? 'pen' : 'lasso')}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M17 5h-2V3h2v2zm-2 16h2v-2.59L19.59 21 21 19.59 18.41 17H21v-2h-6v6zm4-12h2V7h-2v2zm0 4h2v-2h-2v2zm-8 8h2v-2h-2v2zM7 5h2V3H7v2zM3 17h2v-2H3v2zm2 4v-2H3c0 1.1.9 2 2 2zM19 3v2h2c0-1.1-.9-2-2-2zm-8 2h2V3h-2v2zM3 9h2V7H3v2zm4 12h2v-2H7v2zm-4-8h2v-2H3v2zm0-8h2V3c-1.1 0-2 .9-2 2z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-pressed={tool === 'text'}
        aria-label={t('editor.text')}
        title={readOnly ? t('editor.readOnlyTip') : t('editor.textTip')}
        aria-disabled={readOnly || undefined}
        className="toolbar-action"
        data-tool="text"
        {...rv('text')}
        onClick={() => !readOnly && onToolChange(tool === 'text' ? 'pen' : 'text')}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2.5 4v3h5v12h3V7h5V4h-13zm19 5h-9v3h3v7h3v-7h3V9z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={t('editor.image')}
        title={readOnly ? t('editor.readOnlyTip') : t('editor.imageTip')}
        aria-disabled={readOnly || !onImage || undefined}
        className="toolbar-action"
        data-tool="image"
        {...rv('image')}
        onClick={() => !readOnly && onImage?.()}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4.86 8.86l-3 3.87L9 13.14 6 17h12l-3.86-5.14z" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}
