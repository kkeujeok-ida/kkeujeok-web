// Edit operations (spec ops.md). Never mutate the input note.
import { type Note, type Page, type Stroke, SUPPORTED_FORMAT_VERSION, isValidStroke, roundStroke } from '../model/note'
import { normalizeTitle } from '../model/noteTitle'

export type Ctx = { rev: string; now: string; editedBy: string; lastSeenRemoteSeq: number }
export type Op = { op: string; [k: string]: unknown }
export type OpResult = { note: Note; inverse: Op } | { error: string }

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
