// Spec merge.md: page-by-page 3-way merge, page order, note fields. Pure: no
// clock, no random number, no input mutated (inputs are deep-copied first, so
// the result never shares an object with an argument). Unknown fields ride along.
import type { Note, Page } from '../model/note'

export type MergeCtx = { now: string; orderRev: string; rev: string; editedBy: string; lastSeenRemoteSeq: number }
export type ConflictKind = 'bothEdited' | 'remoteDeleted' | 'localDeleted'
export type Conflict = {
  pageId: string
  kind: ConflictKind
  rev: string
  theirsRev: string | null
  detectedAt: string
  originalIndex: number
  resolvedAt: string | null
}
export type Sidecar = {
  noteId: string
  pageId: string
  rev: string
  seq: number
  editedAt: string
  editedBy: string
  kind: ConflictKind
  page: Page
}
export type MergeOk = {
  result: 'merged'
  note: Note
  conflicts: Conflict[]
  sidecars: Sidecar[]
  reupload: { pages: string[]; order: boolean; meta: boolean }
  lastSeenRemoteSeq: number
  undoDrop: string[]
  readOnlyPages: string[]
}
export type MergeErrorCode = 'noteIdMismatch' | 'duplicatePageId'
// `result?: undefined` lets callers narrow on `r.result === 'merged'`.
export type MergeErr = { error: MergeErrorCode; result?: undefined }
export type MergeResult = MergeOk | { result: 'unsupportedVersion' } | MergeErr
export type Requeue = { pages: string[]; order: boolean; meta: boolean }
export type RequeueResult = (MergeOk & { requeue: Requeue }) | { result: 'unsupportedVersion' } | MergeErr

const KNOWN_TOP = new Set(['formatVersion', 'noteId', 'meta', 'metaRev', 'metaSeq', 'orderRev', 'orderSeq', 'pages'])
const KNOWN_META = new Set(['title', 'coverId'])
const BACKGROUNDS: readonly unknown[] = ['plain', 'lined', 'grid', 'dot']
const LINEAGE_MAX = 16

// Own-property write: a JSON key named "__proto__" must not reach the prototype.
const put = (o: object, k: string, v: unknown) =>
  void Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })

const lineageOf = (p: Page): string[] => (Array.isArray(p.lineage) ? (p.lineage as string[]) : [])
const byId = (n: Note | null) => new Map((n?.pages ?? []).map((p) => [p.id, p]))
const hasDuplicate = (n: Note | null) => !!n && new Set(n.pages.map((p) => p.id)).size !== n.pages.length

/** Checks of merge.formatVersion; `extra` are further notes (merge.requeue) whose noteId and page ids count too. */
function check(base: Note | null, local: Note, remote: Note, extra: Note[]): MergeResult | null {
  const fv: unknown = remote.formatVersion
  if (typeof fv === 'number' && Number.isInteger(fv) && fv > 1) return { result: 'unsupportedVersion' }
  const all = [base, local, remote, ...extra]
  if (all.some((n) => n && n.noteId !== local.noteId)) return { error: 'noteIdMismatch' }
  if (all.some(hasDuplicate)) return { error: 'duplicatePageId' }
  return null
}

