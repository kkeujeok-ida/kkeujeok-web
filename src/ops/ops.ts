// Edit operations (spec ops.md). Never mutate the input note.
import { type Note, type Page, type Stroke, SUPPORTED_FORMAT_VERSION, isValidStroke, roundStroke } from '../model/note'
import { normalizeTitle } from '../model/noteTitle'
import { round2 } from '../model/number'
import { IMAGE_SIZE_MIN, isAssetHash } from '../model/imageRules'
import { isTextBox, selectionBounds, type El } from '../model/select'
import { COLOR_DEFAULT, SIZE_DEFAULT, SIZE_MAX, SIZE_MIN, WIDTH_MIN, cpLen, isBlankText, normalizeNewlines, normalizeRuns, textHeight, validRuns } from '../model/textLayout'

export type Ctx = { rev: string; now: string; editedBy: string; lastSeenRemoteSeq: number; /** New element ids for `paste`, one per pasted element. */ ids?: string[] }
export type Op = { op: string; [k: string]: unknown }
/** `inverse` is null only when a selection op changed nothing (no bounding box): it is not recorded in the history. */
export type OpResult = { note: Note; inverse: Op | null } | { error: string }

export function createNote(a: {
  title: string
  existingTitles: string[]
  background: string
  orientation: string
  noteId: string
  pageId: string
  pageRev: string
  metaRev: string
  orderRev: string
  now: string
  editedBy: string
}): OpResult {
  const title = normalizeTitle(a.title, a.existingTitles)
  if (title === null) return { error: 'titleTooLong' }
  const landscape = a.orientation === 'landscape'
  return {
    note: {
      formatVersion: SUPPORTED_FORMAT_VERSION,
      noteId: a.noteId,
      meta: { title },
      metaRev: a.metaRev,
      metaSeq: 1,
      orderRev: a.orderRev,
      orderSeq: 1,
      pages: [
        {
          id: a.pageId,
          width: landscape ? 842 : 595,
          height: landscape ? 595 : 842,
          background: a.background,
          rev: a.pageRev,
          seq: 1,
          editedAt: a.now,
          editedBy: a.editedBy,
          elements: [],
        },
      ],
    },
    inverse: { op: 'deleteNote', noteId: a.noteId },
  }
}

export function applyOp(note: Note, op: Op, ctx: Ctx): OpResult {
  switch (op.op) {
    case 'addStroke':
      return addStroke(note, op, ctx)
    case 'removeStroke':
      return removeStroke(note, op, ctx)
    case 'move':
    case 'scale':
    case 'rotate':
      return transformOp(note, op, ctx)
    case 'replaceElements':
      return replaceElements(note, op, ctx)
    case 'setStrokeColor':
    case 'setStrokeWidth':
      return strokeOp(note, op, ctx)
    case 'delete':
      return deleteOp(note, op, ctx)
    case 'insertElements':
      return insertElements(note, op, ctx)
    case 'eraseStrokes':
    case 'erasePartial':
      return eraseOp(note, op, ctx)
    case 'paste':
      return paste(note, op, ctx)
    case 'createTextBox':
      return createTextBox(note, op, ctx)
    case 'insertImage':
      return insertImage(note, op, ctx)
    case 'editText':
    case 'setTextBoxWidth':
      return editText(note, op, ctx)
    default:
      return { error: 'unknownOp' }
  }
}

function touch(page: Page, ctx: Ctx) {
  page.rev = ctx.rev
  page.seq = Math.max(page.seq, ctx.lastSeenRemoteSeq) + 1
  page.editedAt = ctx.now
  page.editedBy = ctx.editedBy
}

const findPage = (n: Note, id: unknown) => n.pages.find((p) => p.id === id)
const elId = (e: unknown) => (e as { id?: unknown }).id
// A stored `height` of a text box is ignored and dropped on any write.
const noHeight = <T extends El>(e: T): T => {
  if (isTextBox(e)) delete e.height
  return e
}

