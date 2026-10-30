// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { backoffReason, checkLogEntry, logWhy } from '../src/sync/syncLogEntry'
import { LOG_STORE, SYNC_LOG_DB, createSyncLog, syncLogKeep } from '../src/sync/syncLog'

const NOTE = '01926f3a-0000-7000-8000-000000000900'
const fixed = () => new Date('2026-10-10T04:20:00.000Z')

let log: ReturnType<typeof createSyncLog>
beforeEach(() => {
  log = createSyncLog(indexedDB, fixed)
})
afterEach(async () => {
  log.close()
  vi.restoreAllMocks()
  await new Promise<void>((res) => {
    const r = indexedDB.deleteDatabase(SYNC_LOG_DB)
    r.onsuccess = r.onerror = () => res()
  })
})

// Adds rows straight into the store, in one transaction.
function seed(rows: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(SYNC_LOG_DB)
    r.onupgradeneeded = () => r.result.createObjectStore(LOG_STORE, { autoIncrement: true })
    r.onsuccess = () => {
      const db = r.result
      const tx = db.transaction(LOG_STORE, 'readwrite')
      for (const row of rows) tx.objectStore(LOG_STORE).add(row)
      tx.oncomplete = () => (db.close(), resolve())
      tx.onerror = () => reject(tx.error)
    }
  })
}
const entryN = (i: number) => ({ at: '2026-10-10T04:20:00.000Z', event: 'verifyRound', noteId: NOTE, round: 1, count: i })

describe('append', () => {
  test('stamps at, stores the entry, entries() returns it', async () => {
    expect(await log.append('stateChange', { noteId: NOTE, from: 'pending', to: 'syncing' })).toBe(true)
    expect(await log.entries()).toEqual([
      { noteId: NOTE, from: 'pending', to: 'syncing', at: '2026-10-10T04:20:00.000Z', event: 'stateChange' },
    ])
  })

  test('invalid entries return false and are not stored', async () => {
    expect(await log.append('stateChange', { noteId: NOTE, from: 'pending', to: 'syncing', title: 'secret' })).toBe(false)
    expect(await log.append('stateChange', { noteId: 'x', from: 'pending', to: 'syncing' })).toBe(false)
    expect(await log.append('nope')).toBe(false)
    expect(await log.append('uploadStarted', { noteId: NOTE })).toBe(false)
    expect(await log.entries()).toEqual([])
  })

  test('a caller cannot override at or event', async () => {
    await log.append('pageTokenRejected', { at: '1999-01-01T00:00:00.000Z', event: 'merged' })
    expect(await log.entries()).toEqual([{ at: '2026-10-10T04:20:00.000Z', event: 'pageTokenRejected' }])
  })

  test('a reason outside its domain becomes other and is stored; a valid one stays', async () => {
    expect(await log.append('error', { class: 'fatal', reason: 'has space' })).toBe(true)
    expect(await log.append('error', { class: 'fatal', reason: 'x'.repeat(65) })).toBe(true)
    expect(await log.append('error', { class: 'quota', reason: 'storageQuotaExceeded' })).toBe(true)
    expect((await log.entries()).map((e) => e.reason)).toEqual(['other', 'other', 'storageQuotaExceeded'])
  })

  test('error cause and exception round-trip; a bad cause becomes unknown, the exception a clean name', async () => {
    expect(await log.append('error', { class: 'backoff', noteId: NOTE, cause: 'network', exception: 'DriveError.network', scope: 'note' })).toBe(true)
    expect(await log.append('error', { class: 'fatal', cause: 'weird', exception: 'Bad Name<T>' + 'x'.repeat(80) })).toBe(true)
    const [a, b] = await log.entries()
    expect(a).toMatchObject({ cause: 'network', exception: 'DriveError.network', scope: 'note' })
    expect(b!.cause).toBe('unknown')
    expect(String(b!.exception)).toHaveLength(64)
    expect(String(b!.exception).startsWith('Bad_Name_T_')).toBe(true)
    expect(checkLogEntry({ at: '2026-10-10T04:20:00.000Z', event: 'error', class: 'fatal', cause: 'x' })).toEqual({ ok: false, reason: 'badValue', field: 'cause' })
  })

  test('logWhy derives the cause from status, class, reason or error', () => {
    const drive = (kind: string) => Object.assign(new Error('m'), { name: 'DriveError', kind })
    expect(logWhy('backoff', { status: 503, error: drive('http') })).toEqual({ cause: 'server', exception: 'DriveError.http', scope: 'global' })
    expect(logWhy('x', { error: drive('network'), noteId: NOTE })).toEqual({ cause: 'network', exception: 'DriveError.network', scope: 'note' })
    expect(logWhy('x', { error: new TypeError('Failed to fetch') })).toEqual({ cause: 'network', exception: 'TypeError', scope: 'global' })
    expect(logWhy('quota', { status: 403 }).cause).toBe('quota')
    expect(logWhy('fatal', { status: 403, reason: 'storageQuotaExceeded' }).cause).toBe('quota')
    expect(logWhy('reauth', { status: 401 }).cause).toBe('auth')
    expect(logWhy('fatal', { reason: 'x' })).toEqual({ cause: 'unknown', scope: 'global' })
  })

  test('never throws when the store is broken', async () => {
    const broken = createSyncLog({ open: () => { throw new Error('no idb') } } as unknown as IDBFactory, fixed)
    expect(await broken.append('pageTokenRejected')).toBe(false)
    await expect(broken.exportJsonl({ appVersion: '1', now: fixed() })).rejects.toThrow()
  })
})

