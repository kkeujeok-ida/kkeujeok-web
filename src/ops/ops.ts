// Edit operations (spec ops.md). Never mutate the input note.
import { type Note, type Page, type Stroke, SUPPORTED_FORMAT_VERSION, isValidStroke, roundStroke } from '../model/note'
import { normalizeTitle } from '../model/noteTitle'
import { round2 } from '../model/number'
import { selectionBounds, type El } from '../model/select'

export type Ctx = { rev: string; now: string; editedBy: string; lastSeenRemoteSeq: number }
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