function addStroke(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  if (!isValidStroke(op.stroke)) return { error: 'invalidStroke' }
  const stroke = structuredClone(op.stroke) as Stroke
  roundStroke(stroke)
  if (page.elements.some((e) => elId(e) === stroke.id)) return { error: 'duplicateId' }
  let index = page.elements.length
  if ('index' in op) {
    const i = op.index
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > index) {
      return { error: 'indexOutOfRange' }
    }
    index = i
  }
  page.elements.splice(index, 0, stroke)
  touch(page, ctx)
  return { note: next, inverse: { op: 'removeStroke', pageId: op.pageId, strokeId: stroke.id } }
}

function removeStroke(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const index = page.elements.findIndex(
    (e) => elId(e) === op.strokeId && (e as { type?: unknown }).type === 'stroke',
  )
  if (index < 0) return { error: 'strokeNotFound' }
  const [removed] = page.elements.splice(index, 1)
  touch(page, ctx)
  return { note: next, inverse: { op: 'addStroke', pageId: op.pageId, stroke: removed, index } }
}

// Selection ops (spec ops.md, transform.md). Errors in spec order: pageNotFound, emptySelection, own parameter, elementNotFound.
function transformOp(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const ids = new Set(Array.isArray(op.ids) ? op.ids : [])
  if (ids.size === 0) return { error: 'emptySelection' }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  if (op.op === 'scale' && !(num(op.sx) > 0 && num(op.sy) > 0)) return { error: 'invalidScale' }
  const els = page.elements as El[]
  const have = new Set(els.map((e) => e?.id))
  if (![...ids].every((i) => have.has(i))) return { error: 'elementNotFound' }
  const chosen = els.filter((e) => ids.has(e?.id))
  const before = structuredClone(chosen).map(noHeight)
  const bounds = selectionBounds(chosen)
  if (!bounds) return { note, inverse: null }

  let f: (x: number, y: number) => [number, number]
  let sx = 1, sy = 1, turn = 0
  if (op.op === 'move') {
    const dx = num(op.dx), dy = num(op.dy)
    f = (x, y) => [x + dx, y + dy]
  } else if (op.op === 'scale') {
    sx = op.sx as number
    sy = op.sy as number
    const [ax, ay] = op.anchor as [number, number]
    f = (x, y) => [ax + (x - ax) * sx, ay + (y - ay) * sy]
  } else {
    turn = num(op.angle)
    const r = (turn * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
    const rx = (bounds.left + bounds.right) / 2, ry = (bounds.top + bounds.bottom) / 2
    f = (x, y) => [rx + (x - rx) * c - (y - ry) * s, ry + (x - rx) * s + (y - ry) * c]
  }
  for (const e of chosen) {
    if (e.type === 'stroke') {
      for (const p of (e.points as number[][] | undefined) ?? []) {
        const [x, y] = f(p[0]!, p[1]!)
        p[0] = round2(x)
        p[1] = round2(y)
      }
    } else {
      const text = isTextBox(e)
      const w = e.width as number, h = text ? textHeight(e) : (e.height as number)
      const [cx, cy] = f((e.x as number) + w / 2, (e.y as number) + h / 2)
      if (text) {
        delete e.height
        if (op.op === 'scale') {
          scaleText(e, sx, cx, cy)
        } else {
          e.x = round2(cx - w / 2)
          e.y = round2(cy - h / 2)
          e.width = round2(w)
          if (op.op === 'rotate') e.rotation = turned(e, turn)
        }
        continue
      }
      // spec/transform.md "Images": a side never goes under sizeMin (before rounding).
      const img = e.type === 'image'
      const nw = img ? Math.max(IMAGE_SIZE_MIN, w * sx) : w * sx
      const nh = img ? Math.max(IMAGE_SIZE_MIN, h * sy) : h * sy
      e.x = round2(cx - nw / 2)
      e.y = round2(cy - nh / 2)
      e.width = round2(nw)
      e.height = round2(nh)
      // round2 can reach 360 (359.999): stored as 0.
      if (op.op === 'rotate') e.rotation = turned(e, turn)
    }
  }
  touch(page, ctx)
  return { note: next, inverse: { op: 'replaceElements', pageId: op.pageId, elements: before } }
}

// round2 can reach 360 (359.999): stored as 0.
const turned = (e: El, turn: number) => round2((((((e.rotation as number | undefined) ?? 0) + turn) % 360) + 360) % 360) % 360

// spec/transform.md "Text boxes": scale. (cx, cy) is the mapped center; only sx scales the text.
function scaleText(e: El, sx: number, cx: number, cy: number) {
  const clampSize = (v: number) => round2(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)))
  const nw = Math.max(WIDTH_MIN, round2((e.width as number) * sx))
  e.width = nw
  e.size = clampSize(((e.size as number | undefined) ?? SIZE_DEFAULT) * sx)
  if (Array.isArray(e.runs)) {
    for (const r of e.runs as El[]) if (r.size !== undefined && r.size !== null) r.size = clampSize((r.size as number) * sx)
    e.runs = normalizeRuns(e.runs, cpLen(e.text as string))
  }
  e.x = round2(cx - nw / 2)
  e.y = round2(cy - textHeight(e) / 2)
}

