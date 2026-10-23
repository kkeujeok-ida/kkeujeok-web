// Account-mismatch gate (Story 3.8, UX-DR64): when the signed-in account is not the
// one this browser's note data is tagged with, nothing below the gate (shell,
// uploads, receiving) runs until the user chooses.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Account, Auth } from '../drive/auth'
import { fmt, useI18n } from '../i18n'
import { encodeKkj } from '../model/kkjCodec'
import { clearSessionHistories } from '../ops/sessionHistories'
import { deleteNoteDatabase, openNoteDb } from '../storage/noteDb'
import type { NoteStore } from '../storage/noteStore'
import { createSyncDeviceStore, type SyncDeviceStore } from '../storage/syncDevice'
import { countUnsent, defaultUnsentStore } from '../sync/unsent'
import { downloadBlob } from './download'

export type GateDeps = {
  device: Pick<SyncDeviceStore, 'readState'>
  store: Pick<NoteStore, 'listIds' | 'readSync' | 'loadNote'>
  /** Deletes the note database; rejects when it cannot. */
  deleteData: () => Promise<void>
  saveFile: (name: string, bytes: Uint8Array) => void
  flush?: () => Promise<void>
}

let shared: GateDeps | undefined
export const defaultGateDeps = (): GateDeps =>
  (shared ??= {
    device: createSyncDeviceStore(openNoteDb()),
    store: defaultUnsentStore(),
    deleteData: async () => {
      await deleteNoteDatabase()
      clearSessionHistories() // undo history must not outlive the notes
    },
    saveFile: (name, bytes) => downloadBlob(name, bytes as BlobPart, 'application/octet-stream'),
  })

/** `a@…`: the first character of the address and the sign, the domain left out. */
export function maskEmail(email: string): string {
  const c = [...(email.split('@')[0] ?? '')][0]
  return c ? `${c}@…` : ''
}

export type Verdict =
  | { kind: 'ok' }
  | { kind: 'mismatch'; email: string; ids: string[] | null }
  | { kind: 'cleanFailed'; email: string }

/** Decides for the signed-in `account`; deletes the data itself when nothing unsent is lost. */
export async function checkAccount(account: Account, d: GateDeps, live: () => boolean): Promise<Verdict> {
  const rec = await d.device.readState()
  // Absent, unreadable, untagged or failed-to-read records name no other account: nothing is deleted on a doubt.
  if (rec.kind !== 'ok' || rec.device.sub === null || rec.device.sub === account.sub) return { kind: 'ok' }
  const email = rec.device.email ?? ''
  const ids = await countUnsent(d.store, d.flush)
  if (!live()) return { kind: 'ok' } // stale run: the caller drops the result
  if (ids !== null && ids.length === 0) {
    try {
      await d.deleteData()
    } catch {
      return { kind: 'cleanFailed', email }
    }
    return { kind: 'ok' }
  }
  return { kind: 'mismatch', email, ids }
}

