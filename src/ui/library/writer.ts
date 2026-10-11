// The writing surface of one open note: pointer input -> addStroke ops on a
// History -> serial saves, and the canvas that shows the page (with its zoom
// and pan view). No React here.
import { newId } from '../../model/ids'
import type { Page, Stroke } from '../../model/note'
import type { Pen } from '../../model/pen'
import type { History } from '../../ops/history'
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

type Drawing = { id: number; strokeId: string; type: string; t0: number; points: number[][] }
const POINTER_TYPES = ['pen', 'mouse', 'touch']
/** A second finger this soon after the first turns the stroke into a gesture. */
const SECOND_FINGER_MS = 150
const ANIMATION_MS = 150
const WHEEL_ZOOM = 0.002
export const ZOOM_STEP = 1.25
export const ARROW_STEP = 40

export type FitMode = 'width' | 'page' | 'free'
// Who owns the pointers: nobody, a touch stroke, a touch outside the page, a
// two-finger gesture, fingers to ignore until all lift, a pen/mouse, a pan drag.
type Mode = 'none' | 'stroke' | 'idle' | 'gesture' | 'ignored' | 'pen' | 'pan'
export type ViewInfo = { scale: number; x: Thumb | null; y: Thumb | null }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export class Writer {
  readonly cache = new StrokePathCache()
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

  constructor(
    readonly history: History,
    private store: NoteStore,
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

  private get page(): Page | undefined {
    return this.history.note.pages[0]
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
    const page = this.page
    if (!c || !page) return
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
    const page = this.page!
    const f = mode === 'width' ? fitWidthViewport : fitPageViewport
    return f(this.cssW, this.cssH, page.width, page.height, this.ins)
  }

  private clamp(v: PageViewport): PageViewport {
    const page = this.page!
    return clampViewport(v, this.cssW, this.cssH, page.width, page.height, this.ins)
  }

  /** The scale to show (the target while animating) and the scrollbars of what is on screen. */
  info(): ViewInfo {
    const page = this.page
    const v = this.anim?.to ?? this.viewport
    const m = page ? scrollMetrics(v, this.cssW, this.cssH, page.width, page.height, this.ins) : { x: null, y: null }
    return { scale: v.scale, ...m }
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

  private busy(): boolean {
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
    const page = this.page
    if (!c || !page) return
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
    paintPage(ctx, page, this.viewport, this.cache, this.drawing ? this.build(this.drawing.points, this.drawing.strokeId) : null)
  }

  private build(points: number[][], id: string): Stroke {
    const pen = this.pen()
    return { id, type: 'stroke', tool: 'pen', color: pen.color, width: pen.width, usePressure: pen.usePressure, points }
  }

  private local(x: number, y: number): [number, number] {
    const r = this.canvas!.getBoundingClientRect()
    return [x - r.left, y - r.top]
  }

  /** `[x, y, pressure, t]` of an event, or null when its position is not a number. */
  private point(e: PointerEvent, t0: number, pressure?: number): number[] | null {
    if (!this.canvas) return null
    const [x, y] = toPage(this.viewport, ...this.local(e.clientX, e.clientY))
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    let q = pressure
    if (q === undefined) {
      q = e.pointerType === 'pen' ? (Number.isFinite(e.pressure) ? clamp01(e.pressure) : 0.5) : 0.5
    }
    const dt = e.timeStamp - t0
    return [x, y, q, Number.isFinite(dt) ? Math.max(0, dt) : 0]
  }

  private inPage(p: number[]): boolean {
    const page = this.page
    return !!page && p[0]! >= 0 && p[1]! >= 0 && p[0]! <= page.width && p[1]! <= page.height
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
    const p = this.point(e, e.timeStamp)
    if (!p || !this.inPage(p)) return
    e.preventDefault()
    try {
      this.canvas?.focus({ preventScroll: true })
    } catch {
      // focus is a convenience
    }
    this.drawing = { id: e.pointerId, strokeId: newId(), type: e.pointerType, t0: e.timeStamp, points: [p] }
    this.redraw()
  }

  /** Drops the stroke in progress: no op, no save. */
  private discardStroke(): void {
    if (!this.drawing) return
    this.drawing = null
    this.redraw()
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
    // Read-only: pen and mouse drags pan (touch took its own path above).
    if (middle || this.readOnly || (this.hand && e.pointerType === 'mouse')) {
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
      const p = this.point(ev, d.t0)
      if (p) d.points.push(p)
    }
    this.redraw()
  }

  private onUp(e: PointerEvent): void {
    const d = this.drawing
    if (!this.leaving && d && e.pointerId === d.id) {
      // A pen reports pressure 0 on release: the last point's pressure stays.
      const last = d.points[d.points.length - 1]!
      const p = this.point(e, d.t0, last[2])
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
    const page = this.page
    this.drawing = null
    if (this.readOnly || !d || !page) return
    const err = this.history.doOp({ op: 'addStroke', pageId: page.id, stroke: this.build(d.points, d.strokeId) }, this.ctx())
    this.redraw()
    if (err) this.message('strokeNotAdded')
    else {
      this.queue.commit(this.history.note)
      this.onChange()
    }
  }

  private ctx() {
    return { rev: newId(), now: new Date().toISOString(), editedBy: this.editedBy(), lastSeenRemoteSeq: 0 }
  }

  get canUndo() {
    return !this.readOnly && this.history.undoDepth > 0
  }
  get canRedo() {
    return !this.readOnly && this.history.redoDepth > 0
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
