// The writing surface of one open note: pointer input -> addStroke ops on a
// History -> serial saves, and the canvas that shows the page. No React here.
import { newId } from '../../model/ids'
import type { Note, Page, Stroke } from '../../model/note'
import type { Pen } from '../../model/pen'
import { History } from '../../ops/history'
import { fitViewport, paintPage, StrokePathCache, type PageViewport } from '../../render/pagePainter'
import type { NoteStore } from '../../storage/noteStore'
import { SaveQueue, markUnsaved, trackSave } from '../../storage/saveQueue'

export type WriterMessage = 'saveFailed' | 'strokeNotAdded'

type Drawing = { id: number; strokeId: string; type: string; t0: number; points: number[][] }
const POINTER_TYPES = ['pen', 'mouse', 'touch']

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export class Writer {
  readonly history: History
  readonly cache = new StrokePathCache()
  private queue: SaveQueue
  private canvas: HTMLCanvasElement | null = null
  private drawing: Drawing | null = null
  private down = new Map<number, string>() // pointer id -> type; only the first may draw
  private viewport: PageViewport = { scale: 1, offsetX: 0, offsetY: 0 }
  private cssW = 0
  private cssH = 0
  private dpr = 1
  private finalizing: Promise<void> | null = null

  constructor(
    note: Note,
    private store: NoteStore,
    private pen: () => Pen,
    private message: (m: WriterMessage) => void,
    private editedBy: () => string,
  ) {
    this.history = new History(note)
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
    ]
    const relayout = () => this.layout()
    // A window that lost focus may never deliver the release.
    const onBlur = () => {
      if (this.drawing) this.finishStroke()
      this.down.clear()
    }
    globalThis.addEventListener?.('blur', onBlur)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(relayout) : null
    ro?.observe(canvas)
    globalThis.addEventListener?.('resize', relayout)
    this.layout()
    return () => {
      offs.forEach((off) => off())
      ro?.disconnect()
      globalThis.removeEventListener?.('resize', relayout)
      globalThis.removeEventListener?.('blur', onBlur)
      if (this.canvas === canvas) this.canvas = null
    }
  }

  /** Fits the page whole into the canvas and sizes the backing store. */
  layout(): void {
    const c = this.canvas
    const page = this.page
    if (!c || !page) return
    const r = c.getBoundingClientRect()
    this.cssW = r.width
    this.cssH = r.height
    this.dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
    this.viewport = fitViewport(r.width, r.height, page.width, page.height)
    const w = Math.max(1, Math.round(r.width * this.dpr))
    const h = Math.max(1, Math.round(r.height * this.dpr))
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
    this.redraw()
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
    // event (O(n)); make it incremental if 2.15 measures it slow.
    paintPage(ctx, page, this.viewport, this.cache, this.drawing ? this.build(this.drawing.points, this.drawing.strokeId) : null)
  }

  private build(points: number[][], id: string): Stroke {
    const pen = this.pen()
    return { id, type: 'stroke', tool: 'pen', color: pen.color, width: pen.width, usePressure: pen.usePressure, points }
  }

  /** `[x, y, pressure, t]` of an event, or null when its position is not a number. */
  private point(e: PointerEvent, t0: number, pressure?: number): number[] | null {
    const c = this.canvas
    if (!c) return null
    const r = c.getBoundingClientRect()
    const x = (e.clientX - r.left - this.viewport.offsetX) / this.viewport.scale
    const y = (e.clientY - r.top - this.viewport.offsetY) / this.viewport.scale
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

  private onDown(e: PointerEvent): void {
    if (this.leaving || !this.page) return
    if (!POINTER_TYPES.includes(e.pointerType)) return
    // Left button or pen/finger contact only; the pen's eraser end is Epic 4.
    if (e.button !== 0 || (e.buttons & 32) !== 0) return
    if (this.down.size > 0) {
      // First pointer wins, except that a pen takes over from a finger: the
      // touch stroke is discarded.
      if (e.pointerType !== 'pen' || [...this.down.values()].every((t) => t === 'pen')) return
      this.drawing = null
      this.down.clear()
    }
    this.layout() // the canvas may have moved or resized since the last layout
    this.down.set(e.pointerId, e.pointerType)
    try {
      // Moves and the release arrive even outside the canvas or the window.
      this.canvas?.setPointerCapture(e.pointerId)
    } catch {
      // not capturable (synthetic event): still handled while over the canvas
    }
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

  private onMove(e: PointerEvent): void {
    const d = this.drawing
    if (this.leaving || !d || e.pointerId !== d.id) return
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
    this.down.delete(e.pointerId)
  }

  private onCancel(e: PointerEvent): void {
    if (!this.leaving && this.drawing && e.pointerId === this.drawing.id) this.finishStroke()
    this.down.delete(e.pointerId)
  }

  /** Ends the stroke in progress with the points so far. */
  private finishStroke(): void {
    const d = this.drawing
    const page = this.page
    this.drawing = null
    if (!d || !page) return
    const err = this.history.doOp(
      { op: 'addStroke', pageId: page.id, stroke: this.build(d.points, d.strokeId) },
      { rev: newId(), now: new Date().toISOString(), editedBy: this.editedBy(), lastSeenRemoteSeq: 0 },
    )
    this.redraw()
    if (err) this.message('strokeNotAdded')
    else this.queue.commit(this.history.note)
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
      if (!(await this.queue.flush())) {
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
