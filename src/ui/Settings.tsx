import { useEffect, useRef } from 'react'
import { useI18n, type Choice, type Key } from '../i18n'

const CHOICES: { value: Choice; label: Key }[] = [
  { value: 'system', label: 'settings.language.system' },
  { value: 'ko', label: 'settings.language.ko' },
  { value: 'en', label: 'settings.language.en' },
]

// Logout and disconnect are added by Story 1.12.
export function Settings({ onClose }: { onClose: () => void }) {
  const { t, choice, setChoice } = useI18n()
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
    </section>
  )
}