// Inverse-only: each given element replaces the page element with its id, in place.
function replaceElements(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const given = structuredClone((op.elements as El[]) ?? [])
  const at = given.map((g) => page.elements.findIndex((e) => elId(e) === g.id))
  if (at.some((i) => i < 0)) return { error: 'elementNotFound' }
  const before = at.map((i) => page.elements[i])
  at.forEach((i, k) => (page.elements[i] = given[k]))
  touch(page, ctx)
  return { note: next, inverse: { op: 'replaceElements', pageId: op.pageId, elements: before } }
}

// Shared front of the selection ops: page, ids, own parameter check, elementNotFound (spec order).
function select(next: Note, op: Op, own: () => string | null): { page: Page; idx: number[] } | { error: string } {
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const ids = new Set(Array.isArray(op.ids) ? op.ids : [])
  if (ids.size === 0) return { error: 'emptySelection' }
  const bad = own()
  if (bad) return { error: bad }
  const have = new Set(page.elements.map(elId))
  if (![...ids].every((i) => have.has(i))) return { error: 'elementNotFound' }
  return { page, idx: page.elements.flatMap((e, i) => (ids.has(elId(e)) ? [i] : [])) }
}

// setStrokeColor / setStrokeWidth: strokes only.
function strokeOp(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const color = op.op === 'setStrokeColor'
  let width = 0
  const r = select(next, op, () => {
    if (color) return typeof op.color === 'string' && /^#[0-9a-f]{6}$/.test(op.color) ? null : 'invalidColor'
    const w = op.width
    if (typeof w !== 'number' || !Number.isFinite(w) || Math.abs(w) > 100) return 'invalidWidth'
    width = Math.sign(w) * Math.round(Math.abs(w) * 10) / 10 // half away from zero
    return width >= 0.5 && width <= 30 ? null : 'invalidWidth'
  })
  if ('error' in r) return r
  const strokes = r.idx.filter((i) => (r.page.elements[i] as El).type === 'stroke')
  if (strokes.length === 0) return { note, inverse: null }
  const before = strokes.map((i) => structuredClone(r.page.elements[i]))
  for (const i of strokes) {
    const el = r.page.elements[i] as El
    // Each stroke is clamped to its own tool's range (spec/ops.md).
    if (color) el.color = op.color
    else el.width = el.tool === 'highlighter' ? Math.min(30, Math.max(4, width)) : Math.min(10, Math.max(0.5, width))
  }
  touch(r.page, ctx)
  return { note: next, inverse: { op: 'replaceElements', pageId: op.pageId, elements: before } }
}

