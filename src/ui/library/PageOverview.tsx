import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { fmt, useI18n } from '../../i18n'
import type { Page } from '../../model/note'
import { dropIndex, stepIndex } from '../../model/pageMove'
import { pageOutOfBounds } from '../../model/pageBounds'
import type { El } from '../../model/select'
import { StrokePathCache, fitViewport, paintPage } from '../../render/pagePainter'

/** Story 6.3: the page overview panel. The side it opens on is one value (the left-handed setting is Epic 10). */
export type PanelSide = 'left' | 'right'
export const DEFAULT_PANEL_SIDE: PanelSide = 'right'
/** Below this window width the panel overlays the canvas instead of taking room from it. */
export const OVERLAY_BELOW_PX = 840
/** A drag this close to the top or bottom of the list scrolls it (SCROLL_PX per dragover). */
const EDGE_PX = 40
const SCROLL_PX = 14

/** A thumbnail is drawn only while it is (nearly) in view; without IntersectionObserver every one is. */
function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver !== 'function')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver((es) => setSeen(es.some((e) => e.isIntersecting)), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return seen
}

function Thumb({ page }: { page: Page }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const cache = new StrokePathCache()
    const draw = () => {
      try {
        const r = c.getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0)) return
        const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
        c.width = Math.max(1, Math.round(r.width * dpr))
        c.height = Math.max(1, Math.round(r.height * dpr))
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        paintPage(ctx, page, fitViewport(r.width, r.height, page.width, page.height), cache)
      } catch {
        // an empty thumbnail
      }
    }
    draw()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null
    ro?.observe(c)
    return () => ro?.disconnect()
  }, [page])
  return <canvas ref={ref} className="po-canvas" aria-hidden="true" />
}

type ItemProps = { page: Page; index: number; total: number; current: boolean; picked: boolean; drop: 'before' | 'after' | null; conflict: boolean; focusable: boolean; readOnly: boolean; onGo: (e: ReactMouseEvent) => void; onDragStart: (e: ReactDragEvent) => void; onDragEnd: () => void; onDuplicate: () => void; onDelete: () => void }

function Item({ page, index, total, current, picked, drop, conflict, focusable, readOnly, onGo, onDragStart, onDragEnd, onDuplicate, onDelete }: ItemProps) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const visible = useVisible(box)
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
  }, [open])
  // A press outside closes the menu.
  useEffect(() => {
    if (!open) return
    const on = (e: PointerEvent) => {
      const n = e.target as Node
      if (!menu.current?.contains(n) && !more.current?.contains(n)) setOpen(false)
    }
    document.addEventListener('pointerdown', on)
    return () => document.removeEventListener('pointerdown', on)
  }, [open])
  const pick = (f: () => void) => () => {
    setOpen(false)
    f()
  }
  const onMenuKey = (e: ReactKeyEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    setOpen(false)
    more.current?.focus()
  }
  const { width: w, height: h } = page
  const ratio = w > 0 && h > 0 ? Math.min(5, Math.max(0.2, w / h)) : 0.7
  const out = useMemo(() => pageOutOfBounds(w, h, page.elements as El[]).length, [w, h, page.elements])
  const badges = [...(conflict ? [t('page.conflictBadge')] : []), ...(out > 0 ? [fmt(t('page.outOfBoundsBadge'), { n: out })] : [])]
  const label = [
    fmt(t('editor.page'), { n: index + 1, total, orientation: t(w > h ? 'library.orientation.landscape' : 'library.orientation.portrait') }),
    ...(current ? [t('page.current')] : []),
    ...(picked ? [t('page.picked')] : []),
    ...badges,
  ].join(', ')
  return (
    <div role="none" className="po-item" data-drop={drop ?? undefined} draggable={!readOnly} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div
        role="option"
        data-index={index}
        aria-selected={current}
        aria-label={label}
        tabIndex={focusable ? 0 : -1}
        data-picked={picked ? '' : undefined}
        className={current ? 'po-option is-current' : 'po-option'}
        onClick={onGo}
      >
        <div ref={box} className="po-thumb" style={{ aspectRatio: String(ratio) }} aria-hidden="true">
          {visible && <Thumb page={page} />}
          {badges.length > 0 && (
            <span className="po-badges">
              {badges.map((b) => (
                <span key={b} className="po-badge">
                  <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11v.1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                  {b}
                </span>
              ))}
            </span>
          )}
        </div>
        <span className="po-number" aria-hidden="true">
          {current ? `${index + 1} · ${t('page.current')}` : index + 1}
        </span>
      </div>
      <button
        ref={more}
        type="button"
        className="po-more"
        aria-disabled={readOnly}
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={-1}
        aria-label={t('page.menu')}
        title={readOnly ? t('editor.readOnlyTip') : undefined}
        onClick={() => !readOnly && setOpen((o) => !o)}
      >
        <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="13" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={t('page.menu')} className="editor-menu po-menu" onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" className="editor-menu-item" onClick={pick(onDuplicate)}>
            {t('page.duplicate')}
          </button>
          <button type="button" role="menuitem" className="editor-menu-item" aria-disabled={total < 2} onClick={pick(() => total > 1 && onDelete())}>
            {t('page.delete')}
          </button>
        </div>
      )}
    </div>
  )
}

