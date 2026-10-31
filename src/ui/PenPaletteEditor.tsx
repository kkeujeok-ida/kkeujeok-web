import { useRef, useState } from 'react'
import { fmt, useI18n } from '../i18n'
import { colorNameKey, type PenTool } from '../model/pen'
import { PALETTE_MAX, sharedPenPalette } from '../storage/penPalette'
import { ColorWheelPicker } from './library/ColorWheelPicker'

const TOOLS: PenTool[] = ['pen', 'highlighter']

/** Settings: per tool, add / remove / reorder palette colors or reset them. Every change is stored at once. Swatches only: drag one to move it, click it to show its remove button, Alt+arrows move it by keyboard. */
export function PenPaletteEditor() {
  const { t } = useI18n()
  const [lists, setLists] = useState(() => ({ pen: sharedPenPalette().read('pen'), highlighter: sharedPenPalette().read('highlighter') }))
  const [adding, setAdding] = useState<PenTool | null>(null)
  const [sel, setSel] = useState<string | null>(null) // swatch whose remove button shows
  const drag = useRef<number | null>(null)
  const picked = useRef('#000000')
  const save = (tool: PenTool, next: string[]) => setLists((l) => ({ ...l, [tool]: sharedPenPalette().write(tool, next) }))
  const name = (hex: string) => (colorNameKey(hex) === 'editor.colorCustom' ? hex : t(colorNameKey(hex)))
  return (
    <div className="settings-group" role="group" aria-labelledby="palette-label">
      <span id="palette-label">{t('settings.palette')}</span>
      {TOOLS.map((tool) => {
        const list = lists[tool]
        const full = list.length >= PALETTE_MAX
        const move = (from: number, to: number) => {
          if (from === to || to < 0 || to >= list.length) return
          const next = [...list]
          next.splice(to, 0, next.splice(from, 1)[0]!)
          save(tool, next)
        }
        const remove = (hex: string) => {
          setSel(null)
          save(tool, list.filter((c) => c !== hex))
        }
        return (
          <div key={tool} role="group" aria-label={t(`editor.tool.${tool}`)} className="palette-editor">
            <strong>{t(`editor.tool.${tool}`)}</strong>
            <ul className="palette-editor-list">
              {list.map((hex, i) => (
                <li
                  key={hex}
                  className="palette-editor-item"
                  draggable
                  onDragStart={() => void (drag.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (drag.current !== null) move(drag.current, i)
                    drag.current = null
                  }}
                >
                  <button
                    type="button"
                    className="palette-editor-swatch"
                    style={{ background: hex }}
                    aria-label={name(hex)}
                    aria-pressed={sel === hex}
                    title={fmt(t('settings.paletteRemove'), { color: name(hex) })}
                    onClick={() => setSel(sel === hex ? null : hex)}
                    onKeyDown={(e) => {
                      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
                      e.preventDefault()
                      move(i, i + (e.key === 'ArrowLeft' ? -1 : 1))
                    }}
                  />
                  {sel === hex && (
                    <button type="button" className="palette-editor-remove" disabled={list.length <= 1} aria-label={fmt(t('settings.paletteRemove'), { color: name(hex) })} onClick={() => remove(hex)}>
                      ✕
                    </button>
                  )}
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