function deleteOp(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const r = select(next, op, () => null)
  if ('error' in r) return r
  const items = r.idx.map((index) => ({ index, element: noHeight(r.page.elements[index] as El) }))
  for (const i of [...r.idx].reverse()) r.page.elements.splice(i, 1)
  touch(r.page, ctx)
  return { note: next, inverse: { op: 'insertElements', pageId: op.pageId, items } }
}

// Inverse-only: puts elements back at their indices, in the given order.
// With `removeIds` those elements go first (elementNotFound before duplicateId); the inverse then removes the inserted ids again.
function insertElements(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const items = structuredClone((op.items as { index: unknown; element: El }[]) ?? [])
  const withRemoval = Array.isArray(op.removeIds)
  const removed: { index: number; element: El }[] = []
  if (withRemoval) {
    const ids = new Set(op.removeIds as unknown[])
    const have = new Set(page.elements.map(elId))
    if (![...ids].every((i) => have.has(i))) return { error: 'elementNotFound' }
    page.elements.forEach((e, index) => ids.has(elId(e)) && removed.push({ index, element: e as El }))
    page.elements = page.elements.filter((e) => !ids.has(elId(e)))
  }
  const seen = new Set(page.elements.map(elId))
  for (const it of items) if (seen.size === seen.add(it.element.id).size) return { error: 'duplicateId' }
  for (const it of items) {
    const i = it.index
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > page.elements.length) return { error: 'indexOutOfRange' }
    page.elements.splice(i, 0, it.element)
  }
  touch(page, ctx)
  const ids = items.map((it) => it.element.id)
  return {
    note: next,
    inverse: withRemoval ? { op: 'insertElements', pageId: op.pageId, removeIds: ids, items: removed } : { op: 'delete', pageId: op.pageId, ids },
  }
}

// ---- eraser (spec/erase.md) ----
export const ERASER_MIN = 2
export const ERASER_MAX = 40
type Pt = readonly number[]
const EPS = 1e-9

function segDist(a: Pt, b: Pt, p: Pt): number {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / l2)) : 0
  return Math.hypot(p[0]! - (a[0]! + t * dx), p[1]! - (a[1]! + t * dy))
}
const cross = (o: Pt, a: Pt, b: Pt) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!)
function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(segDist(a, b, c), segDist(a, b, d), segDist(c, d, a), segDist(c, d, b))
}

/**
 * What an eraser path does to a page: the touched strokes (page index) and, for each, its pieces (point lists, in point order).
 * Pure; the width is already validated. `eraseOp` and the live preview both use it, so they cannot differ.
 */
export function erasePieces(page: Page, path: readonly Pt[], width: number): { index: number; pieces: number[][][] }[] {
  const r = width / 2 + EPS
  const pathDist = (p: Pt) => (path.length === 1 ? Math.hypot(p[0]! - path[0]![0]!, p[1]! - path[0]![1]!) : Math.min(...path.slice(1).map((q, i) => segDist(path[i]!, q, p))))
  const pathSeg = (a: Pt, b: Pt) => (path.length === 1 ? segDist(a, b, path[0]!) : Math.min(...path.slice(1).map((q, i) => segSegDist(a, b, path[i]!, q))))
  const out: { index: number; pieces: number[][][] }[] = []
  // A stroke whose box is farther than r from the path's box cannot be touched (keeps the live preview cheap).
  const xs = path.map((p) => p[0]!), ys = path.map((p) => p[1]!)
  const [x0, x1, y0, y1] = [Math.min(...xs) - r, Math.max(...xs) + r, Math.min(...ys) - r, Math.max(...ys) + r]
  page.elements.forEach((e, index) => {
    const el = e as El
    if (el.type !== 'stroke') return
    const pts = (el.points as number[][] | undefined) ?? []
    if (pts.length > 0 && !boxesCross(pts, x0, x1, y0, y1)) return
    const erased = pts.map((p) => pathDist(p) <= r)
    const cut = pts.slice(1).map((p, i) => pathSeg(pts[i]!, p) <= r)
    if (!erased.some(Boolean) && !cut.some(Boolean)) return
    const pieces: number[][][] = []
    let cur: number[][] = []
    const flush = () => {
      if (cur.length > 1) pieces.push(cur)
      cur = []
    }
    pts.forEach((p, i) => {
      if (erased[i]) return flush()
      if (i > 0 && cut[i - 1]) flush()
      cur.push(p)
    })
    flush()
    out.push({ index, pieces })
  })
  return out
}