describe('retention', () => {
  test('an old-shape stored entry reads without error', async () => {
    await seed([{ at: '2026-10-10T04:00:00.000Z', event: 'error', class: 'quota' }, { at: '2026-10-10T04:01:00.000Z', event: 'stateChange', noteId: NOTE, from: 'error', to: 'pending' }])
    expect(await log.entries()).toHaveLength(2)
  })

  test('logWhy: only fetch-like TypeErrors are network', () => {
    expect(logWhy('backoff', { error: new TypeError('Failed to fetch') }).cause).toBe('network')
    expect(logWhy('fatal', { error: new TypeError('x is not a function') }).cause).toBe('unknown')
  })

  test('the 5,001st append drops the oldest', async () => {
    await seed(Array.from({ length: syncLogKeep }, (_, i) => entryN(i)))
    expect(await log.append('verifyRound', { noteId: NOTE, round: 2, count: 99 })).toBe(true)
    const e = await log.entries()
    expect(e).toHaveLength(syncLogKeep)
    expect(e[0]!.count).toBe(1) // the oldest (0) is gone
    expect(e.at(-1)).toMatchObject({ round: 2, count: 99 })
  })

  test('a failed trim still returns true; export shows the newest 5,000', async () => {
    await seed(Array.from({ length: syncLogKeep }, (_, i) => entryN(i)))
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
      throw new Error('trim failed')
    })
    expect(await log.append('verifyRound', { noteId: NOTE, round: 2, count: 99 })).toBe(true)
    vi.restoreAllMocks()
    const e = await log.entries() // 5,001 stored, newest 5,000 shown
    expect(e).toHaveLength(syncLogKeep)
    expect(e.at(-1)).toMatchObject({ count: 99 })
    const { text } = await log.exportJsonl({ appVersion: '1', now: fixed() })
    expect(text.trim().split('\n')).toHaveLength(syncLogKeep + 1)
  })

  test('more than 5,000 stored rows: only the newest 5,000 are read', async () => {
    await seed(Array.from({ length: syncLogKeep + 100 }, (_, i) => entryN(i)))
    const e = await log.entries()
    expect(e).toHaveLength(syncLogKeep)
    expect(e[0]!.count).toBe(100)
  })
})