type Props = {
  id: string
  pages: readonly Page[]
  current: number
  conflicted: ReadonlySet<string>
  side: PanelSide
  overlay: boolean
  /** Another tab holds the note: pages can be viewed, not changed. */
  readOnly?: boolean
  onGo: (i: number) => void
  onClose: () => void
  onAdd?: () => void
  onDuplicate?: (pageIds: string[]) => void
  onDelete?: (pageIds: string[]) => void
  /** The pages (note order) go as one block to `index` of the pages that stay (movePages). */
  onMove?: (pageIds: string[], index: number) => void
}

export const PageOverview = forwardRef<HTMLElement, Props>(function PageOverview({ id, pages, current, conflicted, side, overlay, readOnly = false, onGo, onClose, onAdd, onDuplicate, onDelete, onMove }, ref) {
  const { t } = useI18n()
  const list = useRef<HTMLDivElement>(null)
  // The current page stays in view as the canvas scrolls.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [current])
  const move = (to: number) => {
    const el = list.current?.querySelector<HTMLElement>(`[data-index="${Math.min(pages.length - 1, Math.max(0, to))}"]`)
    el?.focus()
    el?.scrollIntoView?.({ block: 'nearest' })
  }
  // Several pages picked (Ctrl/Shift+click, Shift+arrows, Ctrl+Space): UI state only, never in the note.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef(0)
  const order = pages.map((p) => p.id)
  const live = useMemo(() => new Set(order.filter((x) => picked.has(x))), [picked, order.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const range = (a: number, b: number) => new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1))
  const toggle = (i: number) => {
    const n = new Set(live)
    const x = order[i]!
    if (!n.delete(x)) n.add(x)
    anchor.current = i
    setPicked(n)
  }
  const block = (id: string) => (live.has(id) ? order.filter((x) => live.has(x)) : [id])
  const clickItem = (i: number, e: ReactMouseEvent) => {
    if (e.ctrlKey || e.metaKey) return toggle(i)
    if (e.shiftKey) return setPicked(range(anchor.current, i))
    anchor.current = i
    setPicked(new Set())
    onGo(i)
  }
  const doDelete = (ids: string[]) => {
    if (readOnly || ids.length >= pages.length) return
    const first = order.findIndex((x) => ids.includes(x))
    refocus.current = Math.min(first, pages.length - ids.length - 1)
    setPicked(new Set())
    onDelete?.(ids)
  }
  // Alt+Up / Alt+Down: the focused page (or the picked block) one step; the focus follows it.
  const step = (at: number, dir: -1 | 1) => {
    if (readOnly) return
    const ids = block(order[at]!)
    const to = stepIndex(order, new Set(ids), dir)
    if (to === null) return
    const rest = order.filter((x) => !ids.includes(x))
    refocus.current = [...rest.slice(0, to), ...ids, ...rest.slice(to)].indexOf(order[at]!)
    onMove?.(ids, to)
  }
  // Dragging: the block is the picked pages when the dragged one is among them.
  const [drop, setDrop] = useState<number | null>(null)
  const drag = useRef<string[]>([])
  const onDragOver = (e: ReactDragEvent) => {
    if (!drag.current.length) return
    e.preventDefault()
    const box = list.current!
    const r = box.getBoundingClientRect()
    if (e.clientY < r.top + EDGE_PX) box.scrollTop -= SCROLL_PX
    else if (e.clientY > r.bottom - EDGE_PX) box.scrollTop += SCROLL_PX
    const items = [...box.querySelectorAll<HTMLElement>('.po-item')]
    const at = items.findIndex((el) => {
      const b = el.getBoundingClientRect()
      return e.clientY < b.top + b.height / 2
    })
    setDrop(at < 0 ? items.length : at)
  }
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault()
    const ids = drag.current
    if (ids.length && drop !== null && !readOnly) {
      refocus.current = null
      onMove?.(ids, dropIndex(order, new Set(ids), drop))
    }
    drag.current = []
    setDrop(null)
  }
  // After a delete the focus goes to the next thumbnail (the previous one when the last was deleted).
  const refocus = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (refocus.current === null) return
    const to = refocus.current
    refocus.current = null
    move(to)
  })
  const onKeyDown = (e: ReactKeyEvent) => {
    if (e.key === 'Escape') return live.size > 0 ? setPicked(new Set()) : onClose()
    const at = Number((e.target as HTMLElement).dataset.index)
    if (!Number.isFinite(at)) return
    if (e.key === 'Delete') {
      if (pages[at]) doDelete(block(pages[at]!.id))
      e.preventDefault()
      return
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) step(at, e.key === 'ArrowDown' ? 1 : -1)
    else if (e.ctrlKey && e.key === ' ') toggle(at)
    else if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const to = Math.min(pages.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
      if (live.size === 0) anchor.current = at
      setPicked(range(anchor.current, to))
      move(to)
    } else if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(pages.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') onGo(at)
    else return
    e.preventDefault()
  }
  return (
    <aside ref={ref} id={id} className="po-panel" data-side={side} data-overlay={overlay ? '' : undefined} aria-label={t('page.overview')}>
      <div className="po-header">
        {live.size > 0 ? (
          <>
            <h2 className="po-title">{fmt(t('page.selectedCount'), { n: live.size })}</h2>
            <button type="button" className="toolbar-action" aria-label={t('page.clearSelection')} onClick={() => setPicked(new Set())}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" fill="none" />
              </svg>
            </button>
          </>
        ) : (
          <>
            <h2 className="po-title">{t('page.overview')}</h2>
            <button type="button" className={readOnly ? 'toolbar-action toolbar-action-disabled' : 'toolbar-action'} aria-disabled={readOnly} aria-label={t('page.add')} title={readOnly ? t('editor.readOnlyTip') : undefined} onClick={() => !readOnly && onAdd?.()}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.75" fill="none" />
              </svg>
            </button>
            <button type="button" className="toolbar-action" aria-label={t('dialog.close')} onClick={onClose}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" fill="none" />
              </svg>
            </button>
          </>
        )}
      </div>
      {live.size > 0 && (
        <div className="po-actions" role="toolbar" aria-label={t('page.selectedActions')}>
          <button type="button" className="po-action" aria-disabled={readOnly} onClick={() => !readOnly && onDuplicate?.(order.filter((x) => live.has(x)))}>
            {t('page.duplicate')}
          </button>
          <button type="button" className="po-action" aria-disabled={readOnly || live.size >= pages.length} onClick={() => doDelete(order.filter((x) => live.has(x)))}>
            {t('page.delete')}
          </button>
          {/* The background menu arrives with Story 6.9. */}
          <button type="button" className="po-action" aria-disabled="true">
            {t('page.background')}
          </button>
        </div>
      )}
      <div ref={list} role="listbox" aria-label={t('page.overview')} aria-orientation="vertical" className="po-list" onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop}>
        {pages.map((p, i) => (
          <Item key={p.id} page={p} index={i} total={pages.length} current={i === current} picked={live.has(p.id)} drop={drop === i ? 'before' : drop === pages.length && i === pages.length - 1 ? 'after' : null} conflict={conflicted.has(p.id)} focusable={i === current} readOnly={readOnly} onGo={(e) => clickItem(i, e)} onDragStart={(e) => { drag.current = block(p.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.id) }} onDragEnd={() => { drag.current = []; setDrop(null) }} onDuplicate={() => onDuplicate?.([p.id])} onDelete={() => doDelete([p.id])} />
        ))}
      </div>
    </aside>
  )
})
