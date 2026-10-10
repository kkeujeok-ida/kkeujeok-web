import { useEffect } from 'react'
import { useI18n, type Key } from '../i18n'

export const PRIVACY_PATH = '/privacy'
export const CONTACT_URL = 'https://github.com/kkeujeok-ida/kkeujeok-web/issues'
const PERMISSIONS_URL = 'https://myaccount.google.com/permissions'

// "/privacy" and "/privacy/" only.
export const isPrivacyPath = (pathname: string) => pathname.replace(/\/+$/, '') === PRIVACY_PATH

const SECTIONS = ['storage', 'scope', 'noserver', 'encryption', 'revoke', 'contact'] as const

export function PrivacyPolicy() {
  const { t } = useI18n()
  const title = t('privacy.title')
  useEffect(() => {
    document.title = title
  }, [title])
  return (
    <main className="privacy">
      <h1>{title}</h1>
      {SECTIONS.map((s) => (
        <section key={s}>
          <h2>{t(`privacy.${s}.heading` as Key)}</h2>
          <p>{t(`privacy.${s}.body` as Key)}</p>
          {s === 'revoke' && (
            <p>
              <a href={PERMISSIONS_URL} target="_blank" rel="noopener noreferrer">
                {t('privacy.revoke.link')}
              </a>
            </p>
          )}
          {s === 'contact' && (
            <p>
              <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
                {CONTACT_URL}
              </a>
            </p>
          )}
        </section>
      ))}
    </main>
  )
}
