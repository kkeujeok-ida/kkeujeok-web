// Spec `synclog.entry`: checks one log entry before it is stored or exported.
// Never throws.

/** A Drive revision id doubles as a key part, so its form is fixed. The one definition. */
export const revisionIdPattern = /^[A-Za-z0-9_.~-]{1,200}$/

export type EntryCheck =
  | { ok: true }
  | { ok: false; reason: 'notObject' }
  | { ok: false; reason: 'unknownField' | 'missingField' | 'badValue'; field: string }

// (field, required) in check order.
const EVENTS: Record<string, [string, boolean][]> = {
  stateChange: [['noteId', true], ['from', true], ['to', true]],
  uploadStarted: [['noteId', true], ['kind', true]],
  uploadFinished: [['noteId', true], ['revisionId', true]],
  verifyRound: [['noteId', true], ['round', true], ['count', true]],
  revisionDownloaded: [['noteId', true], ['revisionId', true]],
  merged: [['noteId', true], ['rev', false]],
  conflictFound: [['noteId', true], ['rev', false]],
  baseAdvanced: [['noteId', true], ['revisionId', true]],
  backoff: [['class', true], ['attempt', true], ['delayMs', true], ['noteId', false]],
  error: [['class', true], ['noteId', false], ['status', false], ['reason', false]],
  pageTokenRejected: [],
  duplicatesCleaned: [['count', true]],
}

const AT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REASON = /^[A-Za-z0-9_]{1,64}$/
const STATES = ['synced', 'pending', 'syncing', 'conflict', 'error']
const CLASSES = ['backoff', 'quota', 'reauth', 'deleted', 'unreadable', 'fatal']

/** True when `reason` is in the `reason` domain. */
export const validLogReason = (reason: unknown): boolean => typeof reason === 'string' && REASON.test(reason)

const int = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function valid(field: string, v: unknown, event: unknown): boolean {
  const str = typeof v === 'string'
  switch (field) {
    case 'at': return str && AT.test(v)
    case 'event': return str && Object.hasOwn(EVENTS, v)
    case 'noteId': case 'rev': return str && UUID.test(v)
    case 'revisionId': return str && revisionIdPattern.test(v)
    case 'from': case 'to': return str && STATES.includes(v)
    case 'kind': return v === 'simple' || v === 'resumable'
    case 'class': return str && CLASSES.includes(v)
    case 'status': return int(v, 100, 599)
    case 'reason': return validLogReason(v)
    case 'attempt': return int(v, 1, 7)
    case 'delayMs': return int(v, 0, 32000)
    case 'round': return int(v, 1, 3)
    case 'count': return int(v, event === 'duplicatesCleaned' ? 1 : 0, 2 ** 53)
    default: return false
  }
}

export function checkLogEntry(entry: unknown): EntryCheck {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { ok: false, reason: 'notObject' }
  }
  const e = entry as Record<string, unknown>
  const spec = typeof e.event === 'string' && Object.hasOwn(EVENTS, e.event) ? EVENTS[e.event]! : null
  const allowed = new Set(['at', 'event', ...(spec ?? Object.values(EVENTS).flat()).map((f) => f[0])])
  const unknown = Object.keys(e).filter((k) => !allowed.has(k)).sort()
  if (unknown.length) return { ok: false, reason: 'unknownField', field: unknown[0]! }

  for (const f of ['at', 'event', ...(spec ?? []).filter((x) => x[1]).map((x) => x[0])]) {
    if (!Object.hasOwn(e, f)) return { ok: false, reason: 'missingField', field: f }
  }
  for (const f of ['at', 'event', ...(spec ?? []).map((x) => x[0])]) {
    if (Object.hasOwn(e, f) && !valid(f, e[f], e.event)) return { ok: false, reason: 'badValue', field: f }
  }
  return { ok: true }
}