// The stroke's box meets the path's box (grown by r): a necessary condition for any touch.
function boxesCross(pts: number[][], x0: number, x1: number, y0: number, y1: number): boolean {
  const bx = pts.map((p) => p[0]!), by = pts.map((p) => p[1]!)
  return Math.min(...bx) <= x1 && Math.max(...bx) >= x0 && Math.min(...by) <= y1 && Math.max(...by) >= y0
}

/** The page's elements after the erase: a touched stroke is gone (stroke mode) or replaced in place by its pieces; `idOf` names piece `j` of `orig`. */
export function erasedElements(page: Page, hits: ReturnType<typeof erasePieces>, partial: boolean, idOf: (orig: El, j: number) => string): Page['elements'] {
  const byIndex = new Map(hits.map((h) => [h.index, h.pieces]))
  return page.elements.flatMap((e, index) => {
    const pieces = byIndex.get(index)
    if (!pieces) return [e]
    if (!partial) return []
    return pieces.map((points, j) => ({ ...(structuredClone(e) as object), id: idOf(e as El, j), points }) as unknown as Page['elements'][number])
  })
}

function eraseOp(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const path = op.path as number[][]
  if (!Array.isArray(path) || path.length === 0) return { error: 'emptyPath' }
  const w = op.width
  const width = typeof w === 'number' && Number.isFinite(w) && Math.abs(w) <= 1000 ? Math.sign(w) * Math.round(Math.abs(w) * 10) / 10 : NaN
  if (!(width >= ERASER_MIN && width <= ERASER_MAX)) return { error: 'invalidEraserWidth' }
  const hits = erasePieces(page, path, width)
  if (hits.length === 0) return { note, inverse: null }
  const partial = op.op === 'erasePartial'
  const items = hits.map((h) => ({ index: h.index, element: structuredClone(page.elements[h.index]) as El }))
  const newIds: string[] = []
  page.elements = erasedElements(page, hits, partial, () => {
    const id = ctx.ids![newIds.length]!
    newIds.push(id)
    return id
  })
  touch(page, ctx)
  return { note: next, inverse: { op: 'insertElements', pageId: op.pageId, ...(partial ? { removeIds: newIds } : {}), items } }
}

// paste: copies with new ids, centered, nudged off equal boxes.
function paste(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const src = (Array.isArray(op.elements) ? op.elements : []) as El[]
  if (src.length === 0) return { error: 'emptySelection' }
  const copies = src.map((e, i) => ({ ...noHeight(structuredClone(e)), id: ctx.ids![i] }) as El)
  let dx = 0, dy = 0
  const c = (op.target as { center?: [number, number] } | undefined)?.center
  const union = selectionBounds(copies)
  if (c && union) {
    dx = c[0] - (union.left + union.right) / 2
    dy = c[1] - (union.top + union.bottom) / 2
  }
  const key = (e: El) => {
    const b = selectionBounds([e])
    return b ? [b.left, b.top, b.right, b.bottom].map(round2).join() : null
  }
  const taken = new Set(page.elements.map((e) => key(e as El)))
  const shifted = (sx: number, sy: number) =>
    copies.map((s) => {
      const e = structuredClone(s)
      if (e.type === 'stroke') {
        for (const p of (e.points as number[][] | undefined) ?? []) {
          p[0] = round2(p[0]! + sx)
          p[1] = round2(p[1]! + sy)
        }
      } else if (selectionBounds([e])) {
        e.x = round2((e.x as number) + sx)
        e.y = round2((e.y as number) + sy)
      }
      return e
    })
  let out = shifted(dx, dy)
  for (let k = 1; k <= 20; k++) {
    if (!out.some((e) => { const m = key(e); return m !== null && taken.has(m) })) break
    out = shifted(dx + 12 * k, dy + 12 * k)
  }
  page.elements.push(...(out as unknown as Page['elements']))
  touch(page, ctx)
  return { note: next, inverse: { op: 'delete', pageId: op.pageId, ids: out.map((e) => e.id) } }
}