test('new diagnostic fields round-trip; a bad one is refused or normalised', async () => {
  const base = { noteId: NOTE, from: 'error', to: 'pending' }
  expect(await log.append('stateChange', { ...base, reason: 'userRetry' })).toBe(true)
  expect(await log.append('stateChange', { ...base, reason: 'a b' })).toBe(true)
  expect(await log.append('backoff', { class: 'backoff', attempt: 1, delayMs: 0, scope: 'global' })).toBe(true)
  expect(await log.append('backoff', { class: 'backoff', attempt: 1, delayMs: 0 })).toBe(true)
  expect(await log.append('backoff', { class: 'backoff', attempt: 1, delayMs: 0, scope: 'x' })).toBe(false)
  expect(await log.append('conflictResolved', { noteId: NOTE, choice: 'both' })).toBe(true)
  expect(await log.append('conflictResolved', { noteId: NOTE, choice: 'x' })).toBe(false)
  const e = await log.entries()
  expect(e).toHaveLength(5)
  expect(e[1]!.reason).toBe('other')
})

describe('repeatedFailure', () => {
  const fail = (reason: string) => log.append('error', { class: 'backoff', noteId: NOTE, reason })
  const repeated = async () => (await log.entries()).filter((e) => e.event === 'repeatedFailure')

  test('the 4th failure in a row adds a line; synced resets', async () => {
    for (let i = 0; i < 3; i++) await fail('a')
    expect(await repeated()).toHaveLength(0)
    await fail('headMoved')
    await fail('headMoved')
    const r = await repeated()
    expect(r.map((e) => e.count)).toEqual([4, 5])
    expect(r[0]).toMatchObject({ reason: 'headMoved', noteId: NOTE })
    await log.append('stateChange', { noteId: NOTE, from: 'syncing', to: 'synced' })
    await fail('a')
    expect(await repeated()).toHaveLength(2)
  })

  test('a backoff keeps reason and stage; a bad stage is refused', async () => {
    expect(await log.append('backoff', { class: 'backoff', attempt: 1, delayMs: 1000, reason: 'http429', stage: 'download' })).toBe(true)
    expect(await log.append('backoff', { class: 'backoff', attempt: 1, delayMs: 1000, stage: 'x' })).toBe(false)
    expect(backoffReason({ status: 429, kind: 'http' })).toBe('http429')
    expect(backoffReason({ kind: 'network' })).toBe('network')
  })
})

describe('export', () => {
  test('0 entries: the header line only', async () => {
    const f = await log.exportJsonl({ appVersion: '1.2.3', buildId: '42', buildNumber: '7', now: new Date('2026-10-16T23:59:59.999Z') })
    expect(f.name).toBe('kkeujeok-sync-log-2026-10-16.jsonl')
    expect(f.text.endsWith('\n')).toBe(true)
    expect(f.text.charCodeAt(0)).not.toBe(0xfeff)
    const lines = f.text.split('\n')
    expect(lines).toHaveLength(2)
    const header = JSON.parse(lines[0]!)
    expect(header.deviceLabel).toMatch(/^[0-9a-f]{8}$/)
    delete header.deviceLabel
    expect(header).toEqual({
      type: 'header',
      app: 'kkeujeok',
      appVersion: '1.2.3',
      buildId: '42',
      buildNumber: '7',
      platform: 'web',
      supportedFormatVersion: 1,
      exportedAt: '2026-10-16T23:59:59.999Z',
    })
  })

  test('entries follow oldest first, each as stored; broken rows are skipped', async () => {
    await log.append('pageTokenRejected')
    await seed([null, 'text', { at: 'bad', event: 'x' }, [1], { ...entryN(7), title: 'secret' }])
    await log.append('duplicatesCleaned', { count: 2 })
    const { text } = await log.exportJsonl({ appVersion: '1', now: fixed() })
    const lines = text.split('\n').slice(1, -1).map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { at: '2026-10-10T04:20:00.000Z', event: 'pageTokenRejected' },
      { at: '2026-10-10T04:20:00.000Z', event: 'duplicatesCleaned', count: 2 },
    ])
  })

  test('the file name uses the UTC date', async () => {
    const f = await log.exportJsonl({ appVersion: '1', now: new Date('2026-10-17T00:30:00+09:00') })
    expect(f.name).toBe('kkeujeok-sync-log-2026-10-16.jsonl')
  })
})
