// `sync` record of one note (spec sync.md "On the device"). Fields this client
// does not know are kept in `extra` and written back.
import { revisionIdPattern } from '../sync/syncLogEntry'
import { staleHeadRule } from '../sync/syncRules'

export type SyncState = 'synced' | 'pending' | 'syncing' | 'conflict' | 'error'
const STATES: unknown[] = ['synced', 'pending', 'syncing', 'conflict', 'error']
export type JsonMap = Record<string, unknown>

export type SyncInfo = {
  fileId: string | null
  baseHeadRevisionId: string | null
  state: SyncState
  pendingVerify: JsonMap | null
  resumableSession: JsonMap | null
  createIntent: JsonMap | null
  conflicts: JsonMap[]
  unsentSidecars: JsonMap[]
  lastError: JsonMap | null
  extra: JsonMap
}

export const emptySync = (): SyncInfo => ({
  fileId: null,
  baseHeadRevisionId: null,
  state: 'pending',
  pendingVerify: null,
  resumableSession: null,
  createIntent: null,
  conflicts: [],
  unsentSidecars: [],
  lastError: null,
  extra: {},
})

const KNOWN = [
  'fileId', 'baseHeadRevisionId', 'state', 'pendingVerify', 'resumableSession',
  'createIntent', 'conflicts', 'unsentSidecars', 'lastError',
]

const isObj = (v: unknown): v is JsonMap => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown) => typeof v === 'string'
const strOrNull = (v: unknown) => v === null || v === undefined || typeof v === 'string'
const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/** Null when `json` is not a well-formed record. A missing key takes its default. */
export function syncFromJson(json: unknown): SyncInfo | null {
  if (!isObj(json)) return null
  const m = json
  if (!strOrNull(m.fileId) || !strOrNull(m.baseHeadRevisionId)) return null
  const base = (m.baseHeadRevisionId as string | null | undefined) ?? null
  if (base !== null && !revisionIdPattern.test(base)) return null
  const state = m.state ?? 'pending'
  if (!STATES.includes(state)) return null

  const BAD = Symbol('bad')
  const obj = (k: string, ok: (o: JsonMap) => boolean): JsonMap | null | typeof BAD => {
    const v = m[k]
    if (v === null || v === undefined) return null
    return isObj(v) && ok(v) ? v : BAD
  }
  const list = (k: string, ok: (o: JsonMap) => boolean): JsonMap[] | typeof BAD => {
    const v = m[k]
    if (v === null || v === undefined) return []
    return Array.isArray(v) && v.every((e) => isObj(e) && ok(e)) ? (v as JsonMap[]) : BAD
  }
  const pendingVerify = obj('pendingVerify', (o) =>
    strOrNull(o.parentRevisionId) && strOrNull(o.oursRevisionId) && intIn(o.round, 1, 3))
  const resumableSession = obj('resumableSession', (o) => isStr(o.uri) && intIn(o.size, 0, Infinity))
  const createIntent = obj('createIntent', (o) => isStr(o.kkeujeokId) && isStr(o.parentId))
  const conflicts = list('conflicts', (o) => isStr(o.pageId) && isStr(o.rev) && strOrNull(o.resolvedAt))
  const unsentSidecars = list('unsentSidecars', (o) => isStr(o.pageId) && isStr(o.rev))
  const lastError = obj('lastError', (o) =>
    isStr(o.class) && (o.status == null || intIn(o.status, 100, 599)) && strOrNull(o.reason))
  if (
    pendingVerify === BAD || resumableSession === BAD || createIntent === BAD ||
    conflicts === BAD || unsentSidecars === BAD || lastError === BAD
  ) return null
  return {
    fileId: (m.fileId as string | null | undefined) ?? null,
    baseHeadRevisionId: base,
    state: state as SyncState,
    pendingVerify,
    resumableSession,
    createIntent,
    conflicts,
    unsentSidecars,
    lastError,
    extra: Object.fromEntries(Object.entries(m).filter(([k]) => !KNOWN.includes(k))),
  }
}

export const syncToJson = (i: SyncInfo): JsonMap => ({
  ...i.extra,
  fileId: i.fileId,
  baseHeadRevisionId: i.baseHeadRevisionId,
  state: i.state,
  pendingVerify: i.pendingVerify,
  resumableSession: i.resumableSession,
  createIntent: i.createIntent,
  conflicts: i.conflicts,
  unsentSidecars: i.unsentSidecars,
  lastError: i.lastError,
})

const KNOWN_KEY = 'knownRevisionIds' // an unknown key of `sync`, so older readers keep it

/** Revisions this device already knows (uploaded, received, merged from); see `sync.staleHead`. */
export const knownRevisions = (i: SyncInfo): string[] => {
  const v = i.extra[KNOWN_KEY]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** True when `head` is a revision this device knows and not the base: a late listing, not a remote change. */
export const isStaleHead = (i: SyncInfo, head: string): boolean =>
  (staleHeadRule({ known: knownRevisions(i), base: i.baseHeadRevisionId, head }) as { result?: string }).result === 'skip'

/** `i` with the current base and `ids` remembered (oldest dropped past the cap). */
export const withKnown = (i: SyncInfo, ...ids: string[]): SyncInfo => {
  const add = [i.baseHeadRevisionId, ...ids].filter((x): x is string => x !== null)
  const { known } = staleHeadRule({ known: knownRevisions(i), add }) as { known: string[] }
  return { ...i, extra: { ...i.extra, [KNOWN_KEY]: known } }
}
