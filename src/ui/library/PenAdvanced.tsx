import { useId, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { type BrushPatch, brushResolve, patchBrush } from '../../model/brush'
import { curveToPoints, editPoints, opacityPressureCurve } from '../../model/curve'
import type { Pen } from '../../model/pen'
import { type BrushPreset, sharedBrushPresets } from '../../storage/brushPresets'
import { CurveEditor } from '../CurveEditor'

const LINEAR = [1 / 3, 1 / 3, 2 / 3, 2 / 3]
const TARGETS = ['none', 'size', 'opacity'] as const

type Props = { pen: Pen; onChange: (patch: Partial<Pen>) => void }

/**
 * The advanced column to the right of the pen popover (spec/brush.md "Advanced settings layout"): the curve graphs, always open and without a test pad,
 * then tilt target and opacity. The result is stored on the pen as a sparse `brush`; strokes already drawn keep theirs.
 * Smoothing and pencil grain have no control here (the parameters stay in the format).
 */
export function PenAdvancedColumn({ pen, onChange }: Props) {
  const { t } = useI18n()
  const id = useId()
  const b = brushResolve(pen.tool, pen.brush)
  const set = (patch: BrushPatch) => onChange({ brush: patchBrush(pen.tool, pen.brush, patch) })
  const flat = pen.tool === 'highlighter' || pen.tool === 'tape'
  const ownPressure = b.pressureCurve !== null
  const opacityCurve = opacityPressureCurve(pen.brush)
  const linear = curveToPoints(LINEAR)!
  const sw = (on: boolean, label: string, toggle: () => void) => (
    <button type="button" role="switch" tabIndex={0} aria-checked={on} className="pen-popover-switch" onClick={toggle}>
      <span>{label}</span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </button>
  )
  return (
    <div className="pen-adv-col" role="group" aria-label={t('editor.brush.advanced')}>
      {!flat && pen.usePressure && (
        <>
          {sw(ownPressure, t('editor.brush.pressureOwn'), () => set({ pressureCurve: ownPressure ? null : LINEAR }))}
          <CurveEditor value={editPoints(b.pressureCurve) ?? linear} fixedCount={2} pad={false} onChange={(v) => set({ pressureCurve: v })} />
        </>
      )}
      {pen.tool !== 'tape' && pen.usePressure && (
        <>
          {sw(opacityCurve !== null, t('editor.brush.opacityPressure'), () => set({ opacityPressureCurve: opacityCurve ? null : linear }))}
          <CurveEditor value={editPoints(opacityCurve) ?? linear} fixedCount={2} pad={false} i18n="brush.opacityCurve" onChange={(v) => set({ opacityPressureCurve: v })} />
        </>
      )}
      {!flat && (
        <>
          <div className="segmented" role="radiogroup" aria-label={t('editor.brush.tiltTarget')}>
            {TARGETS.map((k) => (
              <label key={k} className="segmented-option">
                <input type="radio" name={`${id}-tilt`} checked={b.tiltTarget === k} onChange={() => set({ tiltTarget: k })} />
                <span>{t(`editor.brush.tilt.${k}`)}</span>
              </label>
            ))}
          </div>
          <CurveEditor value={editPoints(b.tiltCurve)!} mode="tilt" fixedCount={2} pad={false} i18n="brush.tiltCurve" onChange={(v) => set({ tiltCurve: v })} />
        </>
      )}
      {pen.tool !== 'tape' && (
        <label className="option">
          <span>{t('editor.brush.opacity')}</span>
          <input type="range" className="setting-range" min={0.05} max={1} step={0.05} value={b.opacity} onChange={(e) => set({ opacity: Math.round(Number(e.target.value) * 100) / 100 })} />
          <output>{Math.round(b.opacity * 100)}%</output>
        </label>
      )}
    </div>
  )
}

/** One preset label: a press applies it; a long press, a right click or the "..." button opens rename and delete. */
function PresetChip({ p, onUse, onList }: { p: BrushPreset; onUse: () => void; onList: (l: BrushPreset[]) => void }) {
  const { t } = useI18n()
  const [menu, setMenu] = useState(false)
  const [name, setName] = useState(p.name)
  const timer = useRef<number>(0)
  const rename = () => {
    onList(sharedBrushPresets().rename(p.id, name))
    setMenu(false)
  }
  return (
    <div className="pen-preset">
      <button
        type="button"
        tabIndex={0}
        className="pen-chip"
        aria-label={`${t('editor.brush.presetUse')} ${p.name}`}
        onClick={onUse}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu(true)
        }}
        onPointerDown={() => (timer.current = window.setTimeout(() => setMenu(true), 500))}
        onPointerUp={() => clearTimeout(timer.current)}
        onPointerLeave={() => clearTimeout(timer.current)}
      >
        {p.name}
      </button>
      <button type="button" tabIndex={0} className="pen-chip pen-chip-more" aria-expanded={menu} aria-label={`${t('editor.brush.presetMenu')} ${p.name}`} onClick={() => setMenu(!menu)}>
        …
      </button>
      {menu && (
        <div className="pen-preset-menu">
          <input
            type="text"
            tabIndex={0}
            aria-label={t('editor.brush.presetName')}
            maxLength={30}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && rename()}
          />
          <button type="button" tabIndex={0} className="btn" disabled={!name.trim()} onClick={rename}>
            {t('editor.brush.presetRename')}
          </button>
          <button type="button" tabIndex={0} className="btn" onClick={() => onList(sharedBrushPresets().remove(p.id))}>
            {t('editor.brush.presetDelete')}
          </button>
        </div>
      )}
    </div>
  )
}

/** The preset labels outside the popover, to its right: one per preset plus one "save" label. */
export function PenPresets({ pen, onChange }: Props) {
  const { t } = useI18n()
  const [presets, setPresets] = useState(() => sharedBrushPresets().read())
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const save = () => {
    const next = sharedBrushPresets().save(name, pen)
    if (next) {
      setPresets(next)
      setName('')
      setNaming(false)
    }
  }
  return (
    <div className="pen-presets" role="group" aria-label={t('editor.brush.presets')}>
      {presets.map((p) => (
        <PresetChip
          key={p.id}
          p={p}
          onList={setPresets}
          onUse={() => onChange({ tool: p.tool, width: p.width, usePressure: p.usePressure, brush: p.brush ? structuredClone(p.brush) : undefined })}
        />
      ))}
      {naming && (
        <input
          type="text"
          tabIndex={0}
          className="pen-preset-name"
          aria-label={t('editor.brush.presetName')}
          placeholder={t('editor.brush.presetName')}
          maxLength={30}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the label just opened it
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      )}
      <button type="button" tabIndex={0} className="pen-chip pen-chip-save" disabled={naming && !name.trim()} onClick={() => (naming ? save() : setNaming(true))}>
        {t('editor.brush.presetSave')}
      </button>
    </div>
  )
}
