// The writing surface of one open note: pointer input -> addStroke ops on a
// History -> serial saves, and the canvas that shows the page (with its zoom
// and pan view). No React here.
import { newId } from '../../model/ids'
import { selectLasso, selectRect, selectTap, selectionBounds, type Bounds, type El } from '../../model/select'
import { ROTATE_GAP, paintSelection, selectionColors } from '../../render/selectionPainter'
import type { Op } from '../../ops/ops'
import type { Page, Stroke } from '../../model/note'
import type { Pen } from '../../model/pen'
import type { History } from '../../ops/history'
import type { Note } from '../../model/note'
import { type ResolveResult, resolveConflict } from '../../ops/resolveConflict'
import { commitMerge } from '../../sync/commitMerge'
import { sidecarKey } from '../../sync/conflicts'
import { type Conflict, type MergeCtx, type RequeueResult, type Sidecar, mergeRequeue } from '../../sync/merge'
import {
  clampScale,
  clampViewport,
  fitPageViewport,
  fitWidthViewport,
  paintPage,
  scrollMetrics,
  StrokePathCache,
  toPage,
  snapScale,
  zoomAbout,
  type PageViewport,
  type Thumb,
  type ViewInsets,
} from '../../render/pagePainter'
import type { NoteStore } from '../../storage/noteStore'
import { SaveQueue, markUnsaved, trackSave } from '../../storage/saveQueue'

export type WriterMessage = 'saveFailed' | 'strokeNotAdded' | 'historyNotApplied'

/** `ox`, `oy`: where the page of the stroke starts in the continuous scroll; `points` are in that page's coordinates. */
type Drawing = { id: number; strokeId: string; type: string; t0: number; points: number[][]; pageId: string; ox: number; oy: number }
const POINTER_TYPES = ['pen', 'mouse', 'touch']
/** A second finger this soon after the first turns the stroke into a gesture. */
const SECOND_FINGER_MS = 150
const ANIMATION_MS = 150
const WHEEL_ZOOM = 0.002
export const ZOOM_STEP = 1.25
export const ARROW_STEP = 40
/** Space between two pages of the continuous scroll, in page points. */
export const PAGE_GAP = 16

export type FitMode = 'width' | 'page' | 'free'
// Who owns the pointers: nobody, a touch stroke, a touch outside the page, a
// two-finger gesture, fingers to ignore until all lift, a pen/mouse, a pan drag.
type Mode = 'none' | 'stroke' | 'idle' | 'gesture' | 'ignored' | 'pen' | 'pan' | 'lasso' | 'xform'
export type Tool = 'pen' | 'lasso'
/** A lasso drag or click: `path` is in document coordinates, `x`/`y` the client start (to tell a click from a drag). */
type Lasso = { id: number; shift: boolean; alt: boolean; x: number; y: number; moved: boolean; path: [number, number][] }
/** A drag shorter than this (CSS px) is a click. */
const CLICK_SLOP = 4
/** Smallest radius (CSS px) that hits a handle; a box smaller than this on both sides is grabbed inside first. */
const HANDLE_HIT = 24
const SMALL_BOX = 48
const MIN_SCALE = 0.05
/** Arrow-key nudges this close together are one undo step. */
const NUDGE_MS = 500
/** A selection drag: `start`/`cur` and `b` (the selection bounds) are in the coordinates of the selection's page. `corner`: 0 tl, 1 tr, 2 bl, 3 br. */
type Xform = { id: number; kind: 'move' | 'scale' | 'rotate'; corner: number; slot: Slot; ids: string[]; b: Bounds; start: [number, number]; cur: [number, number]; shift: boolean; down: { x: number; y: number; doc: [number, number]; shift: boolean; alt: boolean } }
/** The selection box in canvas CSS px, and the canvas size, for the floating menu. */
export type SelectionBox = { left: number; top: number; right: number; bottom: number; w: number; h: number }

