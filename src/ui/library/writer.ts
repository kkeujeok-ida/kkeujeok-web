// The writing surface of one open note: pointer input -> addStroke ops on a
// History -> serial saves, and the canvas that shows the page (with its zoom
// and pan view). No React here.
import { newId } from '../../model/ids'
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
type Mode = 'none' | 'stroke' | 'idle' | 'gesture' | 'ignored' | 'pen' | 'pan'
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
  private laidOut = false
  private layoutKey = ''
  private ins: ViewInsets = { gap: 0, extraBottom: 0 }
  private anim: { from: PageViewport; to: PageViewport; t0: number; raf: number } | null = null
  private cssW = 0
  private cssH = 0
  private dpr = 1
  private finalizing: Promise<void> | null = null
  /** Padding and the room under the page's end; the editor knows the toolbar. */
  insets: () => ViewInsets = () => ({ gap: 0, extraBottom: 0 })
  /** Another tab holds the note: view, zoom and pan only (spec 2.13). */
  readOnly = false
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
    return this.drawing !== null || this.mode === 'gesture' || this.mode === 'pan'
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
    const z = zoomAbout(base, this.cssW / 2, this.cssH / 2, base.scale * factor)
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
      const z = zoomAbout(this.viewport, fx, fy, this.viewport.scale * Math.exp(-dy * WHEEL_ZOOM))
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
    if (this.readOnly) return
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
    if (this.mode === 'pen' || this.mode === 'pan') return
    // A pen or mouse takes over: the touch stroke or gesture is dropped. Fingers
    // still down stay in `touches`, so they never turn into ink.
    this.discardStroke()
    this.gesture = null
    this.capture(e)
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
    const s = clampScale((g.s0 * Math.hypot(pa.x - pb.x, pa.y - pb.y)) / g.d0)
    this.changeView(this.clamp({ scale: s, offsetX: fx - g.p0[0] * s, offsetY: fy - g.p0[1] * s }))
  }

  private ownedBy(id: number): boolean {
    return (this.mode === 'pen' && this.penId === id) || (this.mode === 'pan' && this.pan?.id === id)
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
