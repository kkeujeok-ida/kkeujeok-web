// Spec `sync.hasUnsent`: whether a note has changes Drive does not have.
// Never throws; bad input is `{error: 'invalidInput'}`. The order of the
// `pages` array is not compared (the order of pages is `orderRev`).
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// A valid `S` as its page map (id -> rev), else null.
function pagesOf(s: unknown): Map<string, string> | null {
  if (!isObj(s) || typeof s.orderRev !== 'string' || typeof s.metaRev !== 'string') return null
  if (!Array.isArray(s.pages)) return null
  const m = new Map<string, string>()
  for (const p of s.pages) {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.rev !== 'string' || m.has(p.id)) return null
    m.set(p.id, p.rev)
  }
  return m
}

export function hasUnsentRule(input: unknown): { hasUnsent: boolean } | { error: 'invalidInput' } {
  const bad = { error: 'invalidInput' } as const
  if (!isObj(input)) return bad
  const base = input.base ?? null
  const pv = input.pendingVerify ?? null
  const sidecars = input.unsentSidecars
  const wp = pagesOf(input.working)
  const bp = base === null ? null : pagesOf(base)
  if (!wp || (base !== null && !bp)) return bad
  if (pv !== null && !isObj(pv)) return bad
  if (!Array.isArray(sidecars)) return bad

  if (base === null || pv !== null || sidecars.length > 0) return { hasUnsent: true }
  const w = input.working as Obj
  const b = base as Obj
  if (w.orderRev !== b.orderRev || w.metaRev !== b.metaRev) return { hasUnsent: true }
  if (bp!.size !== wp.size) return { hasUnsent: true }
  for (const [id, rev] of wp) if (bp!.get(id) !== rev) return { hasUnsent: true }
  return { hasUnsent: false }
}