// ---- text box operations (spec/ops.md "Text box operations") ----

const widthOk = (w: unknown) => typeof w === 'number' && Number.isFinite(w) && round2(w) >= WIDTH_MIN

function createTextBox(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  if (!widthOk(op.width)) return { error: 'invalidWidth' }
  const runs = op.runs === undefined ? [] : op.runs
  if (!validRuns(runs)) return { error: 'invalidRuns' }
  const text = normalizeNewlines(op.text as string)
  if (isBlankText(text)) return { note, inverse: null }
  const id = ctx.ids![0]!
  page.elements.push({
    id, type: 'text', x: round2(op.x as number), y: round2(op.y as number), width: round2(op.width as number), rotation: 0,
    text, runs: normalizeRuns(runs as unknown[], cpLen(text)),
    size: SIZE_DEFAULT, color: COLOR_DEFAULT, bold: false, italic: false,
  })
  touch(page, ctx)
  return { note: next, inverse: { op: 'delete', pageId: op.pageId, ids: [id] } }
}

// editText and setTextBoxWidth share the error order and the lookup.
function editText(note: Note, op: Op, ctx: Ctx): OpResult {
  const width = op.op === 'setTextBoxWidth'
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  if (width ? !widthOk(op.width) : !validRuns(op.runs)) return { error: width ? 'invalidWidth' : 'invalidRuns' }
  const index = page.elements.findIndex((e) => elId(e) === op.id)
  if (index < 0) return { error: 'elementNotFound' }
  const e = page.elements[index] as El
  if (e.type !== 'text') return { error: 'notTextBox' }
  const before = structuredClone(e)
  delete before.height
  delete e.height
  touch(page, ctx)
  if (width) {
    e.width = round2(op.width as number)
  } else {
    const text = normalizeNewlines(op.text as string)
    if (isBlankText(text)) {
      page.elements.splice(index, 1)
      return { note: next, inverse: { op: 'insertElements', pageId: op.pageId, items: [{ index, element: before }] } }
    }
    e.text = text
    e.runs = normalizeRuns(op.runs as unknown[], cpLen(text))
  }
  return { note: next, inverse: { op: 'replaceElements', pageId: op.pageId, elements: [before] } }
}

// spec/ops.md ops.insertImage: the bytes are the caller's business (already stored).
function insertImage(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const px = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1
  const side = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && round2(v) >= 1
  const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  if (!px(op.pxWidth) || !px(op.pxHeight) || !side(op.width) || !side(op.height) || !fin(op.x) || !fin(op.y)) return { error: 'invalidSize' }
  if (!isAssetHash(op.asset)) return { error: 'invalidAsset' }
  if (op.ext !== 'jpg' && op.ext !== 'png' && op.ext !== 'webp') return { error: 'unsupportedExt' }
  const id = ctx.ids![0]!
  page.elements.push({
    id, type: 'image', x: round2(op.x as number), y: round2(op.y as number), width: round2(op.width as number), height: round2(op.height as number),
    rotation: 0, asset: op.asset, ext: op.ext, pxWidth: op.pxWidth, pxHeight: op.pxHeight,
  } as unknown as Page['elements'][number])
  touch(page, ctx)
  return { note: next, inverse: { op: 'delete', pageId: op.pageId, ids: [id] } }
}
