// The writing surface of one open note: pointer input -> addStroke ops on a
// History -> serial saves, and the canvas that shows the page (with its zoom
// and pan view). No React here.
import { newId } from '../../model/ids'
import { pageOutOfBounds } from '../../model/pageBounds'
import { elementClipboard } from '../../model/elementClipboard'
import { isTextBox, selectLasso, selectRect, selectTap, selectionBounds, selectionFrame, type Bounds, type El } from '../../model/select'
import { cpIndex, formatAt, formatRange, retextRuns, type TextFormat } from '../../model/textEdit'
import { COLOR_DEFAULT, SIZE_DEFAULT, WIDTH_MIN, cpLen, isBlankText, layoutText, normalizeNewlines, normalizeRuns, textHeight, type Run } from '../../model/textLayout'
import { imageInitialSize } from '../../model/imageRules'
import type { ImageHost } from '../../render/imageHost'
import { ERASER_WIDTH, type EraserMode } from '../../storage/eraserSettings'
import { EraseScan, erasePieces } from '../../ops/ops'
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
  fitHeightViewport,
  fitPageViewport,
  fitWidthViewport,
  paintPage,
  eraserPreviewOpacity,
  scrollMetrics,
  StrokePathCache,
  toPage,
  snapScale,
  zoomAbout,
  type PageViewport,
  type Thumb,
  type ViewInsets,
} from '../../render/pagePainter'
import { PAGE_GAP, layoutSlots, type Unit } from '../../render/viewLayout'
import type { ViewMode } from '../../storage/viewMode'
import type { NoteStore } from '../../storage/noteStore'
import { SaveQueue, markUnsaved, trackSave } from '../../storage/saveQueue'

export type WriterMessage =
  | 'saveFailed'
  | 'strokeNotAdded'
  | 'historyNotApplied'
  | 'imageTooLarge'
  | 'imageConverted'
  | 'imageConvertFailed'
  | 'imageUnsupported'
  | 'imageUnreadable'
  | 'imageStoreFailed'

/** `ox`, `oy`: where the page of the stroke starts in the continuous scroll; `points` are in that page's coordinates. */
type Drawing = { id: number; strokeId: string; type: string; t0: number; points: number[][]; pageId: string; ox: number; oy: number }
const POINTER_TYPES = ['pen', 'mouse', 'touch']
/** A second finger this soon after the first turns the stroke into a gesture. */
const SECOND_FINGER_MS = 150
const ANIMATION_MS = 150
const WHEEL_ZOOM = 0.002
export const ZOOM_STEP = 1.25
export const ARROW_STEP = 40
/** Scrolling this far past an end adds a page (Story 6.5, tune by use). */
export const PULL_PX = 240
const PULL_IDLE_MS = 200
export { PAGE_GAP }