export function AccountGate({ auth, deps, children }: { auth: Auth; deps?: GateDeps; children: ReactNode }) {
  const { account } = auth.getState()
  // The sub only: a silent re-auth changes the token, and must not remount the app.
  const key = account ? account.sub : null
  const [done, setDone] = useState<{ key: string; verdict: Verdict } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const rechecking = useRef(false) // a retry while one runs would stack

  useEffect(() => {
    if (!account || !key) return
    let live = true
    rechecking.current = true
    void checkAccount(account, deps ?? defaultGateDeps(), () => live)
      .then((verdict) => live && setDone({ key, verdict }))
      // A failed recheck keeps the verdict it had for this account; only a first check that fails opens.
      .catch(() => live && setDone((prev) => (prev?.key === key ? prev : { key, verdict: { kind: 'ok' } })))
      .finally(() => live && (rechecking.current = false))
    return () => void ((live = false), (rechecking.current = false))
    // `key` identifies the account of this run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, deps, attempt])

  if (!key) return <>{children}</> // account unknown: nothing to compare
  const v = done?.key === key ? done.verdict : null
  if (!v) return null // checking
  if (v.kind === 'ok') return <>{children}</>
  return (
    <MismatchDialog
      auth={auth}
      deps={deps ?? defaultGateDeps()}
      verdict={v}
      onDiscarded={() => setDone({ key, verdict: { kind: 'ok' } })}
      // The previous verdict stays on screen until the recheck replaces it.
      onRetry={() => !rechecking.current && setAttempt((n) => n + 1)}
    />
  )
}

function MismatchDialog({
  auth,
  deps,
  verdict,
  onDiscarded,
  onRetry,
}: {
  auth: Auth
  deps: GateDeps
  verdict: Exclude<Verdict, { kind: 'ok' }>
  onDiscarded: () => void
  onRetry: () => void
}) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  const ids = { title: useId(), body: useId() }
  const mounted = useRef(true)
  const working = useRef(false) // download or delete in flight: a second press is ignored
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<'downloadFailed' | 'cleanFailed' | null>(null)
  useEffect(() => {
    mounted.current = true
    first.current?.focus()
    return () => void (mounted.current = false)
  }, [])

  const unsentIds = verdict.kind === 'mismatch' ? verdict.ids : []
  const n = unsentIds?.length ?? null
  const masked = maskEmail(verdict.email)
  const account = masked ? `(${masked})` : ''

  // Esc does nothing: the user must choose. Tab stays inside.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') e.preventDefault()
    else if (e.key === 'Tab') {
      const items = [...box.current!.querySelectorAll<HTMLElement>('button')]
      const i = items.indexOf(document.activeElement as HTMLElement)
      e.preventDefault()
      items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length]?.focus()
    }
  }

  async function download() {
    if (working.current || !unsentIds) return
    working.current = true
    setError(null)
    let failed = false
    try {
      for (const id of unsentIds) {
        try {
          const note = (await deps.store.loadNote(id))?.note
          if (!note) {
            failed = true // unreadable working copy: nothing to export
            continue
          }
          const title = note.meta.title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'note'
          deps.saveFile(`${title}-${id.slice(0, 8)}.kkj`, await encodeKkj(note))
        } catch {
          failed = true
        }
      }
    } finally {
      working.current = false
    }
    if (failed && mounted.current) setError('downloadFailed')
  }

  async function discard() {
    if (working.current) return
    if (verdict.kind === 'mismatch' && !armed) return setArmed(true)
    working.current = true
    setError(null)
    try {
      await deps.deleteData()
      if (mounted.current) onDiscarded()
    } catch {
      if (mounted.current) setError('cleanFailed')
    } finally {
      working.current = false
    }
  }

  const title =
    verdict.kind === 'cleanFailed'
      ? t('mismatch.cleanFailed')
      : n === null
        ? fmt(t('mismatch.titleUnknown'), { account })
        : fmt(t('mismatch.title'), { account, n })
  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={ids.title} aria-describedby={ids.body}>
        <h2 id={ids.title} className="dialog-title">
          {title}
        </h2>
        <div id={ids.body} aria-live="polite" className="dialog-error">
          {error === 'downloadFailed' && t('mismatch.downloadFailed')}
          {error === 'cleanFailed' && t('mismatch.cleanFailed')}
        </div>
        <div className="dialog-actions">
          <button ref={first} type="button" className="btn" onClick={() => auth.signOut()}>
            {t('mismatch.back')}
          </button>
          {verdict.kind === 'mismatch' ? (
            <>
              <button type="button" className="btn" onClick={() => void download()}>
                {t('mismatch.download')}
              </button>
              <button type="button" className="btn btn-destructive" onClick={() => void discard()}>
                {armed ? t('unsent.armed') : n === null ? t('mismatch.discardUnknown') : fmt(t('mismatch.discard'), { n })}
              </button>
              <span className="sr-only" role="status">
                {armed ? t('unsent.armed') : ''}
              </span>
            </>
          ) : (
            <button type="button" className="btn" onClick={onRetry}>
              {t('mismatch.retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
