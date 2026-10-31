// Page operations (spec/ops.md "Page operations"; mirrors test/tools/pages.js). Never mutate the input note.
import type { Note, Page } from '../model/note'
import type { Ctx, Op, OpResult } from './ops'

const BACKGROUNDS = ['plain', 'lined', 'grid', 'dot']
const unchanged = (note: Note): OpResult => ({ note: structuredClone(note), inverse: null })
const hasDup = (xs: unknown[]) => new Set(xs).size !== xs.length
const idList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [])

function stamp(page: Page, ctx: Ctx, rev: string) {
  page.rev = rev
  page.seq = Math.max(page.seq, ctx.lastSeenRemoteSeq) + 1
  page.editedAt = ctx.now
  page.editedBy = ctx.editedBy
}
function renewOrder(note: Note, ctx: Ctx) {
  note.orderRev = ctx.orderRev!
  note.orderSeq = Math.max(note.orderSeq, ctx.lastSeenRemoteSeq) + 1
}

export function addPage(note: Note, op: Op, ctx: Ctx): OpResult {
  const index = op.index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > note.pages.length) return { error: 'indexOutOfRange' }
  const ref = note.pages[index > 0 ? index - 1 : 0]!
  const next = structuredClone(note)
  const page: Page = {
    id: ctx.pageIds![0]!, width: ref.width, height: ref.height,
    background: BACKGROUNDS.includes(ref.background) ? ref.background : 'plain',
    rev: '', seq: 0, editedAt: '', editedBy: '', elements: [],
  }
  stamp(page, ctx, ctx.revs![0]!)
  next.pages.splice(index, 0, page)
  renewOrder(next, ctx)
  return { note: next, inverse: { op: 'deletePage', pageIds: [page.id] } }
}

export function deletePage(note: Note, op: Op, ctx: Ctx): OpResult {
  const ids = idList(op.pageIds)
  const have = new Set(note.pages.map((p) => p.id))
  if (ids.some((id) => !have.has(id))) return { error: 'pageNotFound' }
  if (hasDup(ids)) return { error: 'duplicateId' }
  if (!ids.length) return unchanged(note)
  if (ids.length === note.pages.length) return { error: 'lastPage' }
  const gone = new Set(ids)
  const items: { page: Page; index: number }[] = []
  note.pages.forEach((page, index) => gone.has(page.id) && items.push({ page: structuredClone(page), index }))
  const next = structuredClone(note)
  next.pages = next.pages.filter((p) => !gone.has(p.id))
  renewOrder(next, ctx)
  return { note: next, inverse: { op: 'insertPages', items } }
}

export function insertPages(note: Note, op: Op, ctx: Ctx): OpResult {
  const next = structuredClone(note)
  const items = (Array.isArray(op.items) ? op.items : []) as { page: Page; index: number }[]
  const seen = new Set(next.pages.map((p) => p.id))
  for (const { page } of items) {
    if (seen.has(page.id)) return { error: 'duplicateId' }
    seen.add(page.id)
  }
  let len = next.pages.length
  for (const { index } of items) {
    if (!Number.isInteger(index) || index < 0 || index > len) return { error: 'indexOutOfRange' }
    len++
  }
  if (!items.length) return unchanged(note)
  items.forEach(({ page, index }, i) => {
    const p = structuredClone(page)
    stamp(p, ctx, ctx.revs![i]!)
    next.pages.splice(index, 0, p)
  })
  renewOrder(next, ctx)
  return { note: next, inverse: { op: 'deletePage', pageIds: items.map((it) => it.page.id) } }
}