export type FitMode = 'width' | 'page' | 'free'
// Who owns the pointers: nobody, a touch stroke, a touch outside the page, a
// two-finger gesture, fingers to ignore until all lift, a pen/mouse, a pan drag.
type Mode = 'none' | 'stroke' | 'idle' | 'gesture' | 'ignored' | 'pen' | 'pan' | 'lasso' | 'xform' | 'erase'
export type Tool = 'pen' | 'eraser' | 'lasso' | 'text'
/** An eraser gesture: one press to release is one operation. `path` is in the coordinates of the page it started on; `preview` is that page's elements with the struck strokes marked (drawn translucent). */
type Erase = { id: number; type: string; temporary: boolean; pageId: string | null; ox: number; oy: number; path: number[][]; scan: EraseScan | null; scanned: number; preview: ReturnType<EraseScan['targets']> | null; src: Page | null }
/** What an eraser gesture did: `touched` is false when it hit no stroke; `temporary` is a pen-button erase under another tool. */
export type ErasedInfo = { pointerType: string; touched: boolean; temporary: boolean }
/** A press and release this close together (ms) and this near (CSS px) are a double click. */
const DOUBLE_MS = 450
const DOUBLE_SLOP = 8
/** A text box being edited (Story 4.10). `el` holds the box without its text and runs; `before` is the stored content of an existing box. */
type Edit = {
  pageId: string
  id: string
  isNew: boolean
  el: El
  text: string
  runs: Run[]
  before: { text: string; runs: Run[] } | null
  sel: [number, number]
  /** Format for the next typed text, set at a caret by the bar or Ctrl+B / Ctrl+I; dropped when the caret moves. */
  pending: { at: number; props: Record<string, unknown> } | null
}
/** What the editing overlay needs: the box on the canvas (CSS px), its content and the format at the selection. */
export type EditInfo = {
  id: string
  left: number
  top: number
  width: number
  height: number
  scale: number
  rotation: number
  text: string
  size: number
  /** The canvas size, for placing the bar. */
  w: number
  h: number
  format: TextFormat
}
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
type Xform = { id: number; kind: 'move' | 'scale' | 'rotate' | 'width'; corner: number; slot: Slot; ids: string[]; b: Bounds; /** The turn of the selection frame in degrees; `b` is the frame's box, centered where the selection is. */ angle: number; start: [number, number]; cur: [number, number]; shift: boolean; down: { x: number; y: number; doc: [number, number]; shift: boolean; alt: boolean } }
/** The selection box in canvas CSS px, and the canvas size, for the floating menu. */
export type SelectionBox = { left: number; top: number; right: number; bottom: number; w: number; h: number; /** The selection holds a stroke ([색]/[두께] apply) and the width of the first one. */ strokes?: boolean; width?: number }

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
/** A page and where it starts in the document (see `layoutSlots`); `unit` is the group it is shown with. */
type Slot = { page: Page; x: number; y: number; unit: number }
export type ResolveApplied = Extract<ResolveResult, { result: 'resolved' }> & { used: string }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export class Writer {
  private caches = new Map<string, StrokePathCache>() // one per page; a page off screen is not painted
  private queue: SaveQueue
  private canvas: HTMLCanvasElement | null = null
  private drawing: Drawing | null = null
  private erase: Erase | null = null
  private eraseFrame = 0
  /** The mouse or pen last moved over the canvas (not a finger): the eraser ring shows. */
  private ring = false
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
  private edit: Edit | null = null
  private lastEdit = ''
  private lastTap: { t: number; x: number; y: number } | null = null
  /** Undo depth right after a one-point stroke: a double click on a text box takes that dot back. */
  private lastDot: number | null = null
  private lasso: Lasso | null = null
  private xform: Xform | null = null
  private nudgeRun: { key: string; depth: number; timer: ReturnType<typeof setTimeout> } | null = null
  private lastBox = ''
  /** Last pointer position over the canvas (client px), null once it left: where Ctrl+V pastes. */
  private pointer: { x: number; y: number } | null = null
  /** The images of this note (bytes, sync state, decoded pictures); none: image elements are grey boxes and nothing can be inserted. */
  images: ImageHost | null = null
  /** The way the pages are laid out; set by the editor from the device setting. */
  private viewMode: ViewMode = 'vertical'
  /** A pen is known on this device: one finger moves the view instead of writing. */
  penOnly = false
  /** The first pen pointer was seen (hover included). Called once. */
  onPenSeen: () => void = () => {}
  private penSeen = false
  /** Keep the aspect ratio when resizing (Shift flips it for one drag). UI state, not saved. */
  ratioLock = true
  /** Selection is UI state (never in the note): the page and the ids of its selected elements. */
  private selection: { pageId: string; ids: Set<string> } | null = null
  /** Padding and the room under the page's end; the editor knows the toolbar. */
  insets: () => ViewInsets = () => ({ gap: 0, extraBottom: 0 })
  /** Another tab holds the note: view, zoom and pan only (spec 2.13). */
  readOnly = false
  /** How the eraser works; set by the editor from the device setting. */
  eraserMode: EraserMode = 'stroke'
  /** An eraser gesture ended (after its operation, if any, is in the history). */
  onErased: (info: ErasedInfo) => void = () => {}
  /** Called with the number of selected elements whenever the selection changed. */
  onSelection: (n: number) => void = () => {}
  /** Called when the box the floating menu hangs on changed (null: no editable selection). */
  onBox: (b: SelectionBox | null) => void = () => {}
  /** Called when the text box being edited (or its place, content or format) changed; null when none. */
  onEdit: (i: EditInfo | null) => void = () => {}
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

  /** Every page of the document (the held version stands in for its page), with its place. */
  private slots(): { list: Slot[]; units: Unit[]; w: number; h: number } {
    const pages = this.history.note.pages.map((p0) => (this.held && this.held.id === p0.id ? this.held : p0))
    const d = layoutSlots(pages, this.viewMode)
    return { list: d.list.map((l) => ({ page: pages[l.index]!, x: l.x, y: l.y, unit: l.unit })), units: d.units, w: d.w, h: d.h }
  }

  /** Index in `list` of the current page: the one a page key moved to, else the one at the middle of the view (the left page of a two-page unit). */
  private currentIndex(list: Slot[], units?: Unit[], raw = false): number {
    if (list.length < 2) return 0
    let i = list.findIndex((s) => s.page.id === this.forced)
    if (i < 0) {
      const side = this.viewMode !== 'vertical'
      const [mx, my] = toPage(this.viewport, this.cssW / 2, this.cssH / 2)
      i = list.findIndex((s) => (side ? mx < s.x + s.page.width + PAGE_GAP / 2 : my < s.y + s.page.height + PAGE_GAP / 2))
      if (i < 0) i = list.length - 1
    }
    return this.viewMode === 'twoPage' && !raw ? (units ?? this.slots().units)[list[i]!.unit]!.first : i
  }

  /** The id of the page actually in view (the right page of a two-page unit stays itself). */
  private inView(): string | undefined {
    const { list, units } = this.slots()
    return list[this.currentIndex(list, units, true)]?.page.id
  }

  private get current(): Slot | undefined {
    const { list, units } = this.slots()
    return list[this.currentIndex(list, units)]
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
      on('pointerleave', () => {
        this.pointer = null
        if (this.tool === 'eraser' && !this.erase) this.redraw()
      }),
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
      this.finishErase()
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
    // Glyphs are drawn with Pretendard: load both weights and repaint when they arrive.
    const fonts = (globalThis.document as Document | undefined)?.fonts
    const repaint = () => this.redraw()
    void Promise.all([fonts?.load('400 16px Pretendard'), fonts?.load('600 16px Pretendard')]).then(repaint, () => {})
    fonts?.addEventListener?.('loadingdone', repaint)
    return () => {
      fonts?.removeEventListener?.('loadingdone', repaint)
      offs.forEach((off) => off())
      canvas.removeEventListener('wheel', onWheel)
      if (this.pull.timer) clearTimeout(this.pull.timer)
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
      // The page in view before the size changes stays the current one.
      const keep = this.laidOut && key !== this.layoutKey ? this.inView() : undefined
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
          if (keep) this.forced = keep
          const v = this.fitFor(this.fitMode === 'page' ? 'page' : 'width')
          this.viewport = keep && this.fitMode === 'width' ? this.atStart(v) : v
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
    if (this.viewMode === 'vertical') {
      if (mode === 'width') return fitWidthViewport(this.cssW, this.cssH, d.w, d.h, this.ins)
      // A whole page, the current one; with one page that is the whole document.
      const cur = d.list[this.currentIndex(d.list, d.units)]!
      const v = fitPageViewport(this.cssW, this.cssH, cur.page.width, cur.page.height, this.ins)
      return this.clamp({ scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY - cur.y * v.scale })
    }
    // Side by side: the current unit as tall as the area ('width') or whole in it ('page').
    const u = d.units[d.list[this.currentIndex(d.list, d.units)]!.unit]!
    // 'width' fits the tallest page of the layout, so a mix of heights never leaves a vertical range.
    const v = mode === 'width' ? fitHeightViewport(this.cssW, this.cssH, u.w, d.h, this.ins) : fitPageViewport(this.cssW, this.cssH, u.w, u.h, this.ins)
    return this.clamp({ scale: v.scale, offsetX: (mode === 'width' ? 0 : v.offsetX) - u.x * v.scale, offsetY: mode === 'width' ? v.offsetY : v.offsetY - u.y * v.scale })
  }

  /** `v` moved so that the current page (unit) starts the view along the page axis. */
  private atStart(v: PageViewport): PageViewport {
    const d = this.slots()
    const u = d.units[d.list[this.currentIndex(d.list, d.units)]!.unit]!
    return this.clamp(this.viewMode === 'vertical' ? { ...v, offsetY: this.ins.gap - u.y * v.scale } : { ...v, offsetX: -u.x * v.scale })
  }

  /** The way pages are laid out. The page in view stays in view; the view starts at the mode's width fit. */
  setViewMode(m: ViewMode): void {
    if (m === this.viewMode) return
    const id = this.canvas && this.page ? this.inView() : undefined
    this.snap()
    this.viewMode = m
    if (!this.canvas || !this.page) return
    if (id) this.forced = id
    this.setView(this.atStart(this.fitFor('width')), 'width')
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
    return { scale: v.scale, ...m, page: this.currentIndex(d.list, d.units), pages: d.list.length }
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
    const { list, units } = this.slots()
    if (list.length === 0 || this.busy()) return
    const k = Math.min(list.length - 1, Math.max(0, i))
    const v = this.anim?.to ?? this.viewport
    const u = units[list[k]!.unit]!
    this.forced = list[k]!.page.id
    const at = this.viewMode === 'vertical' ? { offsetX: v.offsetX, offsetY: this.ins.gap - u.y * v.scale } : { offsetX: -u.x * v.scale, offsetY: v.offsetY }
    this.goTo(this.clamp({ scale: v.scale, ...at }), 'free')
  }

  /** PgUp / PgDn: the page before / after the current one (the unit, in the two-page view). */
  pageStep(d: -1 | 1): void {
    const { list, units } = this.slots()
    if (list.length === 0) return
    const cur = this.currentIndex(list, units)
    if (this.viewMode !== 'twoPage') return this.goToPage(cur + d)
    this.goToPage(units[Math.min(units.length - 1, Math.max(0, list[cur]!.unit + d))]!.first)
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
    return this.drawing !== null || this.queue.pending || (this.edit !== null && !isBlankText(this.edit.text))
  }

  /** A stroke, a gesture or a pan is going on. */
  busy(): boolean {
    return this.drawing !== null || this.mode === 'gesture' || this.mode === 'pan' || this.mode === 'lasso' || this.mode === 'xform' || this.mode === 'erase'
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
    this.forced = null
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

  /** Wheel and arrow scrolling: side by side with nothing to scroll up or down, a vertical move goes sideways. */
  scroll(dx: number, dy: number): void {
    if (this.busy()) return
    const sideways = this.viewMode !== 'vertical' && this.info().y === null
    this.movePan(sideways ? dx + dy : dx, sideways ? 0 : dy)
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
      this.forced = null
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
    const before = this.viewport
    this.scroll(dx, dy)
    this.pullCheck(before, this.viewMode !== 'vertical' && this.info().y === null ? dx + dy : dy)
  }

  /**
   * Scrolling past the first / last page (Story 6.5): only a wheel run that began at that edge counts, so inertia that
   * rolls into the edge adds nothing. PULL_PX of one run adds a page; a pause ends the run.
   */
  private pull = { edge: null as 'start' | 'end' | null, sum: 0, last: 0, timer: 0 as ReturnType<typeof setTimeout> | 0, fresh: true }
  private pullCheck(before: PageViewport, amount: number): void {
    const p = this.pull
    const now = globalThis.performance?.now() ?? Date.now()
    if (now - p.last > PULL_IDLE_MS) Object.assign(p, { edge: null, sum: 0, fresh: true })
    p.last = now
    const blocked = amount !== 0 && before.offsetX === this.viewport.offsetX && before.offsetY === this.viewport.offsetY
    const dir = amount > 0 ? 'end' : 'start'
    if (p.fresh) p.edge = blocked && !this.readOnly ? dir : null
    p.fresh = false
    if (p.edge && blocked && p.edge === dir) p.sum += Math.abs(amount)
    else Object.assign(p, { edge: null, sum: 0 })
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => this.pullEnd(), PULL_IDLE_MS)
    if (p.edge && p.sum >= PULL_PX) {
      const edge = p.edge
      Object.assign(p, { edge: null, sum: 0 }) // one page per run
      this.onPull(null)
      this.onPullAdd(edge)
      return
    }
    this.onPull(p.edge && p.sum > 0 ? { edge: p.edge, ratio: Math.min(1, p.sum / PULL_PX) } : null)
  }
  private pullEnd(): void {
    Object.assign(this.pull, { edge: null, sum: 0, timer: 0 })
    this.onPull(null)
  }
  /** The pull indicator: how far the person has scrolled past an end (null: none). */
  onPull: (p: { edge: 'start' | 'end'; ratio: number } | null) => void = () => {}
  /** The pull reached its amount: add a page at that end. */
  onPullAdd: (edge: 'start' | 'end') => void = () => {}

  redraw(): void {
    const c = this.canvas
    if (!c || !this.page) return
    this.emitBox()
    this.emitEdit()
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
    this.images?.watch(this.history.note)
    const live = this.drawing ? this.build(this.drawing.points, this.drawing.strokeId) : null
    const draft = this.edit ? { pageId: this.edit.pageId, id: this.edit.id, el: this.draftEl(this.edit) } : null
    for (const s of this.slots().list) {
      // A page that is off screen is not painted.
      const top = vp.offsetY + s.y * vp.scale
      const left = vp.offsetX + s.x * vp.scale
      if (top > this.cssH || top + s.page.height * vp.scale < 0 || left > this.cssW || left + s.page.width * vp.scale < 0) continue
      const at = { scale: vp.scale, offsetX: left, offsetY: top }
      const er = this.erase
      // The preview is a snapshot: the page changed mid-gesture (undo, remote update), so recompute it.
      if (er && er.pageId === s.page.id && er.preview && er.src !== s.page) {
        er.src = s.page
        er.scan = this.scanOf(s.page, er.path)
        er.scanned = er.path.length
        er.preview = er.scan?.targets() ?? null
      }
      const pv = er && er.pageId === s.page.id ? er.preview : null
      const shown = pv ? { ...s.page, elements: pv.elements } : s.page
      paintPage(ctx, shown, at, this.cacheOf(s.page.id), this.drawing?.pageId === s.page.id ? live : null, draft && draft.pageId === s.page.id ? draft : null, this.images ?? undefined, pv ? { ids: pv.fadeIds, alpha: eraserPreviewOpacity(c) } : null)
    }
    if (this.ring && this.pointer && (this.tool === 'eraser' || this.erase)) {
      const [rx, ry] = this.local(this.pointer.x, this.pointer.y)
      ctx.save()
      ctx.beginPath()
      ctx.arc(rx, ry, (ERASER_WIDTH * vp.scale) / 2, 0, Math.PI * 2)
      ctx.lineWidth = 1
      ctx.strokeStyle = selectionColors(c).outline
      ctx.stroke()
      ctx.restore()
    }
    // Over the page clip: the box and its handles may stand outside the page.
    const sel = this.selected()
    const fr = sel ? this.frameOf(sel.els) : null
    const b = fr?.b ?? null
    const path = this.lasso?.moved ? this.lasso.path : null
    if (b || path) {
      // A drag shows the box as it would end up (the elements change on release).
      const pv = this.xform && b ? this.preview(this.xform) : { b, angle: fr?.angle ?? 0 }
      const pb = pv.b
      const box = pb && sel && { left: pb.left + sel.slot.x, top: pb.top + sel.slot.y, right: pb.right + sel.slot.x, bottom: pb.bottom + sel.slot.y }
      const ts = this.textSel()
      paintSelection(ctx, vp, box, path, selectionColors(c), pv.angle, ts && !this.xform ? [ts.l, ts.r] : [])
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
    const same = this.selection?.pageId === pageId && this.selection.ids.size === set.size && [...set].every((i) => this.selection!.ids.has(i))
    if (!same) this.selTurn = 0
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
    this.commitEdit() // another tool confirms the box
    const was = this.tool
    this.tool = t
    this.canvas?.classList.toggle('is-eraser', t === 'eraser')
    if (t !== 'lasso') this.clearSelection()
    if (was === 'eraser' || t === 'eraser') this.redraw() // the ring
  }

  get currentTool(): Tool {
    return this.tool
  }

  /** Story 6.9: selects the elements of page `pageId` that stand outside it; the count (0: none, or the page is unknown). */
  selectOutOfBounds(pageId: string): number {
    const page = this.history.note.pages.find((p) => p.id === pageId)
    if (!page || this.busy()) return 0
    const ids = pageOutOfBounds(page.width, page.height, page.elements as El[])
    this.setSelection(ids.length > 0 ? pageId : '', ids)
    return ids.length
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

  /** How far the selection was turned since it was picked (degrees): the angle of the frame of strokes and groups. */
  private selTurn = 0

  /** The angle of the selection frame: a single box element uses its own rotation, strokes and groups the turn so far. */
  private selAngle(els: readonly El[]): number {
    const one = els.length === 1 ? els[0]! : null
    if (one && one.type !== 'stroke' && typeof one.rotation === 'number') return one.rotation
    return this.selTurn
  }

  /** The selection box turned with the selection, in page coordinates (a plain box centered where the frame is) and its angle. */
  private frameOf(els: readonly El[]): { b: Bounds; angle: number } | null {
    const angle = this.selAngle(els)
    const f = selectionFrame(els, angle)
    if (!f) return null
    return { b: { left: f.cx - f.w / 2, right: f.cx + f.w / 2, top: f.cy - f.h / 2, bottom: f.cy + f.h / 2 }, angle }
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
      strokes: sel.els.some((e) => e.type === 'stroke'),
      width: sel.els.find((e) => e.type === 'stroke')?.width as number | undefined,
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
    const fr = this.frameOf(sel.els)
    if (!fr) return false
    const { b, angle } = fr
    const v = this.viewport
    const [lx, ly] = this.local(e.clientX, e.clientY)
    const sx = (x: number) => v.offsetX + (x + sel.slot.x) * v.scale
    const sy = (y: number) => v.offsetY + (y + sel.slot.y) * v.scale
    // The corners, the rotate handle and the inside are tested in the frame of the selection: a turned box is hit where it is drawn.
    const [fx, fy] = this.intoFrame(lx, ly, (sx(b.left) + sx(b.right)) / 2, (sy(b.top) + sy(b.bottom)) / 2, angle)
    let hit: ReturnType<typeof hitSelection> | 'width' = hitSelection(sx(b.left), sy(b.top), sx(b.right), sy(b.bottom), fx, fy)
    // The side handles of a single text box change its width; a corner at least as near wins (short boxes).
    const ts = this.textSel()
    let side = -1
    if (ts && !e.shiftKey && !e.altKey) {
      const dl = Math.hypot(lx - (v.offsetX + ts.l[0] * v.scale), ly - (v.offsetY + ts.l[1] * v.scale))
      const dr = Math.hypot(lx - (v.offsetX + ts.r[0] * v.scale), ly - (v.offsetY + ts.r[1] * v.scale))
      const corner = Math.min(...([[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom]] as const).map(([cx, cy]) => Math.hypot(fx - sx(cx), fy - sy(cy))))
      if (Math.min(dl, dr) <= HANDLE_HIT && Math.min(dl, dr) < corner) side = dl <= dr ? 0 : 1
    }
    if (hit === null && side < 0) return false
    const [dx, dy] = toPage(v, lx, ly)
    const at: [number, number] = [dx - sel.slot.x, dy - sel.slot.y]
    if (side >= 0) hit = 'width'
    // Shift or Alt on the inside is the lasso's toggle / rectangle. On a handle it starts the drag; a click without a drag is the lasso's (see onUp).
    if ((e.shiftKey || e.altKey) && hit === 'move') return false
    // A press inside the box on an element that is not selected picks that element (lasso/tap path), it does not move.
    if (hit === 'move') {
      const id = selectTap(sel.slot.page.elements as El[], at)
      if (id !== null && !sel.els.some((x) => x.id === id)) return false
    }
    this.mode = 'xform'
    const width = side >= 0
    this.xform = {
      id: e.pointerId,
      kind: width ? 'width' : hit === 'move' || hit === 'rotate' ? (hit as 'move' | 'rotate') : 'scale',
      corner: width ? side : typeof hit === 'number' ? hit : -1,
      slot: sel.slot,
      ids: sel.els.map((x) => x.id as string),
      b,
      angle,
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

  /** A screen point `(x, y)` turned back by `angle` degrees about `(cx, cy)`: where it lies in the selection frame. */
  private intoFrame(x: number, y: number, cx: number, cy: number, angle: number): [number, number] {
    if (!angle) return [x, y]
    const a = (-angle * Math.PI) / 180
    const dx = x - cx, dy = y - cy
    return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)]
  }

  /** The op the drag would make, or null when it changes nothing. */
  private xformOp(x: Xform): Op | null {
    const base = { pageId: x.slot.page.id, ids: x.ids }
    const { b } = x
    const dx = x.cur[0] - x.start[0]
    const dy = x.cur[1] - x.start[1]
    if (x.kind === 'width') {
      const w = this.widthDrag(x)
      return w === null ? null : { op: 'setTextBoxWidth', pageId: base.pageId, id: x.ids[0], width: w }
    }
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
    if (x.angle) return this.turnedScale(x, base, right, bottom)
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

  /** A corner drag on a turned selection: the box keeps its shape (both axes scale alike) and the opposite corner stays. */
  private turnedScale(x: Xform, base: { pageId: string; ids: string[] }, right: boolean, bottom: boolean): Op | null {
    const { b } = x
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2
    const local = (p: readonly [number, number]) => this.intoFrame(p[0], p[1], cx, cy, x.angle)
    const [ax, ay] = [right ? b.left : b.right, bottom ? b.top : b.bottom]
    const vx = (right ? b.right : b.left) - ax
    const vy = (bottom ? b.bottom : b.top) - ay
    const [sx0, sy0] = local(x.start)
    const [cx1, cy1] = local(x.cur)
    const nx = vx + cx1 - sx0
    const ny = vy + cy1 - sy0
    const d = vx * vx + vy * vy
    if (d === 0) return null
    const k = Math.max(MIN_SCALE, (nx * vx + ny * vy) / d)
    if (!Number.isFinite(k) || Math.abs(k - 1) < 1e-3) return null
    const a = (x.angle * Math.PI) / 180
    const ox = ax - cx, oy = ay - cy
    const anchor: [number, number] = [cx + ox * Math.cos(a) - oy * Math.sin(a), cy + ox * Math.sin(a) + oy * Math.cos(a)]
    return { op: 'scale', ...base, sx: k, sy: k, anchor }
  }

  /** The selection box as the drag stands: bounds in page coordinates and its turn in degrees. */
  private preview(x: Xform): { b: Bounds; angle: number } {
    const op = this.xformOp(x)
    const { b, angle } = x
    if (!op) return { b, angle }
    if (op.op === 'setTextBoxWidth') {
      const el = x.slot.page.elements.find((e) => (e as El).id === x.ids[0]) as El | undefined
      return { b: (el && selectionBounds([{ ...el, width: op.width }])) || b, angle }
    }
    if (op.op === 'move') {
      const dx = op.dx as number
      const dy = op.dy as number
      return { b: { left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy }, angle }
    }
    const [cx, cy] = [(b.left + b.right) / 2, (b.top + b.bottom) / 2]
    if (op.op === 'rotate') {
      // The op turns the elements about the center of their plain bounds.
      const sel = x.slot.page.elements.filter((e) => x.ids.includes((e as El).id as string)) as El[]
      const pb = selectionBounds(sel)
      const [px, py] = pb ? [(pb.left + pb.right) / 2, (pb.top + pb.bottom) / 2] : [cx, cy]
      const t = ((op.angle as number) * Math.PI) / 180
      const nx = px + (cx - px) * Math.cos(t) - (cy - py) * Math.sin(t)
      const ny = py + (cx - px) * Math.sin(t) + (cy - py) * Math.cos(t)
      const hw = (b.right - b.left) / 2, hh = (b.bottom - b.top) / 2
      return { b: { left: nx - hw, right: nx + hw, top: ny - hh, bottom: ny + hh }, angle: angle + (op.angle as number) }
    }
    const [ax, ay] = op.anchor as [number, number]
    const sx = op.sx as number
    const sy = op.sy as number
    if (angle) {
      const nx = ax + (cx - ax) * sx
      const ny = ay + (cy - ay) * sy
      const hw = ((b.right - b.left) / 2) * sx, hh = ((b.bottom - b.top) / 2) * sy
      return { b: { left: nx - hw, right: nx + hw, top: ny - hh, bottom: ny + hh }, angle }
    }
    return { b: { left: ax + (b.left - ax) * sx, right: ax + (b.right - ax) * sx, top: ay + (b.top - ay) * sy, bottom: ay + (b.bottom - ay) * sy }, angle: 0 }
  }

  /** A single selected text box that can be edited: the points of its two side handles (document coordinates). */
  private textSel(): { el: El; l: [number, number]; r: [number, number] } | null {
    if (this.tool !== 'lasso') return null
    const sel = this.selected()
    if (!sel || sel.els.length !== 1 || !this.canEdit(sel.slot.page.id)) return null
    const el = sel.els[0]!
    if (!isTextBox(el)) return null
    const w = Math.max(WIDTH_MIN, el.width as number)
    const a = (((el.rotation as number | undefined) ?? 0) * Math.PI) / 180
    const cx = (el.x as number) + w / 2 + sel.slot.x
    const cy = (el.y as number) + textHeight(el) / 2 + sel.slot.y
    const ux = (Math.cos(a) * w) / 2, uy = (Math.sin(a) * w) / 2
    return { el, l: [cx - ux, cy - uy], r: [cx + ux, cy + uy] }
  }

  /** The width a side-handle drag would give, or null for no change. */
  private widthDrag(x: Xform): number | null {
    const el = x.slot.page.elements.find((e) => (e as El).id === x.ids[0]) as El | undefined
    if (!el || !isTextBox(el)) return null
    const w = Math.max(WIDTH_MIN, el.width as number)
    const a = (((el.rotation as number | undefined) ?? 0) * Math.PI) / 180
    const along = (x.cur[0] - x.start[0]) * Math.cos(a) + (x.cur[1] - x.start[1]) * Math.sin(a)
    const nw = Math.max(WIDTH_MIN, w + (x.corner === 1 ? along : -along))
    return Number.isFinite(nw) && Math.abs(nw - w) >= 0.01 ? nw : null
  }

  /** Applies one edit: it is one undo step and joins the save queue. Returns the error code or null. */
  private applyEdit(op: Op, extra: { ids?: string[] } = {}): string | null {
    this.clearNudge() // nudge() reads its run before calling this and sets a new one after
    this.lastDot = null
    const err = this.history.doOp(op, { ...this.ctx(), ...extra })
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
    if (op && op.op === 'rotate') this.selTurn += op.angle as number
    if (op) this.applyEdit(op)
    else this.redraw()
  }

  /** The selection when it can be edited now (not mid-drag), with its bounds in page coordinates. */
  private editable() {
    const sel = this.selected()
    const b = sel && selectionBounds(sel.els)
    return sel && b && !this.busy() && this.canEdit(sel.slot.page.id) ? { sel, b } : null
  }

  /** [복사] / Ctrl+C: the selected elements (page order) into the tab's clipboard. Works read-only; the note and the selection stay. */
  copySelection(): boolean {
    const sel = this.selected()
    if (!sel || this.leaving) return false
    elementClipboard.set(sel.els)
    return true
  }

  /** [잘라내기] / Ctrl+X: copy, then delete (undo brings the elements back, the clipboard stays). */
  cutSelection(): boolean {
    const sel = this.editable()?.sel
    if (!sel) return false
    const els = structuredClone(sel.els)
    // The clipboard is replaced only once the delete went through.
    if (!this.deleteSelection()) return false
    elementClipboard.set(els)
    return true
  }

  /** [삭제] / Delete. */
  deleteSelection(): boolean {
    const e = this.editable()
    return !!e && !this.applyEdit({ op: 'delete', pageId: e.sel.slot.page.id, ids: e.sel.els.map((x) => x.id) })
  }

  /** [색]: every stroke of the selection (one op). */
  setSelectionColor(color: string): boolean {
    const e = this.editable()
    return !!e && !this.applyEdit({ op: 'setStrokeColor', pageId: e.sel.slot.page.id, ids: e.sel.els.map((x) => x.id), color })
  }

  /** [두께]: every stroke of the selection (one op). */
  setSelectionWidth(width: number): boolean {
    const e = this.editable()
    return !!e && !this.applyEdit({ op: 'setStrokeWidth', pageId: e.sel.slot.page.id, ids: e.sel.els.map((x) => x.id), width })
  }

  /**
   * Ctrl+V: the clipboard goes centered on the pointer when it is over a page, else on the middle of the view; the new
   * elements become the selection. False: empty clipboard or the page cannot be edited.
   */
  pasteClipboard(): boolean {
    const elements = elementClipboard.get()
    if (elements.length === 0) return false
    const target = this.pasteTarget()
    if (!target) return false
    const { slot, at } = target
    const ids = elements.map(() => newId())
    const err = this.applyEdit({ op: 'paste', pageId: slot.page.id, elements, target: { pageId: slot.page.id, center: at } }, { ids })
    if (err) return false
    this.setSelection(slot.page.id, ids)
    return true
  }

  /** Plain text from the system clipboard (a paste event): a new text box, half the page wide, centered like pasted elements. */
  pasteText(text: string): boolean {
    const t = normalizeNewlines(text)
    if (isBlankText(t)) return false
    const target = this.pasteTarget()
    if (!target) return false
    const { slot, at } = target
    const width = slot.page.width / 2
    const h = layoutText({ type: 'text', width, text: t, runs: [], size: SIZE_DEFAULT }).height
    const id = newId()
    const err = this.applyEdit({ op: 'createTextBox', pageId: slot.page.id, x: at[0] - width / 2, y: at[1] - h / 2, width, text: t, runs: [] }, { ids: [id] })
    if (err) return false
    this.setSelection(slot.page.id, [id])
    return true
  }

  /**
   * An image file from the file picker, a drop or a paste (Story 4.13): converted when needed, stored, then one `insertImage`
   * (one undo step) centered on `clientAt` when that is over a page (a drop), else on the pointer or the middle of the view.
   * Not an image: nothing happens. Resolves to whether an image went in.
   */
  async insertImage(file: Blob, clientAt?: { x: number; y: number } | 'center'): Promise<boolean> {
    const host = this.images
    if (!host || this.readOnly || this.leaving) return false
    const p = await host.prepare(file)
    if (this.readOnly || this.leaving) return false // changed while the file was read
    if ('error' in p) {
      const m = { tooLarge: 'imageTooLarge', convertFailed: 'imageConvertFailed', unsupported: 'imageUnsupported', unreadable: 'imageUnreadable', storeFailed: 'imageStoreFailed' } as const
      if (p.error !== 'ignored') this.message(m[p.error])
      return false
    }
    // Only after the bytes are stored; the page is chosen now, not when the file was picked.
    const target = this.pasteTarget(clientAt)
    if (!target) return false
    const { slot, at } = target
    const size = imageInitialSize(p.pxWidth, p.pxHeight, slot.page.width, slot.page.height)
    const id = newId()
    const err = this.applyEdit(
      { op: 'insertImage', pageId: slot.page.id, asset: p.hash, ext: p.ext, pxWidth: p.pxWidth, pxHeight: p.pxHeight, width: size.width, height: size.height, x: at[0] - size.width / 2, y: at[1] - size.height / 2 },
      { ids: [id] },
    )
    if (err) return false
    this.setSelection(slot.page.id, [id])
    if (p.converted) this.message('imageConverted')
    return true
  }

  /** Where Ctrl+V puts things: `clientAt` or the pointer when it is over a page, else the middle of the view. Null when nothing can be pasted there. */
  private pasteTarget(clientAt?: { x: number; y: number } | 'center'): { slot: Slot; at: [number, number] } | null {
    if (this.busy() || !this.canvas) return null
    let at: [number, number] | null = null
    let slot: Slot | undefined
    const from = clientAt === 'center' ? null : (clientAt ?? this.pointer)
    if (from) {
      const [lx, ly] = this.local(from.x, from.y)
      const [dx, dy] = toPage(this.viewport, lx, ly)
      slot = this.hit(dx, dy)
      if (slot) at = [dx - slot.x, dy - slot.y]
    }
    if (!slot || !at) {
      const [dx, dy] = toPage(this.viewport, this.cssW / 2, this.cssH / 2)
      slot = this.hit(dx, dy) ?? this.current
      if (!slot) return null
      at = [dx - slot.x, dy - slot.y]
      // Over a gap between pages: the current page's middle.
      if (!this.hit(dx, dy)) at = [slot.page.width / 2, slot.page.height / 2]
    }
    if (!this.canEdit(slot.page.id) || at.some((v) => !Number.isFinite(v))) return null
    return { slot, at }
  }

  // ---- text boxes (Story 4.10) ----

  get editing(): boolean {
    return this.edit !== null
  }

  /** The stored box under the edit, or undefined once it is gone (undo, a merge). */
  private stored(ed: Edit): El | undefined {
    return (this.history.note.pages.find((p) => p.id === ed.pageId)?.elements as El[] | undefined)?.find((e) => e?.id === ed.id)
  }

  private draftEl(ed: Edit): El {
    return { ...ed.el, text: ed.text, runs: ed.runs }
  }

  private startEdit(slot: Slot, el: El, isNew: boolean): void {
    this.clearSelection()
    const text = isNew ? '' : (el.text as string)
    const runs = isNew ? [] : (normalizeRuns(Array.isArray(el.runs) ? el.runs : [], cpLen(text)))
    const { text: _t, runs: _r, ...rest } = el
    const end = cpLen(text)
    this.edit = { pageId: slot.page.id, id: el.id as string, isNew, el: rest, text, runs, before: isNew ? null : { text, runs }, sel: [end, end], pending: null }
    this.lastEdit = ''
    this.redraw()
  }

  /** A new empty box with its top-left at (x, y) of the page, half the page wide, in edit. */
  private startNew(slot: Slot, x: number, y: number): void {
    const width = slot.page.width / 2
    const el: El = { id: newId(), type: 'text', x, y, width, rotation: 0, size: SIZE_DEFAULT, color: COLOR_DEFAULT, bold: false, italic: false }
    this.startEdit(slot, el, true)
  }

  /** Text tool + Enter: a new box in the page at the middle of the view. */
  createTextAtCenter(): boolean {
    if (this.edit || this.busy() || !this.canvas || this.readOnly || this.leaving) return false
    const [dx, dy] = toPage(this.viewport, this.cssW / 2, this.cssH / 2)
    const slot = this.hit(dx, dy) ?? this.current
    if (!slot) return false
    if (!this.canEdit(slot.page.id)) return !this.onBlockedIfLocked(slot.page.id)
    const inside = this.hit(dx, dy) !== undefined
    const w = slot.page.width / 2
    const x = Math.min(Math.max(0, (inside ? dx - slot.x : slot.page.width / 2) - w / 2), Math.max(0, slot.page.width - w))
    const y = Math.max(0, inside ? dy - slot.y : slot.page.height / 2)
    this.startNew(slot, x, y)
    return true
  }

  private onBlockedIfLocked(pageId: string): boolean {
    if (!this.readOnly && this.history.isLocked(pageId)) {
      this.onBlocked()
      return true
    }
    return false
  }

  /** Text tool: a press on a text box edits it; on any other spot of a page it starts a box there. */
  private textDown(e: PointerEvent): void {
    e.preventDefault()
    if (this.readOnly) return
    const s = this.under(e)
    if (!s) return
    if (this.onBlockedIfLocked(s.page.id)) return
    const p = this.point(e, e.timeStamp, undefined, s)!
    // On an existing text box: edit it. Anywhere else (strokes and images do not block): a new box.
    const boxes = (s.page.elements as El[]).filter(isTextBox)
    const hit = boxes.find((b) => b.id === selectTap(boxes, [p[0]!, p[1]!]))
    if (hit) return this.startEdit(s, hit, false)
    this.startNew(s, p[0]!, p[1]!)
  }

  /**
   * A second press right after the first, on a text box, in any tool: edit it. Takes the dot the pen drew on the
   * first press back. True: the press is used up.
   */
  private doubleDown(e: PointerEvent): boolean {
    const prev = this.lastTap
    const dot = this.lastDot // only the dot of the press right before this one counts
    this.lastDot = null
    this.lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY }
    if (this.tool === 'eraser') return false
    if (e.pointerType === 'pen' && this.tool === 'pen') return false // stylus taps are ink
    if (this.tool === 'lasso' && this.onHandle(e)) return false
    if (!prev || e.button !== 0 || e.timeStamp - prev.t > DOUBLE_MS || Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > DOUBLE_SLOP) return false
    const s = this.under(e)
    if (!s || this.readOnly || !this.canEdit(s.page.id)) return false
    const p = this.point(e, e.timeStamp, undefined, s)!
    const boxes = (s.page.elements as El[]).filter(isTextBox)
    const id = selectTap(boxes, [p[0]!, p[1]!])
    const el = boxes.find((b) => b.id === id)
    if (!el) return false
    this.lastTap = null
    if (dot === this.history.undoDepth) this.replay('undo')
    e.preventDefault()
    this.startEdit(s, el, false)
    return true
  }

  /** The press lands on a handle of the selection (a corner, the rotate handle or a text box side). */
  private onHandle(e: PointerEvent): boolean {
    const sel = this.selected()
    const fr = sel && this.frameOf(sel.els)
    if (!sel || !fr) return false
    const { b } = fr
    const v = this.viewport
    const [lx, ly] = this.local(e.clientX, e.clientY)
    const sx = (x: number) => v.offsetX + (x + sel.slot.x) * v.scale
    const sy = (y: number) => v.offsetY + (y + sel.slot.y) * v.scale
    const [fx, fy] = this.intoFrame(lx, ly, (sx(b.left) + sx(b.right)) / 2, (sy(b.top) + sy(b.bottom)) / 2, fr.angle)
    const hit = hitSelection(sx(b.left), sy(b.top), sx(b.right), sy(b.bottom), fx, fy)
    if (hit === 'rotate' || typeof hit === 'number') return true
    const ts = this.textSel()
    return !!ts && [ts.l, ts.r].some(([x, y]) => Math.hypot(lx - (v.offsetX + x * v.scale), ly - (v.offsetY + y * v.scale)) <= HANDLE_HIT)
  }

  /** The overlay's view of the edit: the box in CSS px on the canvas. Null when not editing. */
  editInfo(): EditInfo | null {
    const ed = this.edit
    if (!ed) return null
    const slot = this.slots().list.find((s) => s.page.id === ed.pageId)
    if (!slot || (!ed.isNew && !this.stored(ed))) {
      this.edit = null // the page or the box went away under the edit
      return null
    }
    const v = this.viewport
    const el = this.draftEl(ed)
    const w = Math.max(WIDTH_MIN, ed.el.width as number)
    return {
      id: ed.id,
      left: v.offsetX + (slot.x + (ed.el.x as number)) * v.scale,
      top: v.offsetY + (slot.y + (ed.el.y as number)) * v.scale,
      width: w * v.scale,
      height: textHeight(el) * v.scale,
      scale: v.scale,
      rotation: (ed.el.rotation as number | undefined) ?? 0,
      text: ed.text,
      size: (ed.el.size as number | undefined) ?? SIZE_DEFAULT,
      w: this.cssW,
      h: this.cssH,
      format: formatAt(ed.el, ed.text, ed.runs, ed.sel, ed.pending && ed.pending.at === ed.sel[0] && ed.sel[0] === ed.sel[1] ? ed.pending.props : null),
    }
  }

  private emitEdit(): void {
    const info = this.editInfo()
    const key = JSON.stringify(info)
    if (key === this.lastEdit) return
    this.lastEdit = key
    this.onEdit(info)
  }

  /** The overlay's text changed (also during an IME composition): the runs follow, `sel` is the caret / selection in UTF-16 units. */
  editInput(value: string, selStart: number, selEnd: number): void {
    const ed = this.edit
    if (!ed) return
    const text = normalizeNewlines(value)
    ed.runs = retextRuns(ed.text, text, ed.runs, ed.pending?.props ?? {}, cpIndex(text, selEnd))
    ed.text = text
    ed.pending = null
    ed.sel = [cpIndex(text, selStart), cpIndex(text, selEnd)]
    this.redraw()
  }

  /** The caret or selection moved (UTF-16 units). A caret that moved drops the format waiting for the next input. */
  editSelect(selStart: number, selEnd: number): void {
    const ed = this.edit
    if (!ed) return
    const sel: [number, number] = [cpIndex(ed.text, selStart), cpIndex(ed.text, selEnd)]
    if (sel[0] === ed.sel[0] && sel[1] === ed.sel[1]) return
    ed.sel = sel
    if (ed.pending && (sel[0] !== sel[1] || sel[0] !== ed.pending.at)) ed.pending = null
    this.redraw()
  }

  /** Bar / Ctrl+B / Ctrl+I: the property on the selected text, or on the next input when there is no selection. */
  editFormat(props: Record<string, unknown>): void {
    const ed = this.edit
    if (!ed) return
    const [a, b] = ed.sel[0] <= ed.sel[1] ? ed.sel : [ed.sel[1], ed.sel[0]]
    if (a === b) ed.pending = { at: a, props: { ...ed.pending?.props, ...props } }
    else ed.runs = formatRange(ed.runs, cpLen(ed.text), a, b, props)
    this.redraw()
  }

  /** A side handle of the box in edit: `dx` page points along the box; the left handle only narrows or widens. */
  editWidth(dx: number, right: boolean): void {
    const ed = this.edit
    if (!ed || !Number.isFinite(dx)) return
    const slot = this.slots().list.find((s) => s.page.id === ed.pageId)
    if (!slot) return
    const w = Math.max(WIDTH_MIN, ed.el.width as number) + (right ? dx : -dx)
    ed.el = { ...ed.el, width: Math.round(Math.min(slot.page.width, Math.max(WIDTH_MIN, w)) * 100) / 100 }
    this.redraw()
  }

  /** Ends the edit: one `createTextBox` (new) or `editText` (changed), nothing for a blank new box or no change. */
  commitEdit(): void {
    const ed = this.edit
    if (!ed) return
    this.edit = null
    this.lastEdit = ''
    try {
      if (this.readOnly || this.leaving || this.history.isLocked(ed.pageId)) {
        this.onBlockedIfLocked(ed.pageId)
      } else if (ed.isNew) {
        if (!isBlankText(ed.text)) {
          this.applyEdit({ op: 'createTextBox', pageId: ed.pageId, x: ed.el.x, y: ed.el.y, width: ed.el.width, text: ed.text, runs: ed.runs }, { ids: [ed.id] })
        }
      } else {
        if (ed.before && (ed.text !== ed.before.text || JSON.stringify(ed.runs) !== JSON.stringify(ed.before.runs))) {
          this.applyEdit({ op: 'editText', pageId: ed.pageId, id: ed.id, text: ed.text, runs: ed.runs })
        }
        // A new width on a stored box is its own op (and undo step).
        const stored = this.stored(ed)
        if (stored && typeof stored.width === 'number' && Math.abs((ed.el.width as number) - stored.width) > 0.01) {
          this.applyEdit({ op: 'setTextBoxWidth', pageId: ed.pageId, id: ed.id, width: ed.el.width })
        }
      }
    } finally {
      this.redraw()
      this.onEdit(null)
    }
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
    if (!e) return false
    const err = this.applyEdit({ op: 'rotate', pageId: e.sel.slot.page.id, ids: e.sel.els.map((x) => x.id), angle })
    if (!err) this.selTurn += angle
    return !err
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
      this.setSelection(slot.page.id, id ? [id] : [])
      // A placeholder that failed to download tries again when it is tapped.
      const hit = id ? els.find((e) => e?.id === id) : undefined
      if (hit?.type === 'image' && typeof hit.asset === 'string' && this.images?.state(hit.asset) === 'failed') this.images.retry(hit.asset)
      return
    }
    const end = l.path[l.path.length - 1]!
    const ids = l.alt ? selectRect(els, [...loc(at), ...loc(end)]) : selectLasso(els, l.path.map(loc))
    this.setSelection(slot.page.id, ids)
  }

  private build(points: number[][], id: string): Stroke {
    const pen = this.pen()
    return { id, type: 'stroke', tool: pen.tool, color: pen.color, width: pen.width, usePressure: pen.usePressure, points }
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
    if (this.readOnly || this.tool !== 'pen') return
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

  private notePen(e: PointerEvent): void {
    if (e.pointerType !== 'pen' || this.penSeen) return
    this.penSeen = true
    this.onPenSeen()
  }

  private onDown(e: PointerEvent): void {
    this.notePen(e)
    this.pointer = { x: e.clientX, y: e.clientY }
    if (this.leaving || !this.page) return
    if (!POINTER_TYPES.includes(e.pointerType)) return
    this.snap() // a running zoom ends at its target before new input
    this.layout() // the canvas may have moved or resized; the view stays unless its size changed
    // A press on the canvas outside the box confirms it; with the text tool that press is used up.
    if (this.edit) {
      this.commitEdit()
      if (this.tool === 'text') return void e.preventDefault()
    }
    // Decided once, at the press: the pen's barrel button (2) or eraser end (32) erases whatever the tool.
    const side = e.pointerType === 'pen' && ((e.buttons & (2 | 32)) !== 0 || e.button === 2 || e.button === 5)
    if (e.pointerType !== 'touch') this.ring = true
    if (this.mode === 'none' && !side && this.doubleDown(e)) return
    if (e.pointerType === 'touch') return this.touchDown(e)
    const middle = e.pointerType === 'mouse' && e.button === 1
    if (side && this.readOnly) return
    if (e.button !== 0 && !middle && !side) return
    if (this.ownedBy(e.pointerId)) this.onCancel(e) // its release was lost
    if (this.mode === 'pen' || this.mode === 'pan' || this.mode === 'lasso' || this.mode === 'xform' || this.mode === 'erase') return
    // A pen or mouse takes over: the touch stroke or gesture is dropped. Fingers
    // still down stay in `touches`, so they never turn into ink.
    this.discardStroke()
    this.gesture = null
    this.capture(e)
    if (side && this.hand) return // the hand tool: a barrel press is neither a pan nor ink
    if ((this.tool === 'eraser' || side) && !middle && !this.hand && !this.readOnly) return this.eraseDown(e, side && this.tool !== 'eraser')
    // The lasso selects on every page, read-only or conflicted too; before the pan branches so it never leaks into a pan.
    if (this.tool === 'lasso' && !middle && !this.hand) return this.lassoDown(e)
    if (this.tool === 'text' && !middle && !this.hand && !this.readOnly && !this.onLockedPage(e)) return this.textDown(e)
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

  private eraseDown(e: PointerEvent, temporary: boolean): void {
    const s = this.under(e)
    const locked = !!s && this.history.isLocked(s.page.id)
    if (locked) this.onBlocked()
    e.preventDefault()
    try {
      this.canvas?.focus({ preventScroll: true })
    } catch {
      // focus is a convenience
    }
    this.mode = 'erase'
    this.erase = { id: e.pointerId, type: e.pointerType, temporary, pageId: s && !locked ? s.page.id : null, ox: s?.x ?? 0, oy: s?.y ?? 0, path: [], scan: null, scanned: 0, preview: null, src: null }
    this.erasePush([e])
  }

  /** Adds the events' points to the eraser path (skipping a repeat of the last one) and refreshes the preview. */
  private erasePush(evs: readonly PointerEvent[]): void {
    const d = this.erase
    if (!d) return
    const page = d.pageId ? this.history.note.pages.find((p) => p.id === d.pageId) : undefined
    if (page) {
      for (const ev of evs) {
        const p = this.point(ev, ev.timeStamp, undefined, { x: d.ox, y: d.oy })
        const last = d.path[d.path.length - 1]
        if (p && !(last && last[0] === p[0] && last[1] === p[1])) d.path.push([p[0]!, p[1]!])
      }
      // Incremental: only the new path points are tested (EraseScan); a changed page restarts the scan.
      if (d.src !== page || !d.scan) {
        d.src = page
        d.scan = this.scanOf(page, d.path)
      } else for (let i = d.scanned; i < d.path.length; i++) d.scan.push(d.path[i]!)
      d.scanned = d.path.length
      d.preview = d.scan?.targets() ?? null
    }
    this.eraseFrame ||= requestAnimationFrame(() => {
      this.eraseFrame = 0
      this.redraw()
    })
  }

  private scanOf(page: Page, path: number[][]): EraseScan | null {
    if (path.length === 0) return null
    const sc = new EraseScan(page, ERASER_WIDTH, this.eraserMode === 'partial')
    for (const p of path) sc.push(p)
    return sc
  }

  /** Ends the eraser gesture: one operation for the whole path, one history step. */
  private finishErase(): void {
    const d = this.erase
    this.erase = null
    if (this.eraseFrame) cancelAnimationFrame(this.eraseFrame)
    this.eraseFrame = 0
    if (!d) return
    const page = d.pageId ? this.history.note.pages.find((p) => p.id === d.pageId) : undefined
    let touched = false
    if (page && d.path.length > 0 && !this.readOnly) {
      const partial = this.eraserMode === 'partial'
      const hits = erasePieces(page, d.path, ERASER_WIDTH)
      const count = partial ? hits.reduce((n, h) => n + h.pieces.length, 0) : 0
      const err = this.history.doOp(
        { op: partial ? 'erasePartial' : 'eraseStrokes', pageId: page.id, path: d.path, width: ERASER_WIDTH },
        { ...this.ctx(), ids: Array.from({ length: count }, newId) },
      )
      if (err) this.message('strokeNotAdded')
      else if (hits.length > 0) {
        touched = true
        this.queue.commit(this.history.note)
        this.onChange()
      }
    }
    this.redraw()
    this.onErased({ pointerType: d.type, touched, temporary: d.temporary })
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
      if (this.tool === 'text' && !this.readOnly && !this.onLockedPage(e)) this.textDown(e)
      if (!this.penOnly) this.begin(e)
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
    this.forced = null
    const [fx, fy] = this.local((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)
    const s = snapScale((g.s0 * Math.hypot(pa.x - pb.x, pa.y - pb.y)) / g.d0, this.fitFor('width').scale)
    this.changeView(this.clamp({ scale: s, offsetX: fx - g.p0[0] * s, offsetY: fy - g.p0[1] * s }))
  }

  private ownedBy(id: number): boolean {
    return (this.mode === 'pen' && this.penId === id) || (this.mode === 'pan' && this.pan?.id === id) || (this.mode === 'lasso' && this.lasso?.id === id) || (this.mode === 'xform' && this.xform?.id === id) || (this.mode === 'erase' && this.erase?.id === id)
  }

  private onMove(e: PointerEvent): void {
    this.notePen(e)
    this.pointer = { x: e.clientX, y: e.clientY }
    if (this.leaving) return
    if (e.pointerType !== 'touch') this.ring = true
    // The button came up where we could not see it: end the stroke or drag.
    if (e.buttons === 0 && e.pointerType !== 'touch' && this.ownedBy(e.pointerId)) return this.onCancel(e)
    const t = this.touches.get(e.pointerId)
    if (t) {
      const [px, py] = [t.x, t.y]
      t.x = e.clientX
      t.y = e.clientY
      // A pen is known: one finger drags the view.
      if (this.penOnly && this.mode === 'idle' && this.touches.size === 1 && e.pointerId === this.firstId) {
        this.movePan(px - e.clientX, py - e.clientY)
        return
      }
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
    if (this.mode === 'erase' && this.erase && e.pointerId === this.erase.id) {
      const co = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      return this.erasePush(co.length > 0 ? co : [e])
    }
    if (this.tool === 'eraser' && this.ring && !this.drawing && e.pointerType !== 'touch') return this.redraw() // the ring follows the pointer
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
    if (this.mode === 'erase' && this.erase?.id === e.pointerId) {
      this.erasePush([e]) // the release point counts too
      this.finishErase()
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
    if (this.mode === 'erase' && this.erase?.id === e.pointerId) {
      // A cancelled gesture is dropped: no operation, no onErased.
      this.erase = null
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
      this.lastDot = d.points.length <= 1 ? this.history.undoDepth : null
      this.queue.commit(this.history.note)
      this.onChange()
    }
    // After the op is in the history: whoever waited merges the note with this stroke in it.
    this.releaseStrokeWaiters(err ? null : d.pageId)
  }

  private ctx(pages = false) {
    const base = { rev: newId(), now: new Date().toISOString(), editedBy: this.editedBy(), lastSeenRemoteSeq: 0 }
    if (!pages) return base
    // Page operations (spec ops.md): enough ids for any of them (undoing a delete of k pages inserts k pages, more than the note holds now); undo and redo of a page operation use them too.
    const ids = () => Array.from({ length: Math.max(this.history.note.pages.length + 1, 512) }, newId)
    return { ...base, revs: ids(), pageIds: ids(), orderRev: newId() }
  }

  /**
   * Applies one page operation (Stories 6.5-6.9): one undo step, joins the save queue. Returns the error code or null.
   * A page with an unresolved conflict is never named by one.
   */
  pageEdit(op: Op): string | null {
    if (this.readOnly || this.leaving || this.busy()) return 'notApplied'
    this.commitEdit()
    this.clearNudge()
    this.lastDot = null
    const named = [...((op.pageIds as string[] | undefined) ?? []), ...((op.items as { pageId?: string; page?: { id: string } }[] | undefined) ?? []).map((i) => i.pageId ?? i.page?.id), op.pageId]
    if (named.some((id) => typeof id === 'string' && this.history.isLocked(id))) {
      this.onBlocked()
      return 'pageReadOnly'
    }
    const note = this.history.note
    const elementIds = op.op === 'duplicatePage' ? note.pages.filter((p) => (op.pageIds as string[]).includes(p.id)).flatMap((p) => p.elements.map(() => newId())) : undefined
    const key = this.docKey()
    const err = this.history.doOp(op, { ...this.ctx(true), ...(elementIds ? { elementIds } : {}) })
    if (err) {
      this.message('historyNotApplied')
      return err
    }
    try {
      this.docChanged(key)
    } catch {
      // the next layout repaints
    }
    this.queue.commit(this.history.note)
    this.onChange()
    return null
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
    this.commitEdit() // the box in edit is part of the history first
    this.selTurn = 0 // the frame of a turned group is forgotten
    this.lastDot = null
    const depth = kind === 'undo' ? this.history.undoDepth : this.history.redoDepth
    this.clearNudge()
    if ((this.pageLocked || this.history.topLocked(kind)) && !this.readOnly && !this.leaving) {
      this.onBlocked() // the record of a conflicted page is gone; nothing else is undone under it
      return false
    }
    if (this.readOnly || this.leaving || this.drawing || this.touches.size > 0 || this.mode !== 'none' || depth === 0) return false
    const key = this.docKey()
    const err = this.history[kind](this.ctx(true))
    if (err) {
      this.message('historyNotApplied')
      return false
    }
    // The history has advanced: the save must happen even if drawing throws.
    try {
      this.docChanged(key)
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
      this.commitEdit()
      this.finishStroke()
      this.finishErase()
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
