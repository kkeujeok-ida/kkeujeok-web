// Spec sync.uploadKind, sync.staleHead, sync.verifyPlan, sync.backoff and sync.stateMachine.
// Pure; none of them throws, bad input is `{ error }`.
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = { error: 'invalidInput' } as const

/** Largest body that goes in one multipart request. */
export const SIMPLE_MAX = 5 * 1024 * 1024

export function uploadKindRule(input: unknown): { kind: 'simple' | 'resumable' } | { error: 'invalidSize' } {
  const size = isObj(input) ? input.size : undefined
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return { error: 'invalidSize' }
  return { kind: size <= SIMPLE_MAX ? 'simple' : 'resumable' }
}

const TIMESTAMP = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

export type VerifyPlan =
  | { result: 'verified'; download: string[]; target: null }
  | { result: 'merge'; download: string[]; target: 'base' | 'head' }
  | { result: 'error'; reason: 'verifyExhausted'; download: string[]; target: null }
  | { error: 'invalidInput' }

export function verifyPlanRule(input: unknown): VerifyPlan {
  if (!isObj(input)) return bad
  const { base, ours, head, round, revisions } = input
  if (typeof round !== 'number' || ![1, 2, 3].includes(round)) return bad
  if (!Array.isArray(revisions) || revisions.length === 0) return bad
  const ids = new Set<string>()
  for (const r of revisions) {
    if (!isObj(r) || typeof r.id !== 'string' || ids.has(r.id)) return bad
    if (typeof r.modifiedTime !== 'string' || !TIMESTAMP.test(r.modifiedTime)) return bad
    ids.add(r.id)
  }
  if (typeof ours !== 'string' || typeof head !== 'string' || !ids.has(ours) || !ids.has(head)) return bad
  if (base !== null && base !== undefined && typeof base !== 'string') return bad

  // Array.prototype.sort is stable.
  const sorted = [...(revisions as { id: string; modifiedTime: string }[])].sort((a, b) =>
    a.modifiedTime < b.modifiedTime ? -1 : a.modifiedTime > b.modifiedTime ? 1 : 0,
  )
  let target: 'base' | 'head'
  let candidates: string[]
  if (typeof base === 'string' && !ids.has(base)) {
    target = 'head'
    candidates = head !== ours ? [head] : []
  } else {
    target = 'base'
    const from = typeof base === 'string' ? sorted.findIndex((r) => r.id === base) + 1 : 0
    candidates = sorted.slice(from).map((r) => r.id).filter((id) => id !== ours)
  }
  if (candidates.length === 0) return { result: 'verified', download: [], target: null }
  if (round === 3) return { result: 'error', reason: 'verifyExhausted', download: [], target: null }
  return { result: 'merge', download: candidates, target }
}

export function backoffRule(input: unknown): { retry: true; delayMs: number } | { retry: false } | { error: 'invalidInput' } {
  if (!isObj(input)) return bad
  const { attempt, jitter } = input
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > 7) return bad
  if (typeof jitter !== 'number' || !(jitter >= 0 && jitter <= 1)) return bad
  if (attempt === 7) return { retry: false }
  const nominal = 1000 * 2 ** (attempt - 1)
  return { retry: true, delayMs: Math.min(32000, Math.floor(nominal * (0.5 + jitter))) }
}

export type SyncStateName = 'synced' | 'pending' | 'syncing' | 'conflict' | 'error'
const STATES = ['synced', 'pending', 'syncing', 'conflict', 'error']

const TABLE: Record<string, string> = {
  'synced edit': 'pending',
  'pending edit': 'pending',
  'syncing edit': 'syncing',
  'conflict edit': 'conflict',
  'error edit': 'error',
  'pending upload': 'syncing',
  'conflict upload': 'syncing',
  'synced remoteChange': 'syncing',
  'conflict remoteChange': 'syncing',
  'pending remoteChange': 'pending',
  'syncing remoteChange': 'syncing',
  'error remoteChange': 'error',
  'synced failed': 'error',
  'pending failed': 'error',
  'syncing conflictFound': 'conflict',
  'syncing failed': 'error',
  'error retry': 'pending',
}

export function transitionRule(input: Obj): { state: SyncStateName } | { error: 'illegalTransition' | 'invalidInput' } {
  const key = `${String(input.state)} ${String(input.event)}`
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
  let to: string | undefined = Object.hasOwn(TABLE, key) ? TABLE[key] : undefined
  if (key === 'syncing verified' || key === 'conflict verified') {
    if (!int(input.unresolved)) return bad
    const unsent = input.unsent ?? false
    if (typeof unsent !== 'boolean') return bad
    to = (input.unresolved as number) > 0 ? 'conflict' : unsent ? 'pending' : 'synced'
  } else if (key === 'conflict resolve') {
    if (!int(input.unresolved)) return bad
    to = (input.unresolved as number) > 0 ? 'conflict' : 'pending'
  }
  return to === undefined ? { error: 'illegalTransition' } : { state: to as SyncStateName }
}

export type DisplayLabel = 'saved' | 'pending' | 'offline' | 'saving' | 'receiving' | 'twoVersions' | 'notSaved'

export function displayRule(input: Obj): { label: DisplayLabel } | { error: 'invalidInput' } {
  const { state, cause, platform, online } = input
  if (typeof state !== 'string' || !STATES.includes(state)) return bad
  if (platform !== 'android' && platform !== 'web') return bad
  if (typeof online !== 'boolean') return bad
  if (state === 'syncing' && cause !== 'upload' && cause !== 'remote') return bad
  switch (state) {
    case 'synced': return { label: 'saved' }
    case 'pending': return { label: platform === 'android' && !online ? 'offline' : 'pending' }
    case 'syncing': return { label: cause === 'remote' ? 'receiving' : 'saving' }
    case 'conflict': return { label: 'twoVersions' }
    default: return { label: 'notSaved' }
  }
}

/** Spec sync.stateMachine: `op` picks `transition` or `display`. */
export function stateMachineRule(input: unknown) {
  if (!isObj(input)) return bad
  if (input.op === 'transition') return transitionRule(input)
  if (input.op === 'display') return displayRule(input)
  return bad
}

/** The next state for `event`, or null when the pair is illegal. */
export function transition(
  state: string,
  event: string,
  extra: { unresolved?: number; unsent?: boolean } = {},
): SyncStateName | null {
  const r = transitionRule({ state, event, ...extra })
  return 'state' in r ? r.state : null
}

/** Known revision ids kept per note (`sync.staleHead`). */
export const KNOWN_MAX = 20

/** `sync.staleHead`: `{ known, base, head }` decides; `{ known, add }` remembers. */
export function staleHeadRule(input: unknown): { result: 'skip' | 'receive' } | { known: string[] } | { error: 'invalidInput' } {
  if (!isObj(input)) return bad
  const { known, base, head, add } = input
  if (!Array.isArray(known) || !known.every((k) => typeof k === 'string')) return bad
  if (add !== undefined) {
    if (!Array.isArray(add) || !add.every((k) => typeof k === 'string')) return bad
    const out = [...known]
    for (const id of add) if (!out.includes(id)) out.push(id)
    return { known: out.slice(-KNOWN_MAX) }
  }
  if (typeof head !== 'string' || (base !== null && typeof base !== 'string')) return bad
  // No base (file gone): the note must re-receive, whatever it knows.
  if (base === null) return { result: 'receive' }
  return { result: head === base || known.includes(head) ? 'skip' : 'receive' }
}
