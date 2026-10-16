// Spec `sync.errorClass`: classifies one failed or finished call. Never throws.
import type { DriveError } from '../drive/driveClient'

export type ErrorClassResult = { class: string } | { error: 'invalidInput' }

export function errorClassRule(input: Record<string, unknown>): ErrorClassResult {
  const bad = { error: 'invalidInput' } as const
  const reason = input.reason
  if (reason != null && typeof reason !== 'string') return bad
  switch (input.kind) {
    case 'network': return { class: 'backoff' }
    case 'parse': return { class: 'unreadable' }
    case 'trashed': return { class: 'deleted' }
    case 'http': {
      const s = input.status
      if (typeof s !== 'number' || !Number.isInteger(s) || s < 100 || s > 599) return bad
      return { class: httpClass(s, reason as string | null | undefined) }
    }
    default: return bad
  }
}

function httpClass(s: number, reason: string | null | undefined): string {
  if ((s >= 200 && s <= 299) || s === 308) return 'ok'
  if (s === 401) return 'reauth'
  if (s === 400 && reason === 'invalid_grant') return 'reauth'
  if (s === 403) {
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') return 'backoff'
    return reason === 'storageQuotaExceeded' ? 'quota' : 'fatal'
  }
  if (s === 404) return 'deleted'
  if (s === 408 || s === 429 || s >= 500) return 'backoff'
  return 'fatal'
}

/** The class of a failed Drive call; `fatal` for anything unclassifiable. */
export function classifyDriveError(e: DriveError): string {
  const r = errorClassRule({
    kind: e.kind,
    ...(e.status !== undefined && { status: e.status }),
    reason: e.reason ?? null,
  })
  return 'class' in r && r.class !== 'ok' ? r.class : 'fatal'
}
