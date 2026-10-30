import { useRef, useState } from 'react'
import { fmt, useI18n } from '../i18n'
import { colorNameKey, type PenTool } from '../model/pen'
import { PALETTE_MAX, sharedPenPalette } from '../storage/penPalette'
import { ColorWheelPicker } from './library/ColorWheelPicker'

const TOOLS: PenTool[] = ['pen', 'highlighter']

/** Settings: per tool, add / remove / reorder palette colors or reset them. Every change is stored at once. */
export function PenPaletteEditor() {
  const { t } = useI18n()
  const [lists, setLists] = useState(() => ({ pen: sharedPenPalette().read('pen'), highlighter: sharedPenPalette().read('highlighter') }))
  const [adding, setAdding] = useState<PenTool | null>(null)
  const picked = useRef('#000000')
  const save = (tool: PenTool, next: string[]) => setLists((l) => ({ ...l, [tool]: sharedPenPalette().write(tool, next) }))
  const name = (hex: string) => (colorNameKey(hex) === 'editor.colorCustom' ? hex : t(colorNameKey(hex)))
  return (
    <div className="settings-group" role="group" aria-labelledby="palette-label">
      <span id="palette-label">{t('settings.palette')}</span>
      {TOOLS.map((tool) => {
        const list = lists[tool]
        const full = list.length >= PALETTE_MAX
        const move = (i: number, d: number) => {
          const next = [...list]
          next.splice(i + d, 0, next.splice(i, 1)[0]!)
          save(tool, next)
        }
        return (
          <div key={tool} role="group" aria-label={t(`editor.tool.${tool}`)} className="palette-editor">
            <strong>{t(`editor.tool.${tool}`)}</strong>
            <ul className="palette-editor-list">
              {list.map((hex, i) => (
                <li key={hex} className="palette-editor-item">
                  <span className="palette-editor-swatch" style={{ background: hex }} role="img" aria-label={name(hex)} />
                  <button type="button" className="btn" disabled={i === 0} aria-label={fmt(t('settings.paletteEarlier'), { color: name(hex) })} onClick={() => move(i, -1)}>
                    ‹
                  </button>
                  <button type="button" className="btn" disabled={i === list.length - 1} aria-label={fmt(t('settings.paletteLater'), { color: name(hex) })} onClick={() => move(i, 1)}>
                    ›
                  </button>
                  <button type="button" className="btn" disabled={list.length <= 1} aria-label={fmt(t('settings.paletteRemove'), { color: name(hex) })} onClick={() => save(tool, list.filter((c) => c !== hex))}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            {adding === tool ? (
              <ColorWheelPicker
                color={picked.current}
                onChange={(hex) => void (picked.current = hex)}
                onDone={() => {
                  if (!list.includes(picked.current)) save(tool, [...list, picked.current])
                  setAdding(null)
                }}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <div className="palette-editor-actions">
                <button type="button" className="btn" aria-disabled={full} onClick={() => {
                    if (full) return
                    picked.current = '#000000'
                    setAdding(tool)
                  }}>
                  {t('settings.paletteAdd')}
                </button>
                <button type="button" className="btn" onClick={() => setLists((l) => ({ ...l, [tool]: sharedPenPalette().reset(tool) }))}>
                  {t('settings.paletteReset')}
                </button>
              </div>
            )}
            {full && <p role="status">{t('settings.paletteFull')}</p>}
          </div>
        )
      })}
    </div>
  )
}
