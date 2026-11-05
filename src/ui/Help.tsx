import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { POINTER_ROWS, SHORTCUT_GROUPS, type HelpRow } from './helpData'
import { ShortcutSheet } from './ShortcutSheet'

export function HelpList({ rows }: { rows: HelpRow[] }) {
  const { t } = useI18n()
  return (
    <dl className="help-list">
      {rows.map((r) => (
        <div key={r.keys + r.label} className="help-row">
          <dt>
            <kbd>{r.keys}</kbd>
          </dt>
          <dd>{t(r.label)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Static help page (opened from Settings, never on its own): pen-only mode, pointers and shortcuts. */
export function Help({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const title = useRef<HTMLHeadingElement>(null)
  const [sheet, setSheet] = useState(false)
  useEffect(() => title.current?.focus(), [])
  return (
    <section className="settings help" aria-labelledby="help-title">
      <header className="settings-header">
        <h1 id="help-title" ref={title} tabIndex={-1}>
          {t('help.title')}
        </h1>
        <button type="button" className="btn" onClick={onClose}>
          {t('help.back')}
        </button>
      </header>
      <section className="settings-group" aria-labelledby="help-pen">
        <h2 id="help-pen">{t('help.penOnly.title')}</h2>
        <p>{t('help.penOnly.body')}</p>
      </section>
      <section className="settings-group" aria-labelledby="help-ptr">
        <h2 id="help-ptr">{t('help.pointers')}</h2>
        <HelpList rows={POINTER_ROWS} />
      </section>
      <section className="settings-group" aria-labelledby="help-keys">
        <h2 id="help-keys">{t('help.shortcuts')}</h2>
        <button type="button" className="btn" onClick={() => setSheet(true)}>
          {t('help.openSheet')}
        </button>
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title}>
            <h3>{t(g.title)}</h3>
            <HelpList rows={g.rows} />
          </div>
        ))}
      </section>
      {sheet && <ShortcutSheet onClose={() => setSheet(false)} />}
    </section>
  )
}