/** What a screen point (CSS px) grabs of the selection box `l,t,r,b`: its inside (move), the rotate handle or a corner (0 tl, 1 tr, 2 bl, 3 br). */
export function hitSelection(l: number, t: number, r: number, b: number, x: number, y: number): 'move' | 'rotate' | number | null {
  const inside = (pad: number) => x >= l - pad && x <= r + pad && y >= t - pad && y <= b + pad
  if (r - l < SMALL_BOX && b - t < SMALL_BOX && inside(6)) return 'move' // handles would cover it
  if (Math.hypot(x - (l + r) / 2, y - (t - ROTATE_GAP)) <= HANDLE_HIT) return 'rotate'
  let best = -1
  let bd = HANDLE_HIT
  for (const [i, [cx, cy]] of ([[l, t], [r, t], [l, b], [r, b]] as const).entries()) {
    const d = Math.hypot(x - cx, y - cy)
    if (d <= bd) {
      best = i
      bd = d
    }
  }
  if (best >= 0) return best
  return inside(0) ? 'move' : null
}
/** `page`: index of the current page (the one in view, or the one a page key moved to); `pages`: how many there are. */
export type ViewInfo = { scale: number; x: Thumb | null; y: Thumb | null; page: number; pages: number }
/** A page and where it starts in the document: all pages stacked vertically, centered, `PAGE_GAP` apart. */
type Slot = { page: Page; x: number; y: number }
export type ResolveApplied = Extract<ResolveResult, { result: 'resolved' }> & { used: string }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export class Writer {
  private caches = new Map<string, StrokePathCache>() // one per page; a page off screen is not painted
  private queue: SaveQueue
  private canvas: HTMLCanvasElement | null = null
  private drawing: Drawing | null = null
  private mode: Mode = 'none'
  private touches = new Map<number, { x: number; y: number }>() // client positions
  private firstId = -1
  private firstDown = 0
  private penId = -1
  private pan: { id: number; x: number; y: number } | null = null
  private gesture: { a: number; b: number; s0: number; d0: number; p0: [number, number] } | null = null
  private hand = false
  private handUsed = false
  private viewport: PageViewport = { scale: 1, offsetX: 0, offsetY: 0 }
  private fitMode: FitMode = 'width'
  private wheelAsk: { shown: number; value: number } | null = null
  private laidOut = false
  private layoutKey = ''
  private ins: ViewInsets = { gap: 0, extraBottom: 0 }
  private anim: { from: PageViewport; to: PageViewport; t0: number; raf: number } | null = null
  private cssW = 0
  private cssH = 0
  private dpr = 1
  private finalizing: Promise<void> | null = null
  private tool: Tool = 'pen'
  private lasso: Lasso | null = null
  private xform: Xform | null = null
  private nudgeRun: { key: string; depth: number; timer: ReturnType<typeof setTimeout> } | null = null
  private lastBox = ''
  /** Keep the aspect ratio when resizing (Shift flips it for one drag). UI state, not saved. */
  ratioLock = true
  /** Selection is UI state (never in the note): the page and the ids of its selected elements. */
  private selection: { pageId: string; ids: Set<string> } | null = null
  /** Padding and the room under the page's end; the editor knows the toolbar. */
  insets: () => ViewInsets = () => ({ gap: 0, extraBottom: 0 })
  /** Another tab holds the note: view, zoom and pan only (spec 2.13). */
  readOnly = false
  /** Called with the number of selected elements whenever the selection changed. */
  onSelection: (n: number) => void = () => {}
  /** Called when the box the floating menu hangs on changed (null: no editable selection). */
  onBox: (b: SelectionBox | null) => void = () => {}
  /** Called whenever the view (scale, scrollbars) changed. */
  onView: (v: ViewInfo) => void = () => {}
  /** Someone tried to write or undo on a page with an unresolved conflict (Story 3.20). */
  onBlocked: () => void = () => {}
  /**
   * A page whose conflict was detected while a stroke was being drawn on it: the version on screen stays
   * the one the person was writing on (never saved); the stored note has the Drive version. Dropped with the editor.
   */
  private held: Page | null = null
  private strokeWaiters: ((pageId: string | null) => void)[] = []
  /** The page a page key moved to; it stays current until the person scrolls. */
  private forced: string | null = null // a page id

  constructor(
    readonly history: History,
    readonly store: NoteStore,
    private pen: () => Pen,
    private message: (m: WriterMessage) => void,
    private editedBy: () => string,
    private onChange: () => void = () => {},
  ) {
    this.queue = new SaveQueue(store, () => message('saveFailed'))
  }

  get leaving() {
    return this.finalizing !== null
  }

  /** Every page in the continuous scroll (the held version stands in for its page), with its place. */
  private slots(): { list: Slot[]; w: number; h: number } {
    const list: Slot[] = []
    const pages = this.history.note.pages
    let w = 0
    let h = 0
    for (const [i, p0] of pages.entries()) {
      const p = this.held && this.held.id === p0.id ? this.held : p0
      list.push({ page: p, x: 0, y: h + i * PAGE_GAP })
      w = i === 0 ? p.width : Math.max(w, p.width)
      h += p.height
    }
    const total = h + Math.max(0, pages.length - 1) * PAGE_GAP
    for (const s of list) s.x = (w - s.page.width) / 2
    return { list, w, h: total }
  }

  /** Index in `list` of the current page: the one a page key moved to, else the one at the middle of the view. */
  private currentIndex(list: Slot[]): number {
    if (list.length < 2) return 0
    if (this.forced !== null) {
      const f = list.findIndex((s) => s.page.id === this.forced)
      if (f >= 0) return f
    }
    const mid = toPage(this.viewport, 0, this.cssH / 2)[1]
    const i = list.findIndex((s) => mid < s.y + s.page.height + PAGE_GAP / 2)
    return i < 0 ? list.length - 1 : i
  }

  private get current(): Slot | undefined {
    const { list } = this.slots()
    return list[this.currentIndex(list)]
  }

  private get page(): Page | undefined {
    return this.current?.page
  }

  /** The page under a document point, or undefined between pages and outside them. */
  private hit(dx: number, dy: number): Slot | undefined {
    return this.slots().list.find((s) => dx >= s.x && dy >= s.y && dx <= s.x + s.page.width && dy <= s.y + s.page.height)
  }

  private cacheOf(pageId: string): StrokePathCache {
    let c = this.caches.get(pageId)
    if (!c) this.caches.set(pageId, (c = new StrokePathCache()))
    return c
  }

  /** The page on screen has an unresolved conflict: no stroke, no undo (Story 3.20). */
  get pageLocked(): boolean {
    const p = this.page
    return !!p && this.history.isLocked(p.id)
  }

  /** Resolves when no stroke is in progress. The value is the page of a stroke that was added meanwhile, else null. */
  strokeEnd(): Promise<string | null> {
    if (!this.drawing) return Promise.resolve(null)
    return new Promise((resolve) => this.strokeWaiters.push(resolve))
  }

  private releaseStrokeWaiters(pageId: string | null): void {
    const w = this.strokeWaiters
    this.strokeWaiters = []
    w.forEach((f) => f(pageId))
  }

  /** Wires `canvas` for input and drawing; the returned function unwires it. */
  attach(canvas: HTMLCanvasElement): () => void {
    this.canvas = canvas
    const on = (type: string, f: (e: PointerEvent) => void) => {
      canvas.addEventListener(type, f as EventListener)
      return () => canvas.removeEventListener(type, f as EventListener)
    }
    const offs = [
      on('pointerdown', (e) => this.onDown(e)),
      on('pointermove', (e) => this.onMove(e)),
      on('pointerup', (e) => this.onUp(e)),
      on('pointercancel', (e) => this.onCancel(e)),
      on('lostpointercapture', (e) => this.onCancel(e)),
      on('contextmenu', (e) => e.preventDefault()),
      // The middle button must not autoscroll or paste (Linux).
      on('mousedown', (e) => e.button === 1 && e.preventDefault()),
      on('auxclick', (e) => e.button === 1 && e.preventDefault()),
    ]
    const onWheel = (e: WheelEvent) => this.onWheel(e)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    const relayout = () => this.layout()
    // A window that lost focus may never deliver the release.
    const onBlur = () => {
      if (this.drawing) this.finishStroke()
      this.touches.clear()
      this.pan = null
      this.gesture = null
      this.lasso = null
      this.xform = null
      this.mode = 'none'
      canvas.classList.remove('is-panning')
      this.setHand(false)
      this.snap()
    }
    globalThis.addEventListener?.('blur', onBlur)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(relayout) : null
    ro?.observe(canvas)
    globalThis.addEventListener?.('resize', relayout)
    this.layout()
    return () => {
      offs.forEach((off) => off())
      canvas.removeEventListener('wheel', onWheel)
      this.stopAnim()
      ro?.disconnect()
      globalThis.removeEventListener?.('resize', relayout)
      globalThis.removeEventListener?.('blur', onBlur)
      if (this.canvas === canvas) this.canvas = null
    }
  }

  /**
   * Sizes the backing store and, when the canvas size changed, the view: a
   * fit mode is fitted again, a free view keeps the page point at the center.
   * Calling it again with nothing changed leaves the view alone.
   */
  layout(): void {
    const c = this.canvas
    if (!c || !this.page) return
    const r = c.getBoundingClientRect()
    const oldW = this.cssW
    const oldH = this.cssH
    this.dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
    const w = Math.max(1, Math.round(r.width * this.dpr))
    const h = Math.max(1, Math.round(r.height * this.dpr))
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
    const ins = this.insets()
    const key = [r.width, r.height, ins.gap, ins.extraBottom].join()
    // A canvas that measures nothing (hidden) keeps the last good size and view.
    if (r.width > 0 && r.height > 0) {
      this.cssW = r.width
      this.cssH = r.height
      this.ins = ins
      if (key !== this.layoutKey) {
        this.layoutKey = key
        if (this.anim) {
          // Continue from where the animation was headed.
          this.viewport = this.anim.to
          this.stopAnim()
        }
        if (!this.laidOut || this.fitMode !== 'free') {
          this.viewport = this.fitFor(this.fitMode === 'page' ? 'page' : 'width')
        } else {
          const [px, py] = toPage(this.viewport, oldW / 2, oldH / 2)
          const s = this.viewport.scale
          this.viewport = this.clamp({ scale: s, offsetX: r.width / 2 - px * s, offsetY: r.height / 2 - py * s })
        }
        this.laidOut = true
        this.onView(this.info())
      }
    }
    this.redraw()
  }

  private fitFor(mode: 'width' | 'page'): PageViewport {
    const d = this.slots()
    if (mode === 'width') return fitWidthViewport(this.cssW, this.cssH, d.w, d.h, this.ins)
    // A whole page, the current one; with one page that is the whole document.
    const cur = this.current!
    const v = fitPageViewport(this.cssW, this.cssH, cur.page.width, cur.page.height, this.ins)
    return this.clamp({ scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY - cur.y * v.scale })
  }

  private clamp(v: PageViewport): PageViewport {
    const d = this.slots()
    return clampViewport(v, this.cssW, this.cssH, d.w, d.h, this.ins)
  }

  /** The scale to show (the target while animating), the scrollbars of what is on screen and the current page. */
  info(): ViewInfo {
    const d = this.slots()
    const v = this.anim?.to ?? this.viewport
    const m = d.list.length > 0 ? scrollMetrics(v, this.cssW, this.cssH, d.w, d.h, this.ins) : { x: null, y: null }
    return { scale: v.scale, ...m, page: this.currentIndex(d.list), pages: d.list.length }
  }

  /** The size of the document changed (a page came or went): the view is fitted or clamped again. */
  private docChanged(before: string): void {
    if (this.docKey() === before || !this.canvas || !this.page) return this.redraw()
    this.snap()
    this.viewport = this.fitMode === 'free' ? this.clamp(this.viewport) : this.fitFor(this.fitMode)
    this.redraw()
    this.onView(this.info())
  }

  private docKey(): string {
    const d = this.slots()
    return `${d.list.length}:${d.w}x${d.h}`
  }

  /** Moves so that page `i` (0-based) starts the view. */
  goToPage(i: number): void {
    const { list } = this.slots()
    if (list.length === 0 || this.busy()) return
    const k = Math.min(list.length - 1, Math.max(0, i))
    const v = this.anim?.to ?? this.viewport
    this.forced = list[k]!.page.id
    this.goTo(this.clamp({ scale: v.scale, offsetX: v.offsetX, offsetY: this.ins.gap - list[k]!.y * v.scale }), 'free')
  }

  /** PgUp / PgDn: the page before / after the current one. */
  pageStep(d: -1 | 1): void {
    const { list } = this.slots()
    if (list.length > 0) this.goToPage(this.currentIndex(list) + d)
  }

  private setView(v: PageViewport, fit: FitMode): void {
    this.viewport = v
    this.fitMode = fit
    this.redraw()
    this.onView(this.info())
  }

  private stopAnim(): void {
    if (this.anim) globalThis.cancelAnimationFrame?.(this.anim.raf)
    this.anim = null
  }

  /** Ends a running zoom animation at its target. */
  private snap(): void {
    const a = this.anim
    if (!a) return
    this.stopAnim()
    this.setView(a.to, this.fitMode)
  }

  /** A stroke is being drawn or the note is not on disk yet: closing the tab now would lose it. */
  unsaved(): boolean {
    return this.drawing !== null || this.queue.pending
  }

  /** A stroke, a gesture or a pan is going on. */
  busy(): boolean {
    return this.drawing !== null || this.mode === 'gesture' || this.mode === 'pan' || this.mode === 'lasso' || this.mode === 'xform'
  }

  /** Moves to `to`; at once when the system asks for no motion. Not under a stroke or a drag. */
  private goTo(to: PageViewport, fit: FitMode): void {
    if (this.busy()) return
    const from = this.viewport
    this.stopAnim()
    const still =
      typeof globalThis.matchMedia !== 'function' ||
      typeof globalThis.requestAnimationFrame !== 'function' ||
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (still) return this.setView(to, fit)
    this.fitMode = fit
    const step = (now: number) => {
      const a = this.anim
      if (!a) return
      const t = Math.max(0, Math.min(1, (now - a.t0) / ANIMATION_MS))
      if (t >= 1) return this.snap()
      const k = 1 - (1 - t) * (1 - t) // ease out
      const lerp = (x: number, y: number) => x + (y - x) * k
      this.viewport = {
        scale: lerp(a.from.scale, a.to.scale),
        offsetX: lerp(a.from.offsetX, a.to.offsetX),
        offsetY: lerp(a.from.offsetY, a.to.offsetY),
      }
      this.redraw()
      this.onView(this.info())
      a.raf = globalThis.requestAnimationFrame(step)
    }
    this.anim = { from, to, t0: globalThis.performance?.now() ?? 0, raf: 0 }
    this.anim.raf = globalThis.requestAnimationFrame(step)
    this.onView(this.info())
  }

  /** Scale x `factor` about the center of the canvas; steps build on a running animation's target. */
  zoomBy(factor: number): void {
    if (!this.page || this.busy()) return
    const base = this.anim?.to ?? this.viewport
    const z = zoomAbout(base, this.cssW / 2, this.cssH / 2, snapScale(base.scale * factor, this.fitFor('width').scale))
    this.goTo(this.clamp(z), 'free')
  }

  /** Width or whole-page fit; the mode stays until the view is changed by hand. */
  fit(mode: 'width' | 'page'): void {
    if (!this.page || this.busy()) return
    this.goTo(this.fitFor(mode), mode)
  }

  /** Scrolls the view by (dx, dy) CSS px: positive moves right / down over the page. Not under a stroke or drag. */
  panBy(dx: number, dy: number): void {
    if (this.busy()) return
    this.movePan(dx, dy)
  }

  private movePan(dx: number, dy: number): void {
    if (!this.page) return
    this.forced = null // scrolling by hand: the page in view is the current one again
    this.snap()
    const v = this.viewport
    this.changeView(this.clamp({ ...v, offsetX: v.offsetX - dx, offsetY: v.offsetY - dy }))
  }

  /** Sets a free view; a result equal to the current view does not leave a fit mode. */
  private changeView(n: PageViewport): void {
    const v = this.viewport
    if (n.scale === v.scale && n.offsetX === v.offsetX && n.offsetY === v.offsetY) return
    this.setView(n, 'free')
  }

  /** The hand tool (Space held). True when the release must not also click a focused button. */
  setHand(on: boolean): boolean {
    if (on === this.hand) return false
    this.hand = on
    const used = this.handUsed
    if (on) this.handUsed = false
    this.canvas?.classList.toggle('is-hand', on)
    return !on && used
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault() // never the browser's own zoom or scroll
    if (this.leaving || !this.page) return
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cssH : 1
    let dx = e.deltaX * unit
    let dy = e.deltaY * unit
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    this.snap()
    if (e.ctrlKey) {
      if (this.busy()) return
      const [fx, fy] = this.local(e.clientX, e.clientY)
      // The wheel keeps counting from the scale it asked for, so it leaves the snap (spec zoom.snap).
      const cur = this.viewport.scale
      const asked = clampScale((this.wheelAsk?.shown === cur ? this.wheelAsk.value : cur) * Math.exp(-dy * WHEEL_ZOOM))
      const shown = snapScale(asked, this.fitFor('width').scale)
      this.wheelAsk = { shown, value: asked }
      const z = zoomAbout(this.viewport, fx, fy, shown)
      this.setView(this.clamp(z), 'free')
      return
    }
    if (e.shiftKey) {
      dx = dx || dy
      dy = 0
    }
    this.panBy(dx, dy)
  }

  redraw(): void {
    const c = this.canvas
    if (!c || !this.page) return
    this.emitBox()
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = c.getContext('2d')
    } catch {
      // no canvas support: nothing to draw on
    }
    if (!ctx) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.cssW, this.cssH)
    // ponytail: the stroke in progress is rebuilt from all its points on every
    // event (O(n)), and wheel/pinch repaint per event; make both incremental /
    // rAF-coalesced if 2.15 measures them slow.
    const vp = this.viewport
    for (const id of [...this.caches.keys()]) if (!this.history.note.pages.some((p) => p.id === id)) this.caches.delete(id)
    const live = this.drawing ? this.build(this.drawing.points, this.drawing.strokeId) : null
    for (const s of this.slots().list) {
      // A page that is off screen is not painted.
      const top = vp.offsetY + s.y * vp.scale
      const left = vp.offsetX + s.x * vp.scale
      if (top > this.cssH || top + s.page.height * vp.scale < 0 || left > this.cssW || left + s.page.width * vp.scale < 0) continue
      const at = { scale: vp.scale, offsetX: left, offsetY: top }
      paintPage(ctx, s.page, at, this.cacheOf(s.page.id), this.drawing?.pageId === s.page.id ? live : null)
    }
    // Over the page clip: the box and its handles may stand outside the page.
    const sel = this.selected()
    const b = sel ? selectionBounds(sel.els) : null
    const path = this.lasso?.moved ? this.lasso.path : null
    if (b || path) {
      // A drag shows the box as it would end up (the elements change on release).
      const pv = this.xform && b ? this.preview(this.xform) : { b, angle: 0 }
      const pb = pv.b
      const box = pb && sel && { left: pb.left + sel.slot.x, top: pb.top + sel.slot.y, right: pb.right + sel.slot.x, bottom: pb.bottom + sel.slot.y }
      paintSelection(ctx, vp, box, path, selectionColors(c), pv.angle)
    }
  }

  /** The selected elements that still exist (undo or a merge may have removed some), with their page's place. */
  private selected(): { slot: Slot; els: El[] } | null {
    const sel = this.selection
    const slot = sel && this.slots().list.find((s) => s.page.id === sel.pageId)
    if (!sel) return null
    const els = slot ? (slot.page.elements as El[]).filter((e) => sel.ids.has(e?.id as string)) : []
    // Ids that undo or a merge removed are dropped for good, so a redo does not bring the box back.
    if (els.length !== sel.ids.size) {
      this.selection = els.length > 0 ? { pageId: sel.pageId, ids: new Set(els.map((e) => e.id as string)) } : null
      this.onSelection(els.length)
    }
    return slot && els.length > 0 ? { slot, els } : null
  }

  get selectedCount(): number {
    return this.selected()?.els.length ?? 0
  }

  private setSelection(pageId: string, ids: Iterable<string>): void {
    const set = new Set(ids)
    this.selection = set.size > 0 ? { pageId, ids: set } : null
    this.redraw()
    this.onSelection(set.size)
  }

  clearSelection(): void {
    if (this.selection) this.setSelection('', [])
  }

  /** The tool for pointer input; the pen tool has no selection. */
  setTool(t: Tool): void {
    if (t === this.tool) return
    this.tool = t
    if (t === 'pen') this.clearSelection()
  }

  /** Ctrl+A: every element of the current page. */
  selectAll(): void {
    const s = this.current
    if (s) this.setSelection(s.page.id, (s.page.elements as El[]).map((e) => e?.id as string).filter((id) => typeof id === 'string'))
  }

  private clearNudge(): void {
    if (this.nudgeRun) clearTimeout(this.nudgeRun.timer)
    this.nudgeRun = null
  }

  /** Editing the page is allowed: not read-only, not closing, no unresolved conflict. */
  private canEdit(pageId: string): boolean {
    return !this.readOnly && !this.leaving && !this.history.isLocked(pageId)
  }

  private emitBox(): void {
    const sel = this.selected()
    const b = sel && this.canEdit(sel.slot.page.id) ? selectionBounds(sel.els) : null
    const v = this.viewport
    const box = b && sel && {
      left: v.offsetX + (b.left + sel.slot.x) * v.scale,
      top: v.offsetY + (b.top + sel.slot.y) * v.scale,
      right: v.offsetX + (b.right + sel.slot.x) * v.scale,
      bottom: v.offsetY + (b.bottom + sel.slot.y) * v.scale,
      w: this.cssW,
      h: this.cssH,
    }
    const key = JSON.stringify(box)
    if (key === this.lastBox) return
    this.lastBox = key
    this.onBox(box)
  }

  /** A press on the selection box or a handle starts a move, resize or rotation. False: the press is for the lasso. */
  private xformDown(e: PointerEvent): boolean {
    const sel = this.selected()
    if (!sel || !this.canEdit(sel.slot.page.id)) return false
    const b = selectionBounds(sel.els)
    if (!b) return false
    const v = this.viewport
    const [lx, ly] = this.local(e.clientX, e.clientY)
    const sx = (x: number) => v.offsetX + (x + sel.slot.x) * v.scale
    const sy = (y: number) => v.offsetY + (y + sel.slot.y) * v.scale
    const hit = hitSelection(sx(b.left), sy(b.top), sx(b.right), sy(b.bottom), lx, ly)
    if (hit === null) return false
    const [dx, dy] = toPage(v, lx, ly)
    const at: [number, number] = [dx - sel.slot.x, dy - sel.slot.y]
    // Shift or Alt on the inside is the lasso's toggle / rectangle. On a handle it starts the drag; a click without a drag is the lasso's (see onUp).
    if ((e.shiftKey || e.altKey) && hit === 'move') return false
    // A press inside the box on an element that is not selected picks that element (lasso/tap path), it does not move.
    if (hit === 'move') {
      const id = selectTap(sel.slot.page.elements as El[], at)
      if (id !== null && !sel.els.some((x) => x.id === id)) return false
    }
    this.mode = 'xform'
    this.xform = {
      id: e.pointerId,
      kind: hit === 'move' || hit === 'rotate' ? hit : 'scale',
      corner: typeof hit === 'number' ? hit : -1,
      slot: sel.slot,
      ids: sel.els.map((x) => x.id as string),
      b,
      start: at,
      cur: at,
      shift: e.shiftKey,
      down: { x: e.clientX, y: e.clientY, doc: [dx, dy], shift: e.shiftKey, alt: e.altKey },
    }
    e.preventDefault()
    try {
      this.canvas?.focus({ preventScroll: true })
    } catch {
      // focus is a convenience
    }
    return true
  }

  /** The op the drag would make, or null when it changes nothing. */
  private xformOp(x: Xform): Op | null {
    const base = { pageId: x.slot.page.id, ids: x.ids }
    const { b } = x
    const dx = x.cur[0] - x.start[0]
    const dy = x.cur[1] - x.start[1]
    if (x.kind === 'move') return dx || dy ? { op: 'move', ...base, dx, dy } : null
    if (x.kind === 'rotate') {
      const cx = (b.left + b.right) / 2
      const cy = (b.top + b.bottom) / 2
      const turn = Math.atan2(x.cur[1] - cy, x.cur[0] - cx) - Math.atan2(x.start[1] - cy, x.start[0] - cx)
      const angle = ((((turn * 180) / Math.PI + 180) % 360) + 360) % 360 - 180
      return Number.isFinite(angle) && Math.abs(angle) > 1e-9 ? { op: 'rotate', ...base, angle } : null
    }
    // The anchor is the opposite corner; (vx, vy) runs from it to the grabbed corner.
    const right = x.corner % 2 === 1
    const bottom = x.corner >= 2
    const anchor: [number, number] = [right ? b.left : b.right, bottom ? b.top : b.bottom]
    const vx = (right ? b.right : b.left) - anchor[0]
    const vy = (bottom ? b.bottom : b.top) - anchor[1]
    const nx = vx + dx
    const ny = vy + dy
    let sx = vx ? nx / vx : 1
    let sy = vy ? ny / vy : 1
    if (this.ratioLock !== x.shift) {
      const d = vx * vx + vy * vy
      if (d === 0) return null
      sx = sy = (nx * vx + ny * vy) / d
    }
    sx = Math.max(MIN_SCALE, sx)
    sy = Math.max(MIN_SCALE, sy)
    return Number.isFinite(sx) && Number.isFinite(sy) && (sx !== 1 || sy !== 1) ? { op: 'scale', ...base, sx, sy, anchor } : null
  }

  /** The selection box as the drag stands: bounds in page coordinates and a turn in degrees. */
  private preview(x: Xform): { b: Bounds; angle: number } {
    const op = this.xformOp(x)
    const { b } = x
    if (!op) return { b, angle: 0 }
    if (op.op === 'move') {
      const dx = op.dx as number
      const dy = op.dy as number
      return { b: { left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy }, angle: 0 }
    }
    if (op.op === 'rotate') return { b, angle: op.angle as number }
    const [ax, ay] = op.anchor as [number, number]
    const sx = op.sx as number
    const sy = op.sy as number
    return { b: { left: ax + (b.left - ax) * sx, right: ax + (b.right - ax) * sx, top: ay + (b.top - ay) * sy, bottom: ay + (b.bottom - ay) * sy }, angle: 0 }
  }

  /** Applies one edit: it is one undo step and joins the save queue. Returns the error code or null. */
  private applyEdit(op: Op): string | null {
    this.clearNudge() // nudge() reads its run before calling this and sets a new one after
    const err = this.history.doOp(op, this.ctx())
    if (err === 'pageReadOnly') this.onBlocked()
    else if (err === 'elementNotFound') this.clearSelection() // the selection is stale
    else if (err) this.message('historyNotApplied')
    this.redraw()
    if (!err) {
      this.queue.commit(this.history.note)
      this.onChange()
    }
    return err
  }

  private finishXform(): void {
    const x = this.xform
    this.xform = null
    const op = x && this.xformOp(x)
    if (op) this.applyEdit(op)
    else this.redraw()
  }

  /** The selection when it can be edited now (not mid-drag), with its bounds in page coordinates. */
  private editable() {
    const sel = this.selected()
    const b = sel && selectionBounds(sel.els)
    return sel && b && !this.busy() && this.canEdit(sel.slot.page.id) ? { sel, b } : null
  }

  /** [크게]/[작게]: scales the selection by `factor` on both axes about the center of its box. */
  scaleSelection(factor: number): boolean {
    const e = this.editable()
    if (!e) return false
    const anchor = [(e.b.left + e.b.right) / 2, (e.b.top + e.b.bottom) / 2]
    return !this.applyEdit({ op: 'scale', pageId: e.sel.slot.page.id, ids: e.sel.els.map((x) => x.id), sx: factor, sy: factor, anchor })
  }

  /** [90° 회전] and the like: clockwise degrees about the center of the selection. */
  rotateSelection(angle: number): boolean {
    const e = this.editable()
    return !!e && !this.applyEdit({ op: 'rotate', pageId: e.sel.slot.page.id, ids: e.sel.els.map((x) => x.id), angle })
  }

  /** Arrow keys: moves the selection by (dx, dy) page pt; a run within 500 ms is one undo step. False: nothing to move, the key is free. */
  nudge(dx: number, dy: number): boolean {
    const e = this.editable()
    if (!e) return false
    const ids = e.sel.els.map((x) => x.id as string)
    const key = `${e.sel.slot.page.id}:${ids.join()}`
    const run = this.nudgeRun
    const depth = this.history.undoDepth
    if (this.applyEdit({ op: 'move', pageId: e.sel.slot.page.id, ids, dx, dy })) return true
    // Nothing else was recorded since the last nudge: this record folds into it.
    if (run && run.key === key && run.depth === depth && this.history.undoDepth === depth + 1) this.history.foldLastUndo()
    if (run) clearTimeout(run.timer)
    const timer = setTimeout(() => (this.nudgeRun = null), NUDGE_MS)
    this.nudgeRun = { key, depth: this.history.undoDepth, timer }
    return true
  }

  private lassoDown(e: PointerEvent): void {
    if (this.xformDown(e)) return
    const d = toPage(this.viewport, ...this.local(e.clientX, e.clientY))
    this.mode = 'lasso'
    this.lasso = { id: e.pointerId, shift: e.shiftKey, alt: e.altKey, x: e.clientX, y: e.clientY, moved: false, path: [d] }
    e.preventDefault()
    try {
      this.canvas?.focus({ preventScroll: true })
    } catch {
      // focus is a convenience
    }
  }

  /** The lasso ended: a click picks one element, a drag selects by the lasso (Alt: its rectangle). */
  private lassoUp(): void {
    const l = this.lasso
    this.lasso = null
    if (!l) return
    const at = l.path[0]!
    // The page the gesture started on, else the current one; judged in that page's coordinates.
    const slot = this.hit(at[0], at[1]) ?? this.current
    if (!slot) return this.redraw()
    const els = slot.page.elements as El[]
    const loc = ([x, y]: [number, number]): [number, number] => [x - slot.x, y - slot.y]
    if (!l.moved) {
      const id = selectTap(els, loc(at))
      if (l.shift) {
        if (!id) return this.redraw()
        const ids = new Set(this.selection?.pageId === slot.page.id ? this.selection.ids : [])
        if (!ids.delete(id)) ids.add(id)
        return this.setSelection(slot.page.id, ids)
      }
      return this.setSelection(slot.page.id, id ? [id] : [])
    }
    const end = l.path[l.path.length - 1]!
    const ids = l.alt ? selectRect(els, [...loc(at), ...loc(end)]) : selectLasso(els, l.path.map(loc))
    this.setSelection(slot.page.id, ids)
  }

  private build(points: number[][], id: string): Stroke {
    const pen = this.pen()
    return { id, type: 'stroke', tool: 'pen', color: pen.color, width: pen.width, usePressure: pen.usePressure, points }
  }

  private local(x: number, y: number): [number, number] {
    const r = this.canvas!.getBoundingClientRect()
    return [x - r.left, y - r.top]
  }

  /** `[x, y, pressure, t]` of an event in the coordinates of the page that starts at `o`, or null when its position is not a number. */
  private point(e: PointerEvent, t0: number, pressure?: number, o: { x: number; y: number } = { x: 0, y: 0 }): number[] | null {
    if (!this.canvas) return null
    const [dx, dy] = toPage(this.viewport, ...this.local(e.clientX, e.clientY))
    const x = dx - o.x
    const y = dy - o.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    let q = pressure
    if (q === undefined) {
      q = e.pointerType === 'pen' ? (Number.isFinite(e.pressure) ? clamp01(e.pressure) : 0.5) : 0.5
    }
    const dt = e.timeStamp - t0
    return [x, y, q, Number.isFinite(dt) ? Math.max(0, dt) : 0]
  }

  /** The page under the pointer of `e`, if any. */
  private under(e: PointerEvent): Slot | undefined {
    const p = this.point(e, e.timeStamp)
    return p ? this.hit(p[0]!, p[1]!) : undefined
  }

  private capture(e: PointerEvent): void {
    try {
      // Moves and the release arrive even outside the canvas or the window.
      this.canvas?.setPointerCapture(e.pointerId)
    } catch {
      // not capturable (synthetic event): still handled while over the canvas
    }
  }

  /** Starts a stroke at `e` when it is on the page. */
  private begin(e: PointerEvent): void {
    if (this.readOnly || this.tool === 'lasso') return
    const s = this.under(e)
    if (!s) return
    if (this.history.isLocked(s.page.id)) return this.onBlocked() // a page waiting for its conflict to be settled
    const p = this.point(e, e.timeStamp, undefined, s)!
    e.preventDefault()
    try {
      this.canvas?.focus({ preventScroll: true })
    } catch {
      // focus is a convenience
    }
    this.drawing = { id: e.pointerId, strokeId: newId(), type: e.pointerType, t0: e.timeStamp, points: [p], pageId: s.page.id, ox: s.x, oy: s.y }
    this.redraw()
  }

  /** Drops the stroke in progress: no op, no save. */
  private discardStroke(): void {
    if (!this.drawing) return
    this.drawing = null
    this.redraw()
    this.releaseStrokeWaiters(null)
  }

  private onDown(e: PointerEvent): void {
    if (this.leaving || !this.page) return
    if (!POINTER_TYPES.includes(e.pointerType)) return
    this.snap() // a running zoom ends at its target before new input
    this.layout() // the canvas may have moved or resized; the view stays unless its size changed
    if (e.pointerType === 'touch') return this.touchDown(e)
    // The pen's eraser end is Epic 4.
    if ((e.buttons & 32) !== 0) return
    const middle = e.pointerType === 'mouse' && e.button === 1
    if (e.button !== 0 && !middle) return
    if (this.ownedBy(e.pointerId)) this.onCancel(e) // its release was lost
    if (this.mode === 'pen' || this.mode === 'pan' || this.mode === 'lasso' || this.mode === 'xform') return
    // A pen or mouse takes over: the touch stroke or gesture is dropped. Fingers
    // still down stay in `touches`, so they never turn into ink.
    this.discardStroke()
    this.gesture = null
    this.capture(e)
    // The lasso selects on every page, read-only or conflicted too; before the pan branches so it never leaks into a pan.
    if (this.tool === 'lasso' && !middle && !this.hand) return this.lassoDown(e)
    // Read-only: pen and mouse drags pan (touch took its own path above). So do they on a conflicted page.
    const blocked = !this.readOnly && !middle && !this.hand && this.onLockedPage(e)
    if (middle || this.readOnly || blocked || (this.hand && e.pointerType === 'mouse')) {
      if (blocked) this.onBlocked()
      this.mode = 'pan'
      this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY }
      this.handUsed = true
      e.preventDefault()
      this.canvas?.classList.add('is-panning')
      return
    }
    this.mode = 'pen'
    this.penId = e.pointerId
    this.begin(e)
  }

  /** `e` lands on a page that is locked by a conflict. */
  private onLockedPage(e: PointerEvent): boolean {
    const s = this.under(e)
    return !!s && this.history.isLocked(s.page.id)
  }

  private touchDown(e: PointerEvent): void {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.capture(e)
    if (this.mode === 'none') {
      // A new finger while others are still down is never input.
      if (this.touches.size > 1) {
        this.mode = 'ignored'
        return
      }
      this.firstId = e.pointerId
      this.firstDown = e.timeStamp
      this.mode = 'idle'
      this.begin(e)
      if (this.drawing) this.mode = 'stroke'
    } else if ((this.mode === 'stroke' || this.mode === 'idle') && this.touches.size === 2) {
      // Over a stroke a later finger is ignored; where nothing was drawn it always starts a gesture.
      if (this.mode === 'idle' || e.timeStamp - this.firstDown <= SECOND_FINGER_MS) this.startGesture(this.firstId, e.pointerId)
    }
  }

  private startGesture(a: number, b: number): void {
    this.discardStroke()
    this.mode = 'gesture'
    const pa = this.touches.get(a)!
    const pb = this.touches.get(b)!
    const [fx, fy] = this.local((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)
    this.gesture = {
      a,
      b,
      s0: this.viewport.scale,
      d0: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)),
      p0: toPage(this.viewport, fx, fy),
    }
  }

  private pinch(): void {
    const g = this.gesture
    const pa = g && this.touches.get(g.a)
    const pb = g && this.touches.get(g.b)
    if (!g || !pa || !pb) return
    const [fx, fy] = this.local((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)
    const s = snapScale((g.s0 * Math.hypot(pa.x - pb.x, pa.y - pb.y)) / g.d0, this.fitFor('width').scale)
    this.changeView(this.clamp({ scale: s, offsetX: fx - g.p0[0] * s, offsetY: fy - g.p0[1] * s }))
  }

  private ownedBy(id: number): boolean {
    return (this.mode === 'pen' && this.penId === id) || (this.mode === 'pan' && this.pan?.id === id) || (this.mode === 'lasso' && this.lasso?.id === id) || (this.mode === 'xform' && this.xform?.id === id)
  }

  private onMove(e: PointerEvent): void {
    if (this.leaving) return
    // The button came up where we could not see it: end the stroke or drag.
    if (e.buttons === 0 && e.pointerType !== 'touch' && this.ownedBy(e.pointerId)) return this.onCancel(e)
    const t = this.touches.get(e.pointerId)
    if (t) {
      t.x = e.clientX
      t.y = e.clientY
      if (this.mode === 'gesture' && (e.pointerId === this.gesture?.a || e.pointerId === this.gesture?.b)) {
        this.pinch()
        return
      }
    }
    if (this.mode === 'pan' && this.pan && e.pointerId === this.pan.id) {
      const { x, y } = this.pan
      this.pan.x = e.clientX
      this.pan.y = e.clientY
      this.movePan(x - e.clientX, y - e.clientY)
      return
    }
    if (this.mode === 'xform' && this.xform && e.pointerId === this.xform.id) {
      const x = this.xform
      const [dx, dy] = toPage(this.viewport, ...this.local(e.clientX, e.clientY))
      if (Number.isFinite(dx) && Number.isFinite(dy)) x.cur = [dx - x.slot.x, dy - x.slot.y]
      x.shift = e.shiftKey
      this.redraw()
      return
    }
    if (this.mode === 'lasso' && this.lasso && e.pointerId === this.lasso.id) {
      const l = this.lasso
      l.path.push(toPage(this.viewport, ...this.local(e.clientX, e.clientY)))
      if (Math.hypot(e.clientX - l.x, e.clientY - l.y) > CLICK_SLOP) l.moved = true
      if (l.moved) this.redraw()
      return
    }
    const d = this.drawing
    if (!d || e.pointerId !== d.id) return
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    // Not clipped here: points outside the page are kept.
    for (const ev of coalesced.length > 0 ? coalesced : [e]) {
      const p = this.point(ev, d.t0, undefined, { x: d.ox, y: d.oy })
      if (p) d.points.push(p)
    }
    this.redraw()
  }

  private onUp(e: PointerEvent): void {
    if (this.mode === 'xform' && this.xform?.id === e.pointerId) {
      const x = this.xform
      const [dx, dy] = toPage(this.viewport, ...this.local(e.clientX, e.clientY))
      if (Number.isFinite(dx) && Number.isFinite(dy)) x.cur = [dx - x.slot.x, dy - x.slot.y]
      x.shift = e.shiftKey
      this.mode = 'none'
      const d = x.down
      if (this.leaving) this.xform = null
      else if ((d.shift || d.alt) && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= CLICK_SLOP) {
        // Shift/Alt-click on a handle point: the lasso's toggle, not a resize.
        this.xform = null
        this.lasso = { id: x.id, shift: d.shift, alt: d.alt, x: d.x, y: d.y, moved: false, path: [d.doc] }
        this.lassoUp()
      } else this.finishXform()
    }
    if (this.mode === 'lasso' && this.lasso?.id === e.pointerId) {
      const l = this.lasso
      if (this.leaving) this.lasso = null
      else {
        // The release point counts too (a quick flick may arrive without a move).
        const end = toPage(this.viewport, ...this.local(e.clientX, e.clientY))
        if (Number.isFinite(end[0]) && Number.isFinite(end[1])) l.path.push(end)
        if (Math.hypot(e.clientX - l.x, e.clientY - l.y) > CLICK_SLOP) l.moved = true
        this.lassoUp()
      }
      this.mode = 'none'
    }
    const d = this.drawing
    if (!this.leaving && d && e.pointerId === d.id) {
      // A pen reports pressure 0 on release: the last point's pressure stays.
      const last = d.points[d.points.length - 1]!
      const p = this.point(e, d.t0, last[2], { x: d.ox, y: d.oy })
      if (p && (p[0] !== last[0] || p[1] !== last[1])) d.points.push(p)
      this.finishStroke()
    }
    this.release(e.pointerId)
  }

  private onCancel(e: PointerEvent): void {
    if (this.mode === 'xform' && this.xform?.id === e.pointerId) {
      this.xform = null
      this.mode = 'none'
      this.redraw()
    }
    if (this.mode === 'lasso' && this.lasso?.id === e.pointerId) {
      this.lasso = null
      this.mode = 'none'
      this.redraw()
    }
    if (!this.leaving && this.drawing && e.pointerId === this.drawing.id) this.finishStroke()
    this.release(e.pointerId)
  }

  /** A contact ended. Fingers left over stay ignored until every contact is up. */
  private release(id: number): void {
    this.touches.delete(id)
    if (this.mode === 'pan' && this.pan?.id === id) {
      this.pan = null
      this.canvas?.classList.remove('is-panning')
      this.mode = 'none'
    } else if (this.mode === 'pen' && this.penId === id) {
      this.mode = 'none'
    } else if (this.mode === 'gesture' && (id === this.gesture?.a || id === this.gesture?.b)) {
      this.gesture = null
      this.mode = 'ignored'
    } else if ((this.mode === 'stroke' || this.mode === 'idle') && id === this.firstId) {
      this.mode = 'ignored'
    }
    if (this.mode === 'ignored' && this.touches.size === 0) this.mode = 'none'
  }

  /** Ends the stroke in progress with the points so far. */
  private finishStroke(): void {
    const d = this.drawing
    this.drawing = null
    if (this.readOnly || !d) return this.releaseStrokeWaiters(null)
    const err = this.history.doOp({ op: 'addStroke', pageId: d.pageId, stroke: this.build(d.points, d.strokeId) }, this.ctx())
    this.redraw()
    if (err) this.message('strokeNotAdded')
    else {
      this.queue.commit(this.history.note)
      this.onChange()
    }
    // After the op is in the history: whoever waited merges the note with this stroke in it.
    this.releaseStrokeWaiters(err ? null : d.pageId)
  }

  private ctx() {
    return { rev: newId(), now: new Date().toISOString(), editedBy: this.editedBy(), lastSeenRemoteSeq: 0 }
  }

  get canUndo() {
    return !this.readOnly && !this.pageLocked && this.history.undoDepth > 0 && !this.history.topLocked('undo')
  }
  get canRedo() {
    return !this.readOnly && !this.pageLocked && this.history.redoDepth > 0 && !this.history.topLocked('redo')
  }

  /** Undoes the last edit; false when nothing happened. */
  undo(): boolean {
    return this.replay('undo')
  }
  redo(): boolean {
    return this.replay('redo')
  }

  private replay(kind: 'undo' | 'redo'): boolean {
    const depth = kind === 'undo' ? this.history.undoDepth : this.history.redoDepth
    this.clearNudge()
    if ((this.pageLocked || this.history.topLocked(kind)) && !this.readOnly && !this.leaving) {
      this.onBlocked() // the record of a conflicted page is gone; nothing else is undone under it
      return false
    }
    if (this.readOnly || this.leaving || this.drawing || this.touches.size > 0 || this.mode !== 'none' || depth === 0) return false
    const err = this.history[kind](this.ctx())
    if (err) {
      this.message('historyNotApplied')
      return false
    }
    // The history has advanced: the save must happen even if drawing throws.
    try {
      this.redraw()
    } catch {
      // the next layout repaints
    }
    this.queue.commit(this.history.note)
    this.onChange()
    return true
  }

  /** Waits until the save queue is on disk (the upload reads the note after this); false = a snapshot is still unsaved. */
  flushSaves(): Promise<boolean> {
    return this.queue.flush()
  }

  /**
   * A sync result for this note joins the queue (AD-16): merged against the
   * note as it is now, undo records of replaced pages dropped, then saved.
   * `unsupportedVersion` and errors leave the note as it is.
   */
  applyMerge(a: {
    base: Note | null
    localAtStart: Note
    remote: Note
    ctx: MergeCtx
    expect?: readonly string[]
    held?: string | null
  }): RequeueResult | { result: 'stale' } {
    // Not applied while closing, read-only or mid-stroke: the caller decides again later.
    if (this.readOnly || this.leaving || this.drawing !== null) return { result: 'stale' }
    if (a.expect) {
      // The sidecars were recorded for a preview. Apply only that: another sidecar (the page changed) or a
      // stroke that began meanwhile means the preview is old.
      const pre = mergeRequeue({ base: a.base, localAtStart: a.localAtStart, localAtCommit: this.history.note, remote: a.remote, ctx: a.ctx })
      const keys = new Set(a.expect)
      if (pre.result === 'merged' && (this.drawing !== null || pre.sidecars.some((s) => !keys.has(sidecarKey(s))))) return { result: 'stale' }
    }
    const before = this.history.note
    const key = this.docKey()
    const r = commitMerge(this.history, a)
    if (r.result === 'merged') {
      if (r.conflicts.length > 0) {
        this.history.lockPages(r.conflicts.map((c) => c.pageId))
        const held = a.held ? before.pages.find((p) => p.id === a.held) : undefined
        if (held && r.conflicts.some((c) => c.pageId === held.id)) this.held = structuredClone(held)
      }
      try {
        this.docChanged(key)
      } catch {
        // the next layout repaints
      }
      this.queue.commit(this.history.note)
      this.onChange() // undo/redo buttons re-read their aria-disabled state
    }
    return r
  }

  /**
   * [Story 3.22] Settles one conflict through the same serial path as a merge (AD-16): `resolveConflict` runs on the
   * note as it is now, the history adopts the result and drops the undo records of the pages it touched, the page is
   * redrawn and the note joins the save queue. No await in between. `identicalVersions` keeps the other device's
   * version. Nothing changes on an error.
   */
  applyResolved(conflict: Conflict, sidecar: Sidecar, choice: string): ResolveApplied | { error: string; result?: undefined } {
    if (this.readOnly || this.leaving || this.drawing !== null) return { error: 'notApplied' }
    const ctx = { now: new Date().toISOString(), orderRev: newId(), rev: newId(), editedBy: this.editedBy(), lastSeenRemoteSeq: 0 }
    let used = choice
    let out = resolveConflict(this.history.note, conflict, sidecar, used, ctx)
    if (out.result !== 'resolved' && out.error === 'identicalVersions') {
      used = 'theirs' // the same version on both sides: keep one
      out = resolveConflict(this.history.note, conflict, sidecar, used, ctx)
    }
    if (out.result !== 'resolved') return { error: out.error }
    const key = this.docKey()
    this.history.applyMerged(out.note, out.undoDrop)
    if (this.held && out.undoDrop.includes(this.held.id)) this.held = null
    try {
      this.docChanged(key)
    } catch {
      // the next layout repaints
    }
    this.queue.commit(this.history.note)
    this.onChange()
    return { ...out, used }
  }

  /**
   * [Story 3.25] A restore joins the queue as one edit (AD-16): `run` sees the note as it is now, synchronously; the
   * history adopts its result and drops the undo records of the pages it touched, the note is redrawn and saved. No
   * await in between. False, nothing changed, when read-only, leaving, a stroke or gesture is going on, or `run` says no.
   */
  applyRestored(run: (live: Note) => { note: Note; undoDrop: string[] } | null): boolean {
    if (this.readOnly || this.leaving || this.busy()) return false
    const out = run(this.history.note)
    if (!out) return false
    const key = this.docKey()
    this.history.applyMerged(out.note, out.undoDrop)
    if (this.held && out.undoDrop.includes(this.held.id)) this.held = null
    try {
      this.docChanged(key)
    } catch {
      // the next layout repaints
    }
    this.queue.commit(this.history.note)
    this.onChange()
    return true
  }

  /** The conflicts are settled or changed: the locks follow the pages that still have one. */
  setLocked(pageIds: Iterable<string>): void {
    this.history.setLocked(pageIds)
    this.onChange()
  }

  /**
   * Leaving: ignore input, end the stroke, drain the queue, retry a failed
   * save once, close the store. Idempotent; tracked so the library waits for it.
   */
  finalize(): Promise<void> {
    // finishAndClose runs its first, synchronous part (the stroke ends) before
    // `finalizing` is set; no input event can interleave there.
    this.clearNudge()
    return (this.finalizing ??= trackSave(this.finishAndClose()))
  }

  private async finishAndClose(): Promise<void> {
    try {
      this.finishStroke()
      // A read-only writer has nothing of its own to save.
      if (!this.readOnly && !(await this.queue.flush())) {
        markUnsaved() // the library tells the user
        this.message('saveFailed')
      }
    } catch {
      markUnsaved()
    } finally {
      this.store.close()
    }
  }
}
