// Edit operations (spec ops.md). Never mutate the input note.
import { type Note, type Page, type Stroke, SUPPORTED_FORMAT_VERSION, isValidStroke, roundStroke } from '../model/note'
import { normalizeTitle } from '../model/noteTitle'
import { round2 } from '../model/number'
import { selectionBounds, type El } from '../model/select'

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
    case 'paste':
      return paste(note, op, ctx)
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
  const before = structuredClone(chosen)
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
      const w = e.width as number, h = e.height as number
      const [cx, cy] = f((e.x as number) + w / 2, (e.y as number) + h / 2)
      const nw = w * sx, nh = h * sy
      e.x = round2(cx - nw / 2)
      e.y = round2(cy - nh / 2)
      e.width = round2(nw)
      e.height = round2(nh)
      // round2 can reach 360 (359.999): stored as 0.
      if (op.op === 'rotate') e.rotation = round2((((((e.rotation as number | undefined) ?? 0) + turn) % 360) + 360) % 360) % 360
    }
  }
  touch(page, ctx)
  return { note: next, inverse: { op: 'replaceElements', pageId: op.pageId, elements: before } }
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
    return width >= 0.5 && width <= 10 ? null : 'invalidWidth'
  })
  if ('error' in r) return r
  const strokes = r.idx.filter((i) => (r.page.elements[i] as El).type === 'stroke')
  if (strokes.length === 0) return { note, inverse: null }
  const before = strokes.map((i) => structuredClone(r.page.elements[i]))
  for (const i of strokes) (r.page.elements[i] as El)[color ? 'color' : 'width'] = color ? op.color : width
  touch(r.page, ctx)
  return { note: next, inverse: { op: 'replaceElements', pageId: op.pageId, elements: before } }
}

function deleteOp(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const r = select(next, op, () => null)
  if ('error' in r) return r
  const items = r.idx.map((index) => ({ index, element: r.page.elements[index] }))
  for (const i of [...r.idx].reverse()) r.page.elements.splice(i, 1)
  touch(r.page, ctx)
  return { note: next, inverse: { op: 'insertElements', pageId: op.pageId, items } }
}

// Inverse-only: puts elements back at their indices, in the given order.
function insertElements(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const items = structuredClone((op.items as { index: unknown; element: El }[]) ?? [])
  const seen = new Set(page.elements.map(elId))
  for (const it of items) if (seen.size === seen.add(it.element.id).size) return { error: 'duplicateId' }
  for (const it of items) {
    const i = it.index
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > page.elements.length) return { error: 'indexOutOfRange' }
    page.elements.splice(i, 0, it.element)
  }
  touch(page, ctx)
  return { note: next, inverse: { op: 'delete', pageId: op.pageId, ids: items.map((it) => it.element.id) } }
}

// paste: copies with new ids, centered, nudged off equal boxes.
function paste(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const page = findPage(next, op.pageId)
  if (!page) return { error: 'pageNotFound' }
  const src = (Array.isArray(op.elements) ? op.elements : []) as El[]
  if (src.length === 0) return { error: 'emptySelection' }
  const copies = src.map((e, i) => ({ ...structuredClone(e), id: ctx.ids![i] }) as El)
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
