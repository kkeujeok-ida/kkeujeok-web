// The status store of the sync display (Story 3.16): what it reads, when, and that it
// leaves nothing running once disposed.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { emptySync } from '../src/storage/syncInfo'
import { emitSyncChanged, onSyncChanged } from '../src/sync/syncSignal'
import { STATUS_DELAY_MS, createSyncStatus } from '../src/sync/syncStatus'
import { NID, mkNote } from './uploadHarness'

// IndexedDB answers in real time; only the status store's timers are fake.
const real = async () => {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r))
}
const N2 = '01926f3a-0000-7000-8000-0000000000a2'
afterEach(async () => {
  vi.useRealTimers()
  await deleteNoteDatabase()
})

describe('the signal', () => {
  test('every successful write of the note store names its note', async () => {
    const seen: string[] = []
    const off = onSyncChanged((id) => void seen.push(id))
    const store = openNoteStore()
    const n = mkNote()
    await store.writeNote(n)
    await store.updateSync(NID, (c) => ({ ...c, state: 'error' }))
    await store.commitSync(n, n, { ...emptySync(), fileId: 'f', baseHeadRevisionId: 'rev1', state: 'synced' })
    expect(seen).toEqual([NID, NID, NID])
    off()
    store.close()
  })

  test('a failed write names nothing', async () => {
    const seen: string[] = []
    const off = onSyncChanged((id) => void seen.push(id))
    const store = openNoteStore()
    await expect(store.updateSync('missing', (c) => c)).rejects.toThrow()
    expect(seen).toEqual([])
    off()
    store.close()
  })
})

describe('the store', () => {
  let store: ReturnType<typeof openNoteStore>
  beforeEach(() => void (store = openNoteStore()))
  afterEach(() => store.close())

  test('refreshAll reads every note: unsent, synced and an error with its class', async () => {
    await store.writeNote(mkNote())
    const synced = mkNote({ noteId: N2 })
    await store.commitSync(synced, synced, { ...emptySync(), fileId: 'f', baseHeadRevisionId: 'rev1', state: 'synced' })
    await store.updateSync(NID, (c) => ({ ...c, state: 'error', lastError: { class: 'quota', status: 403, reason: 'storageQuotaExceeded' } }))
    const s = createSyncStatus({ store })
    expect(s.getSnapshot().loaded).toBe(false)
    await s.refreshAll()
    const snap = s.getSnapshot()
    expect(snap.loaded).toBe(true)
    expect(snap.notes.get(NID)).toEqual({ fileId: null, state: 'error', hasUnsent: true, lastError: { class: 'quota', status: 403, reason: 'storageQuotaExceeded' } })
    expect(snap.notes.get(N2)).toEqual({ fileId: 'f', state: 'synced', hasUnsent: false, lastError: null })
    expect(s.anyUnsent()).toBe(true)
    s.dispose()
  })

  test('anyUnsent is false when everything is on Drive', async () => {
    const n = mkNote()
    await store.commitSync(n, n, { ...emptySync(), fileId: 'f', baseHeadRevisionId: 'rev1', state: 'synced' })
    const s = createSyncStatus({ store })
    await s.refreshAll()
    expect(s.anyUnsent()).toBe(false)
    s.dispose()
  })

  test('a change is read at once, and only that note; changes inside the delay are read once together', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const reads: string[] = []
    const fake = {
      listIds: async () => [],
      readSync: async (id: string) => {
        reads.push(id)
        return { ...(await store.readSync(id)) }
      },
    }
    const handlers = new Set<(id: string) => void>()
    const s = createSyncStatus({ store: fake, signal: (fn) => (handlers.add(fn), () => void handlers.delete(fn)) })
    await store.writeNote(mkNote())
    handlers.forEach((h) => h(NID))
    await real()
    expect(reads).toEqual([NID])
    expect(s.getSnapshot().notes.get(NID)?.hasUnsent).toBe(true)
    handlers.forEach((h) => h(NID))
    handlers.forEach((h) => h(NID))
    handlers.forEach((h) => h(N2))
    await real()
    expect(reads).toEqual([NID]) // still inside the delay
    await vi.advanceTimersByTimeAsync(STATUS_DELAY_MS)
    await real()
    expect(reads.sort()).toEqual([NID, NID, N2].sort())
    s.dispose()
  })

  test('subscribers hear only real changes', async () => {
    await store.writeNote(mkNote())
    const s = createSyncStatus({ store })
    let n = 0
    s.subscribe(() => n++)
    await s.refreshAll()
    await s.refreshAll()
    expect(n).toBe(1)
    s.dispose()
  })

  test('refreshAll is single-flight', async () => {
    let lists = 0
    const s = createSyncStatus({ store: { listIds: async () => (lists++, []), readSync: store.readSync } })
    await Promise.all([s.refreshAll(), s.refreshAll(), s.refreshAll()])
    expect(lists).toBe(1)
    s.dispose()
  })

  test('after dispose: no timer, no listener, a read that lands later publishes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const handlers = new Set<(id: string) => void>()
    const s = createSyncStatus({
      store: { listIds: async () => [NID], readSync: async (id) => (await gate, store.readSync(id)) },
      signal: (fn) => (handlers.add(fn), () => void handlers.delete(fn)),
    })
    await store.writeNote(mkNote())
    let heard = 0
    s.subscribe(() => heard++)
    handlers.forEach((h) => h(NID)) // a read is in flight and the delay timer runs
    void s.refreshAll()
    s.dispose()
    expect(handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    release()
    await real()
    expect(heard).toBe(0)
    expect(s.getSnapshot().version).toBe(0)
    handlers.forEach((h) => h(NID)) // nothing is listening
    expect(vi.getTimerCount()).toBe(0)
  })

  test('emitSyncChanged reaches the default feed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const s = createSyncStatus({ store })
    await store.writeNote(mkNote())
    emitSyncChanged(NID)
    await real()
    expect(s.getSnapshot().notes.has(NID)).toBe(true)
    s.dispose()
  })
})
