// Spec version.list and version.keepForever (spec/version.md): what the history list of a note shows and which
// revision pins are released. Pure; bad input is `{error: 'invalidInput'}`, never a throw.
// Mirrors kkeujeok-client/lib/sync/version_list.dart.
const BAD = { error: 'invalidInput' } as const

const TIMESTAMP = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SIDECAR_TAIL = new RegExp(`^(${UUID}):(${UUID})$`)
const INDEX = /^(0|[1-9]\d*)$/
const THIRTY_DAYS = 2_592_000_000
const REASONS = ['unreadable', 'unsupportedVersion', 'purged']

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isTimestamp = (v: unknown): v is string => typeof v === 'string' && TIMESTAMP.test(v)

/** Milliseconds since 1970-01-01 of a canonical timestamp (the day is not checked against the month, as the spec says). */
export function timestampMs(t: string): number {
  const n = (from: number, len: number) => Number(t.slice(from, from + len))
  const m = n(5, 2)
  const d = n(8, 2)
  const y = m <= 2 ? n(0, 4) - 1 : n(0, 4)
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  const days = era * 146097 + doe - 719468
  return days * 86400000 + n(11, 2) * 3600000 + n(14, 2) * 60000 + n(17, 2) * 1000 + n(20, 3)
}

/** `info` is valid: absent, null, a failure, or the success shape of its kind. */
function validInfo(info: unknown, sidecar: boolean): boolean {
  if (info === null || info === undefined) return true
  if (!isObj(info) || typeof info.ok !== 'boolean') return false
  if (!info.ok) return REASONS.includes(info.reason as string)
  if (sidecar) return typeof info.editedBy === 'string'
  return Array.isArray(info.pages) && info.pages.every((p) => isObj(p) && typeof p.editedAt === 'string' && typeof p.editedBy === 'string')
}

function validRevisions(revisions: unknown): revisions is Json[] {
  if (!Array.isArray(revisions)) return false
  const ids = new Set<string>()
  for (const r of revisions) {
    if (!isObj(r) || typeof r.id !== 'string' || r.id === '' || ids.has(r.id)) return false
    ids.add(r.id)
    if (!isTimestamp(r.modifiedTime)) return false
    if ('keepForever' in r && r.keepForever !== undefined && typeof r.keepForever !== 'boolean') return false
  }
  return true
}

function deviceOf(info: unknown, sidecar: boolean): string | null {
  if (!isObj(info) || info.ok !== true) return null
  if (sidecar) return info.editedBy as string
  let name: string | null = null
  let at: string | null = null
  for (const p of info.pages as Json[]) {
    const e = p.editedAt as string
    if (at === null || e > at) {
      at = e
      name = p.editedBy as string
    }
  }
  return name
}

const statusOf = (info: unknown): string => (!isObj(info) ? 'unknown' : info.ok === true ? 'ok' : (info.reason as string))

export type VersionEntry =
  | {
      kind: 'revision'
      revisionId: string
      at: string
      deviceName: string | null
      status: string
      current: boolean
      beforeRestore: boolean
      restorable: boolean
    }
  | { kind: 'sidecar'; pageId: string; rev: string; at: string; deviceName: string | null; status: string; originalIndex: number; restorable: boolean }

export type VersionListResult = { entries: VersionEntry[] } | typeof BAD

export function versionListRule(input: unknown): VersionListResult {
  try {
    return listRule(input)
  } catch {
    return BAD
  }
}

