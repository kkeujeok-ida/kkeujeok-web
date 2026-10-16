import { useEffect, useRef, useState } from 'react'
import { syncLog } from '../sync/syncLog'
import { useI18n, type Choice, type Key } from '../i18n'
import type { Auth } from '../drive/auth'
import { clearSessionHistories } from '../ops/sessionHistories'
import { deleteNoteDatabase } from '../storage/noteDb'
import { ConfirmDialog } from './ConfirmDialog'

const CHOICES: { value: Choice; label: Key }[] = [
  { value: 'system', label: 'settings.language.system' },
  { value: 'ko', label: 'settings.language.ko' },
  { value: 'en', label: 'settings.language.en' },
]

type Action = 'logout' | 'disconnect'

const defaultExport = () => syncLog().exportJsonl({ appVersion: __APP_VERSION__, now: new Date() })

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url))
}

// Shown only behind the sign-in gate, so logout and disconnect are always valid.
export function Settings({
  onClose,
  auth,
  exportLog = defaultExport,
}: {
  onClose: () => void
  auth: Auth
  exportLog?: () => Promise<{ name: string; text: string }>
}) {
  const { t, choice, setChoice } = useI18n()
  const [action, setAction] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Key | null>(null)
  // Once Google has revoked the grant, a retry must not revoke it again.
  const revoked = useRef(false)
  const buttons = { logout: useRef<HTMLButtonElement>(null), disconnect: useRef<HTMLButtonElement>(null) }
  const open = (a: Action) => {
    if (busy) return
    setError(null)
    setAction(a)
  }
  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      if (action === 'disconnect' && !revoked.current) {
        if ((await auth.disconnect()) !== 'revoked') return setError('signin.network')
        revoked.current = true
      }
      try {
        await deleteNoteDatabase()
      } catch {
        return setError('settings.deleteFailed')
      }
      clearSessionHistories() // undo history must not outlive the notes
      auth.signOut() // the gate shows the sign-in screen
    } finally {
      setBusy(false)
    }
  }
  const [exportFailed, setExportFailed] = useState(false)
  const exporting = useRef(false) // a second press while one runs is ignored
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  async function exportSyncLog() {
    if (exporting.current) return
    exporting.current = true
    setExportFailed(false)
    try {
      const { name, text } = await exportLog()
      download(name, text)
    } catch {
      if (mounted.current) setExportFailed(true)
    } finally {
      exporting.current = false
    }
  }
  // The view replaced the library: move focus to its heading so the change is announced.
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus(), [])
  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="settings-header">
        <h1 id="settings-title" ref={title} tabIndex={-1}>
          {t('settings.title')}
        </h1>
        <button type="button" className="btn" onClick={onClose}>
          {t('settings.close')}
        </button>
      </header>
      <fieldset className="settings-group">
        <legend>{t('settings.language')}</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="option">
            <input
              type="radio"
              name="language"
              value={c.value}
              checked={choice === c.value}
              onChange={() => setChoice(c.value)}
            />
            {/* Native names are read in their own language even inside the other UI language. */}
            <span lang={c.value === 'system' ? undefined : c.value}>{t(c.label)}</span>
          </label>
        ))}
      </fieldset>
      <a className="btn" href="/privacy" target="_blank" rel="noopener noreferrer">
        {t('settings.privacy')}
      </a>
      <div className="settings-group">
        <button type="button" className="btn" onClick={() => void exportSyncLog()}>
          {t('settings.syncLogExport')}
        </button>
        {exportFailed && <p role="alert">{t('settings.syncLogExportFailed')}</p>}
      </div>
      <div className="settings-group">
        <button ref={buttons.logout} type="button" className="btn" onClick={() => open('logout')}>
          {t('settings.logout')}
        </button>
        <button ref={buttons.disconnect} type="button" className="btn" onClick={() => open('disconnect')}>
          {t('settings.disconnect')}
        </button>
      </div>
      {action && (
        <ConfirmDialog
          body={t(action === 'logout' ? 'logout.confirm' : 'disconnect.confirm')}
          confirmLabel={t(error ? 'signin.network.retry' : action === 'logout' ? 'settings.logout' : 'settings.disconnect')}
          cancelLabel={t('dialog.cancel')}
          destructive={action === 'disconnect'}
          busy={busy}
          error={error && t(error)}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setAction(null)
            buttons[action].current?.focus() // back to the button that opened it
          }}
        />
      )}
    </section>
  )
}
