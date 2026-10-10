import { useEffect, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import type { Auth } from '../drive/auth'

export function SignIn({ auth, notice }: { auth: Auth; notice: 'denied' | 'network' | 'unconfigured' | null }) {
  const { t } = useI18n()
  const busy = useSyncExternalStore(auth.subscribe, () => auth.getState().busy)
  useEffect(() => auth.preload(), [auth])
  const go = () => void auth.signIn()
  return (
    <main className="signin">
      <h1>{t('app.name')}</h1>
      <button type="button" className="btn" onClick={go} disabled={busy} aria-busy={busy}>
        {t('signin.google')}
      </button>
      <p>{t('signin.storage')}</p>
      <div aria-live="polite" className="signin-notice">
        {notice === 'denied' && (
          <>
            <p className="signin-error">{t('signin.denied.title')}</p>
            <p>{t('signin.denied.body')}</p>
            <button type="button" className="btn" onClick={go} disabled={busy} aria-busy={busy}>
              {t('signin.denied.retry')}
            </button>
          </>
        )}
        {notice === 'network' && (
          <>
            <p className="signin-error">{t('signin.network')}</p>
            <button type="button" className="btn" onClick={go} disabled={busy} aria-busy={busy}>
              {t('signin.network.retry')}
            </button>
          </>
        )}
        {notice === 'unconfigured' && <p className="signin-error">{t('signin.unconfigured')}</p>}
      </div>
      <p>
        <a href="/privacy">{t('settings.privacy')}</a>
      </p>
    </main>
  )
}
