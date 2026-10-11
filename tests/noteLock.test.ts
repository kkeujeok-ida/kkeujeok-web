// The per-note Web Lock (story 2.13).
import { describe, expect, test } from 'vitest'
import { acquireNoteLock } from '../src/storage/noteLock'
import { fakeLocks } from './helpers'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('acquireNoteLock', () => {
  test('a free note is held; another note is independent', async () => {
    const locks = fakeLocks()
    const a = await acquireNoteLock('n1', locks)
    const b = await acquireNoteLock('n2', locks)
    expect([a.state, b.state]).toEqual(['held', 'held'])
  })

  test('a taken note waits and is granted when the holder releases', async () => {
    const locks = fakeLocks()
    const a = await acquireNoteLock('n1', locks)
    const b = await acquireNoteLock('n1', locks)
    expect(b.state).toBe('waiting')
    let granted = false
    void b.whenHeld.then(() => (granted = true))
    await tick()
    expect(granted).toBe(false)
    await a.release()
    await tick()
    expect(granted).toBe(true)
    expect(b.state).toBe('held')
    await b.release()
    expect((await acquireNoteLock('n1', locks)).state).toBe('held')
  })

  test('releasing while waiting aborts the request and never grants', async () => {
    const locks = fakeLocks()
    const a = await acquireNoteLock('n1', locks)
    const b = await acquireNoteLock('n1', locks)
    let granted = false
    void b.whenHeld.then(() => (granted = true))
    await b.release()
    await a.release()
    await tick()
    expect(granted).toBe(false)
    expect((await acquireNoteLock('n1', locks)).state).toBe('held')
  })

  test('a queued request that rejects without an abort counts as held', async () => {
    let calls = 0
    const locks = {
      request: (_n: string, _o: unknown, cb: (l: object | null) => unknown) => {
        if (++calls === 1) return Promise.resolve(cb(null)).then(() => {})
        return Promise.reject(new Error('gone'))
      },
    } as unknown as LockManager
    const l = await acquireNoteLock('n1', locks)
    expect(l.state).toBe('waiting')
    await l.whenHeld
    expect(l.state).toBe('held')
    await l.release()
  })

  test('no API, or a manager that throws: the tab is the writer', async () => {
    expect((await acquireNoteLock('n1', undefined)).state).toBe('held')
    const rejecting = { request: () => Promise.reject(new Error('denied')) } as unknown as LockManager
    const l = await acquireNoteLock('n1', rejecting)
    expect(l.state).toBe('held')
    await l.release()
    const throwing = {
      request: () => {
        throw new Error('nope')
      },
    } as unknown as LockManager
    expect((await acquireNoteLock('n1', throwing)).state).toBe('held')
  })
})
