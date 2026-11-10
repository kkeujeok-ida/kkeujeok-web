import { useEffect, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import type { Auth } from '../drive/auth'

export function SignIn({ auth, notice }: { auth: Auth; notice: 'denied' | 'network' | 'unconfigured' | null }) {
  const { t } = useI18n()
  const busy = useSyncExternalStore(auth.subscribe, () => auth.getState().busy)
  useEffect(() => auth.preload(), [auth])
  const go = () => void auth.signIn()
  const spin = busy ? <span className="signin-spinner" aria-hidden="true" /> : null
  return (
    <main className="signin">
      <div className="signin-card">
        <img className="signin-logo" src="/favicon.png" alt="" aria-hidden="true" width="64" height="64" />
        <h1>{t('app.name')}</h1>
        <p className="signin-hint">{t('signin.storage')}</p>
        <button type="button" className="btn signin-google" onClick={go} disabled={busy} aria-busy={busy}>
          {spin ?? <GoogleG />}
          {t('signin.google')}
        </button>
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
        <a href="/privacy">{t('settings.privacy')}</a>
      </div>
    </main>
  )
}

// Google brand mark: its four colours are mandated by the brand guidelines, not theme tokens.
function GoogleG() {
  return (
    <svg className="signin-g" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.600-.1-3.100-.4-4.5H24v9h12.700c-.6 3-2.300 5.500-4.800 7.200l7.500 5.800c4.400-4.100 7.100-10.100 7.100-17.500z"/>
      <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.600.3-3.200.8-4.700l-7.900-6.100A24 24 0 0 0 0 24c0 3.900.9 7.500 2.600 10.800l7.900-6.100z"/>
      <path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.500-5.800c-2.100 1.400-4.800 2.300-8.400 2.300-6.300 0-11.600-4.200-13.500-9.900l-7.900 6.100C6.500 42.600 14.600 48 24 48z"/>
    </svg>
  )
}
