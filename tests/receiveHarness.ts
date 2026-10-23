// Shared setup for the receive tests (Story 3.14): the upload harness plus a receiver
// over the same store, fake Drive and log, and "another device" helpers.
import { listSummaryRule } from '../src/drive/noteSummary'
import { encodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { emptySync } from '../src/storage/syncInfo'
import { type Channel, KKJ_MIME, type ReceiverDeps, createNoteReceiver } from '../src/sync/noteReceiver'
import { type Env, NID, makeEnv, md5Of } from './uploadHarness'

export type RxEnv = Env & {
  receiver: ReturnType<typeof createNoteReceiver>
  acct: { current: { sub: string; email: string } | null }
  posted: unknown[]
  /** Another device uploads `note` (a create when `fileId` is undefined). */
  remoteUpload(note: Note, o?: { fileId?: string; noSummary?: boolean }): Promise<{ fileId: string; head: string }>
  /** This browser has `note` as an uploaded, synced note (working = base = Drive head). */
  seedSynced(note: Note): Promise<{ fileId: string; head: string }>
  mk(o?: Partial<ReceiverDeps>): ReturnType<typeof createNoteReceiver>
}

export async function makeRxEnv(o: Partial<ReceiverDeps> = {}): Promise<RxEnv> {
  const env = await makeEnv()
  const acct: RxEnv['acct'] = { current: { sub: 'sub-1', email: 'a@example.test' } }
  const posted: unknown[] = []
  const channel: Channel = { post: (m) => void posted.push(m), subscribe: () => () => {} }
  const mk = (extra: Partial<ReceiverDeps> = {}) =>
    createNoteReceiver({
      store: env.store,
      drive: env.drive,
      device: env.device,
      remote: env.store.remote,
      log: env.deps.log,
      merge: env.deps.merge,
      account: () => acct.current,
      allowed: () => env.flags.allowed,
      online: () => env.flags.online,
      sleep: env.deps.sleep,
      jitter: () => 0.5,
      locks: undefined,
      channel,
      ...o,
      ...extra,
    })
  const remoteUpload: RxEnv['remoteUpload'] = async (note, u = {}) => {
    const bytes = await encodeKkj(note)
    const sum = md5Of(bytes)
    const s = listSummaryRule({ op: 'write', note, md5: sum }) as { name: string; appProperties: Record<string, string | null> }
    const props = { ...s.appProperties, ...(u.noSummary && { kkjV: null, kkjMd5: null, kkjCover: null, kkjEdited: null }) }
    const f = await env.drive.uploadSimple({
      ...(u.fileId !== undefined && { fileId: u.fileId }),
      metadata: { name: s.name, appProperties: props, ...(u.fileId === undefined && { mimeType: KKJ_MIME, parents: ['ROOT'] }) },
      bytes,
    })
    return { fileId: f.id, head: f.headRevisionId! }
  }
  const seedSynced: RxEnv['seedSynced'] = async (note) => {
    const up = await remoteUpload(note)
    await env.store.commitReceive(note.noteId, null, note, { ...emptySync(), fileId: up.fileId, baseHeadRevisionId: up.head, state: 'synced' }, emptySync())
    return up
  }
  return { ...env, receiver: mk(), acct, posted, remoteUpload, seedSynced, mk }
}

export { NID }