function listRule(input: unknown): VersionListResult {
  if (!isObj(input)) return BAD
  const { now, noteId, headRevisionId: head, revisions, sidecars } = input
  if (!isTimestamp(now) || typeof noteId !== 'string') return BAD
  if (head !== null && head !== undefined && typeof head !== 'string') return BAD
  if (!validRevisions(revisions) || !Array.isArray(sidecars)) return BAD
  for (const r of revisions) if (!validInfo(r.info, false)) return BAD
  for (const s of sidecars) {
    if (!isObj(s)) return BAD
    if (s.appProperties !== null && s.appProperties !== undefined && !isObj(s.appProperties)) return BAD
    if (!validInfo(s.info, true)) return BAD
  }

  // Revisions: newest first, equal times with the later input first.
  const revs = revisions.map((r, i) => ({ r, i })).sort((a, b) => (a.r.modifiedTime === b.r.modifiedTime ? b.i - a.i : a.r.modifiedTime! < b.r.modifiedTime! ? 1 : -1))
  const entries: VersionEntry[] = revs.map(({ r }) => {
    const status = statusOf(r.info)
    const current = r.id === head
    return {
      kind: 'revision',
      revisionId: r.id as string,
      at: r.modifiedTime as string,
      deviceName: deviceOf(r.info, false),
      status,
      current,
      beforeRestore: r.keepForever === true,
      restorable: (status === 'unknown' || status === 'ok') && !current,
    }
  })

  const nowMs = timestampMs(now)
  const seen = new Set<string>()
  const cars: VersionEntry[] = []
  const prefix = `sc:${noteId}:`
  for (const s of sidecars as Json[]) {
    const props = (s.appProperties ?? null) as Json | null
    const id = props?.kkeujeokId
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue
    const m = SIDECAR_TAIL.exec(id.slice(prefix.length))
    if (!m || seen.has(id)) continue
    seen.add(id)
    const resolved = props!.kkjResolved
    if (!isTimestamp(resolved)) continue
    if (nowMs - timestampMs(resolved) > THIRTY_DAYS) continue
    const edited = props!.kkjEdited
    const idx = props!.kkjIndex
    const status = statusOf(s.info)
    cars.push({
      kind: 'sidecar',
      pageId: m[1]!,
      rev: m[2]!,
      at: isTimestamp(edited) ? edited : resolved,
      deviceName: deviceOf(s.info, true),
      status,
      originalIndex: typeof idx === 'string' && INDEX.test(idx) ? Number(idx) : 0,
      restorable: status === 'unknown' || status === 'ok',
    })
  }
  cars.sort((a, b) => {
    const x = a as Extract<VersionEntry, { kind: 'sidecar' }>
    const y = b as Extract<VersionEntry, { kind: 'sidecar' }>
    return x.pageId === y.pageId ? (x.rev < y.rev ? -1 : x.rev > y.rev ? 1 : 0) : x.pageId < y.pageId ? -1 : 1
  })

  // One list, newest first. Array sort is stable: on equal times a revision stays before a sidecar.
  const all = [...entries, ...cars].map((e, i) => ({ e, i }))
  all.sort((a, b) => (a.e.at === b.e.at ? a.i - b.i : a.e.at < b.e.at ? 1 : -1))
  return { entries: all.map((x) => x.e) }
}

/**
 * `versionListRule` that leaves out the items the rule refuses (a bad time or `info`, a repeated id) instead of
 * failing as a whole; the rule and its contract stay as they are.
 */
export function versionListLenient(input: unknown): VersionListResult {
  const r = versionListRule(input)
  if (!('error' in r) || !isObj(input) || !Array.isArray(input.revisions) || !Array.isArray(input.sidecars)) return r
  const ok = (revisions: unknown[], sidecars: unknown[]) => !('error' in versionListRule({ ...input, revisions, sidecars }))
  const ids = new Set<unknown>()
  const cids = new Set<unknown>()
  return versionListRule({
    ...input,
    revisions: input.revisions.filter((v) => ok([v], []) && !ids.has((v as Json).id) && !!ids.add((v as Json).id)),
    // A repeated sidecar id: the first wins.
    sidecars: input.sidecars.filter((s) => {
      const id = (s as { appProperties?: Json | null } | null)?.appProperties?.kkeujeokId
      return ok([], [s]) && (id === undefined || id === null || !cids.has(id) && !!cids.add(id))
    }),
  })
}

export type KeepForeverResult = { mark: string | null; release: string[] } | typeof BAD

export function keepForeverRule(input: unknown): KeepForeverResult {
  try {
    if (!isObj(input)) return BAD
    const { revisions, target } = input
    if (!validRevisions(revisions) || typeof target !== 'string') return BAD
    const t = revisions.find((r) => r.id === target)
    if (!t) return BAD
    if (t.keepForever === true) return { mark: null, release: [] }
    const pinned = revisions
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.keepForever === true)
      .sort((a, b) => (a.r.modifiedTime === b.r.modifiedTime ? a.i - b.i : a.r.modifiedTime! < b.r.modifiedTime! ? -1 : 1))
    const n = Math.max(0, pinned.length - 199)
    return { mark: target, release: pinned.slice(0, n).map((x) => x.r.id as string) }
  } catch {
    return BAD
  }
}