export function duplicatePage(note: Note, op: Op, ctx: Ctx): OpResult {
  const ids = idList(op.pageIds)
  const have = new Set(note.pages.map((p) => p.id))
  if (ids.some((id) => !have.has(id))) return { error: 'pageNotFound' }
  if (hasDup(ids)) return { error: 'duplicateId' }
  if (!ids.length) return unchanged(note)
  const pick = new Set(ids)
  const next = structuredClone(note)
  const pages: Page[] = []
  const copyIds: string[] = []
  let i = 0, e = 0
  for (const page of next.pages) {
    pages.push(page)
    if (!pick.has(page.id)) continue
    const copy = structuredClone(page)
    delete (copy as { lineage?: unknown }).lineage
    copy.id = ctx.pageIds![i]!
    copy.seq = 0
    stamp(copy, ctx, ctx.revs![i]!)
    for (const el of copy.elements) (el as { id: string }).id = ctx.elementIds![e++]!
    copyIds.push(copy.id)
    pages.push(copy)
    i++
  }
  next.pages = pages
  renewOrder(next, ctx)
  return { note: next, inverse: { op: 'deletePage', pageIds: copyIds } }
}

function reorder(note: Note, order: string[], ctx: Ctx): OpResult {
  const old = note.pages.map((p) => p.id)
  if (order.join() === old.join()) return unchanged(note)
  const byId = new Map(note.pages.map((p) => [p.id, p]))
  const next = structuredClone(note)
  next.pages = order.map((id) => structuredClone(byId.get(id)!))
  renewOrder(next, ctx)
  return { note: next, inverse: { op: 'setPageOrder', pageIds: old } }
}

export function movePages(note: Note, op: Op, ctx: Ctx): OpResult {
  const ids = idList(op.pageIds)
  if (!ids.length) return unchanged(note)
  const have = new Set(note.pages.map((p) => p.id))
  if (ids.some((id) => !have.has(id))) return { error: 'pageNotFound' }
  if (hasDup(ids)) return { error: 'duplicateId' }
  const pick = new Set(ids)
  const rest = note.pages.filter((p) => !pick.has(p.id)).map((p) => p.id)
  const index = op.index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > rest.length) return { error: 'indexOutOfRange' }
  const moved = note.pages.filter((p) => pick.has(p.id)).map((p) => p.id)
  return reorder(note, [...rest.slice(0, index), ...moved, ...rest.slice(index)], ctx)
}

export function setPageOrder(note: Note, op: Op, ctx: Ctx): OpResult {
  const ids = idList(op.pageIds)
  const a = [...ids].sort(), b = note.pages.map((p) => p.id).sort()
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) return { error: 'pageSetMismatch' }
  return reorder(note, ids, ctx)
}

export function setPageBackground(note: Note, op: Op, ctx: Ctx): OpResult {
  const items = (Array.isArray(op.items) ? op.items : []) as { pageId: string; background: string }[]
  const have = new Set(note.pages.map((p) => p.id))
  if (items.some((it) => !have.has(it.pageId))) return { error: 'pageNotFound' }
  if (hasDup(items.map((it) => it.pageId))) return { error: 'duplicateId' }
  if (items.some((it) => !BACKGROUNDS.includes(it.background))) return { error: 'invalidBackground' }
  const want = new Map(items.map((it) => [it.pageId, it.background]))
  const next = structuredClone(note)
  const back: { pageId: string; background: string }[] = []
  let k = 0
  for (const page of next.pages) {
    if (!want.has(page.id) || want.get(page.id) === page.background) continue
    back.push({ pageId: page.id, background: page.background })
    page.background = want.get(page.id)!
    stamp(page, ctx, ctx.revs![k++]!)
  }
  if (!back.length) return unchanged(note)
  return { note: next, inverse: { op: 'setPageBackground', items: back } }
}

export function setPageOrientation(note: Note, op: Op, ctx: Ctx): OpResult {
  const idx = note.pages.findIndex((p) => p.id === op.pageId)
  if (idx < 0) return { error: 'pageNotFound' }
  if (op.orientation !== 'portrait' && op.orientation !== 'landscape') return { error: 'invalidOrientation' }
  const page = note.pages[idx]!
  const cur = page.width > page.height ? 'landscape' : 'portrait'
  if (cur === op.orientation || page.width === page.height) return unchanged(note)
  const next = structuredClone(note)
  const p = next.pages[idx]!
  ;[p.width, p.height] = [page.height, page.width]
  stamp(p, ctx, ctx.revs![0]!)
  return { note: next, inverse: { op: 'setPageOrientation', pageId: op.pageId, orientation: cur } }
}