function mergeChecked(base0: Note | null, local0: Note, remote0: Note, ctx0: MergeCtx, extra: Note[] = []): MergeResult {
  const early = check(base0, local0, remote0, extra)
  if (early) return early
  const base = structuredClone(base0)
  const local = structuredClone(local0)
  const remote = structuredClone(remote0)
  const ctx = structuredClone(ctx0)

  const bp = byId(base)
  const lp = byId(local)
  const rp = byId(remote)
  // U: local, then remote, then base (merge.md "Processing order U").
  const U = [...new Set([...lp.keys(), ...rp.keys(), ...bp.keys()])]

  const result = new Map<string, Page>()
  const conflicts: Conflict[] = []
  const sidecars: Sidecar[] = []
  const conflictIds = new Set<string>()

  const conflict = (id: string, kind: ConflictKind, side: Page, theirs: Page | undefined) => {
    let originalIndex = local.pages.findIndex((p) => p.id === id)
    if (originalIndex < 0) originalIndex = (base?.pages ?? []).findIndex((p) => p.id === id)
    conflicts.push({ pageId: id, kind, rev: side.rev, theirsRev: theirs ? theirs.rev : null, detectedAt: ctx.now, originalIndex, resolvedAt: null })
    sidecars.push({ noteId: local.noteId, pageId: id, rev: side.rev, seq: side.seq, editedAt: side.editedAt, editedBy: side.editedBy, kind, page: side })
    conflictIds.add(id)
  }

  for (const id of U) {
    const b = bp.get(id)
    const l = lp.get(id)
    let r = rp.get(id)
    // merge.staleSeq: an older write that arrived late is not the remote page.
    if (b && r && r.rev !== b.rev && r.seq < b.seq) r = b
    let out: Page | undefined
    if (b) {
      const lSame = !!l && l.rev === b.rev
      const rSame = !!r && r.rev === b.rev
      if (l && r) {
        if (lSame && rSame) out = l
        else if (lSame) {
          out = r
          if (!lineageOf(r).includes(b.rev)) conflict(id, 'bothEdited', b, r)
        } else if (rSame) out = { ...l, lineage: [b.rev, ...lineageOf(b)].slice(0, LINEAGE_MAX) }
        else if (l.rev === r.rev) out = l
        else {
          out = r
          conflict(id, 'bothEdited', l, r)
        }
      } else if (l && !r) {
        // remote deleted
        if (!lSame) conflict(id, 'remoteDeleted', l, undefined)
      } else if (!l && r) {
        // local deleted
        if (!rSame) {
          out = r
          conflict(id, 'localDeleted', b, r)
        }
      }
    } else if (l && !r) out = l
    else if (!l && r) out = r
    else if (l && r) {
      if (l.rev === r.rev) out = l
      else {
        out = r
        conflict(id, 'bothEdited', l, r)
      }
    }
    if (out) result.set(id, out)
  }

  // merge.order
  const Rc = !base || (remote.orderRev !== base.orderRev && !(remote.orderSeq < base.orderSeq))
  const cNote = Rc ? remote : local
  const oNote = Rc ? local : remote
  const C = cNote.pages.map((p) => p.id)
  const O = oNote.pages.map((p) => p.id)
  const R = C.filter((id) => result.has(id))
  for (const [i, id] of O.entries()) {
    if (!result.has(id) || R.includes(id)) continue
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = R.indexOf(O[j]!)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    R.splice(at, 0, id)
  }
  const sameOrder = R.length === C.length && R.every((id, i) => id === C[i])
  const orderRev = sameOrder ? cNote.orderRev : ctx.orderRev
  const orderSeq = sameOrder ? cNote.orderSeq : Math.max(local.orderSeq, remote.orderSeq) + 1

  // merge.meta
  const metaL = local.metaRev !== (base ? base.metaRev : null)
  const metaR = !base || (remote.metaRev !== base.metaRev && !(remote.metaSeq < base.metaSeq))
  let win: Note
  if (metaR && !metaL) win = remote
  else if (!metaR) win = local
  else if (local.metaRev === remote.metaRev) win = remote
  else if (local.metaSeq !== remote.metaSeq) win = local.metaSeq > remote.metaSeq ? local : remote
  else win = local.metaRev > remote.metaRev ? local : remote
  const meta: Record<string, unknown> = {}
  for (const k of KNOWN_META) if (Object.hasOwn(win.meta, k)) put(meta, k, win.meta[k])
  for (const src of [local.meta, remote.meta]) {
    for (const k of Object.keys(src)) if (!KNOWN_META.has(k)) put(meta, k, src[k])
  }

  // merge.unknownFields (top level)
  const note: Record<string, unknown> = {}
  for (const src of [local, remote]) {
    for (const k of Object.keys(src)) if (!KNOWN_TOP.has(k)) put(note, k, src[k])
  }
  put(note, 'formatVersion', local.formatVersion)
  put(note, 'noteId', local.noteId)
  put(note, 'meta', meta)
  put(note, 'metaRev', win.metaRev)
  put(note, 'metaSeq', win.metaSeq)
  put(note, 'orderRev', orderRev)
  put(note, 'orderSeq', orderSeq)
  put(note, 'pages', R.map((id) => result.get(id)!))

  // The output lists, in the order of U.
  const reupload = U.filter((id) => {
    const p = result.get(id)
    const rr = rp.get(id)
    return !!p && (!rr || rr.rev !== p.rev)
  })
  const undoDrop = [...lp.keys()].filter((id) => result.get(id)?.rev !== lp.get(id)!.rev)
  const readOnlyPages = U.filter((id) => result.has(id) && !BACKGROUNDS.includes(result.get(id)!.background))
  let seen = ctx.lastSeenRemoteSeq
  for (const p of remote.pages) seen = Math.max(seen, p.seq)
  seen = Math.max(seen, remote.orderSeq, remote.metaSeq)

  return {
    result: 'merged',
    note: note as Note,
    conflicts,
    sidecars,
    reupload: { pages: reupload, order: orderRev !== remote.orderRev, meta: win.metaRev !== remote.metaRev },
    lastSeenRemoteSeq: seen,
    undoDrop,
    readOnlyPages,
  }
}

/** Spec `merge(base, local, remote, ctx)`. */
export function merge(base: Note | null, local: Note, remote: Note, ctx: MergeCtx): MergeResult {
  return mergeChecked(base, local, remote, ctx)
}

/** Spec merge.requeue: merges against the queue state at commit time and says what changed while the network ran. */
export function mergeRequeue(a: {
  base: Note | null
  localAtStart: Note
  localAtCommit: Note
  remote: Note
  ctx: MergeCtx
}): RequeueResult {
  const r = mergeChecked(a.base, a.localAtCommit, a.remote, a.ctx, [a.localAtStart])
  if (r.result !== 'merged') return r
  const s = byId(a.localAtStart)
  const c = byId(a.localAtCommit)
  const pages = [...new Set([...s.keys(), ...c.keys()])]
    .filter((id) => s.get(id)?.rev !== c.get(id)?.rev || !s.has(id) !== !c.has(id))
    .sort()
  return {
    ...r,
    requeue: {
      pages,
      order: a.localAtStart.orderRev !== a.localAtCommit.orderRev,
      meta: a.localAtStart.metaRev !== a.localAtCommit.metaRev,
    },
  }
}
