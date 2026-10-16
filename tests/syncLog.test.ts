// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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

  test('never throws when the store is broken', async () => {
    const broken = createSyncLog({ open: () => { throw new Error('no idb') } } as unknown as IDBFactory, fixed)
    expect(await broken.append('pageTokenRejected')).toBe(false)
    await expect(broken.exportJsonl({ appVersion: '1', now: fixed() })).rejects.toThrow()
  })
})

describe('retention', () => {
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

describe('export', () => {
  test('0 entries: the header line only', async () => {
    const f = await log.exportJsonl({ appVersion: '1.2.3', now: new Date('2026-10-16T23:59:59.999Z') })
    expect(f.name).toBe('kkeujeok-sync-log-2026-10-16.jsonl')
    expect(f.text.endsWith('\n')).toBe(true)
    expect(f.text.charCodeAt(0)).not.toBe(0xfeff)
    const lines = f.text.split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'header',
      app: 'kkeujeok',
      appVersion: '1.2.3',
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
