import { useId, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { type BrushPatch, brushCurves, brushLegacyTilt, brushResolve, curvesOffOf, patchBrush } from '../../model/brush'
import { editPoints, opacityPressureCurve, validCurve } from '../../model/curve'
import type { Pen } from '../../model/pen'
import { type BrushPreset, sharedBrushPresets } from '../../storage/brushPresets'
import { CurveEditor } from '../CurveEditor'

type Props = { pen: Pen; onChange: (patch: Partial<Pen>) => void }

/** A one-line slider row: `label | value | slider | < >` (spec/brush.md "Basic settings rows"). DOM and Tab order: slider, down, up. */
export function SliderRow({ label, text, min, max, step, value, onChange, downLabel, upLabel }: {
  label: string
  text: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  downLabel: string
  upLabel: string
}) {
  const id = useId()
  const move = (d: number) => onChange(Math.min(max, Math.max(min, value + d)))
  return (
    <div className="pen-slider-row">
      <span id={id} className="pen-slider-label">{label}</span>
      <output className="pen-slider-value" aria-hidden="true">{text}</output>
      <input
        type="range"
        tabIndex={0}
        className="pen-width-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-labelledby={id}
        aria-valuetext={text}
        onChange={(e) => onChange(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            move(e.key === 'ArrowLeft' ? -step : step)
          }
        }}
      />
      <button type="button" tabIndex={0} aria-disabled={value <= min} aria-label={downLabel} className="pen-step pen-step-down" onClick={() => move(-step)}>
        ‹
      </button>
      <button type="button" tabIndex={0} aria-disabled={value >= max} aria-label={upLabel} className="pen-step" onClick={() => move(step)}>
        ›
      </button>
    </div>
  )
}

/**
 * Applies a brush patch on the latest `brush`, not the one of the last render: a touch on a switched-off graph turns it on and edits it in the
 * same gesture (two writes before React renders again).
 */
function useBrushSetter({ pen, onChange }: Props) {
  const latest = useRef(pen.brush)
  latest.current = pen.brush
  const set = (patch: BrushPatch) => {
    latest.current = patchBrush(pen.tool, latest.current, patch)
    onChange({ brush: latest.current })
  }
  return { set, latest }
}

/** Basic-settings 불투명도 row (spec/brush.md): `brush.opacity` 0.05..1 in steps of 0.05; not for the fixed highlighter (0.4) and tape. */
export function PenOpacity({ pen, onChange }: Props) {
  const { t } = useI18n()
  const { set } = useBrushSetter({ pen, onChange })
  if (pen.tool === 'highlighter' || pen.tool === 'tape') return null
  const v = brushResolve(pen.tool, pen.brush).opacity
  return (
    <SliderRow
      label={t('editor.brush.opacity')}
      text={`${Math.round(v * 100)}%`}
      min={0.05}
      max={1}
      step={0.05}
      value={v}
      onChange={(x) => set({ opacity: Math.round(x * 100) / 100 })}
      downLabel={t('editor.brush.opacityDown')}
      upLabel={t('editor.brush.opacityUp')}
    />
  )
}

/** Basic-settings texture choice (spec/brush.md, Story 28.5): none / pencil stamp, plus the 농도 row when textured. Pen, fountain and pencil only. */
export function PenTexture({ pen, onChange }: Props) {
  const { t } = useI18n()
  const id = useId()
  const { set } = useBrushSetter({ pen, onChange })
  if (!['pen', 'fountain', 'pencil'].includes(pen.tool)) return null
  const tex = brushResolve(pen.tool, pen.brush).texture
  const density = brushCurves(pen.brush).density
  return (
    <>
      <div className="segmented" role="radiogroup" aria-label={t('editor.brush.texture')}>
        {(['none', 'pencil'] as const).map((k) => (
          <label key={k} className="segmented-option">
            <input type="radio" name={`${id}-tex`} checked={tex === k} onChange={() => set({ texture: k })} />
            <span>{t(k === 'none' ? 'editor.brush.textureNone' : 'editor.brush.textureStamp')}</span>
          </label>
        ))}
      </div>
      {tex === 'pencil' && (
        <SliderRow
          label={t('editor.brush.density')}
          text={`${Math.round(density * 100)}%`}
          min={0.05}
          max={1}
          step={0.05}
          value={density}
          onChange={(x) => set({ density: Math.round(x * 100) / 100 })}
          downLabel={t('editor.brush.densityDown')}
          upLabel={t('editor.brush.densityUp')}
        />
      )}
    </>
  )
}

// Start shapes of a curve that was never stored: pressure curves rise, tilt curves are the constant 1 (spec/brush.md "Curve switches").
const PRESS = [[0, 0], [1, 1]]
const FLAT = [[0, 1], [1, 1]]

const CURVES = [
  { name: 'pressure', field: 'pressureCurve', i18n: 'settings.pressureCurve', tilt: false },
  { name: 'sizeTilt', field: 'sizeTiltCurve', i18n: 'brush.tiltCurve', tilt: true },
  { name: 'opacityPressure', field: 'opacityPressureCurve', i18n: 'brush.opacityCurve', tilt: false },
  { name: 'opacityTilt', field: 'opacityTiltCurve', i18n: 'brush.opacityTiltCurve', tilt: true },
  { name: 'densityPressure', field: 'densityPressureCurve', i18n: 'brush.densityCurve', tilt: false },
] as const

/**
 * Advanced brush settings (spec/brush.md "Advanced settings layout"): one block per curve (switch, title, graph), always open, in one column
 * below the basic settings. The result is stored on the pen as a sparse `brush`; strokes already drawn keep theirs.
 * A switch only adds its name to `brush.curvesOff`; the points stay. Touching a switched-off graph turns it on.
 */
export function PenAdvancedPanel({ pen, onChange }: Props) {
  const { t } = useI18n()
  const { set, latest } = useBrushSetter({ pen, onChange })
  const off = curvesOffOf(pen.brush)
  const b = brushResolve(pen.tool, pen.brush)
  // The stored curves; the old tiltTarget/tiltCurve read as the two tilt curves whatever the switch says.
  const legacy = brushLegacyTilt({ ...(pen.brush ?? {}), curvesOff: [] })
  const brush = pen.brush as Record<string, unknown> | undefined
  const stored: Record<string, unknown> = {
    pressure: validCurve(brush?.pressureCurve),
    sizeTilt: legacy.sizeTiltCurve,
    opacityPressure: opacityPressureCurve(pen.brush),
    opacityTilt: legacy.opacityTiltCurve,
    densityPressure: validCurve(brush?.densityPressureCurve),
  }
  const highlighter = pen.tool === 'highlighter'
  // highlighter: the width curve only; tape: none; the density curve only for a textured tool
  const shown = pen.tool === 'tape' ? [] : CURVES.filter((c) => c.name === 'pressure' || (!highlighter && (c.name !== 'densityPressure' || b.texture === 'pencil')))
  return (
    <div className="pen-adv-col" role="group" aria-label={t('editor.brush.advanced')}>
      {shown.map((c) => {
        const curve = stored[c.name]
        const on = curve != null && !off.includes(c.name)
        const start = c.tilt ? FLAT : PRESS
        const title = t(`editor.brush.curve.${c.name}`)
        const turnOn = () => {
          const cur = curvesOffOf(latest.current)
          if (curve != null && !cur.includes(c.name)) return
          const rest = cur.filter((s) => s !== c.name)
          set({ curvesOff: rest.length ? rest : null, ...(curve == null ? { [c.field]: start } : {}) })
        }
        return (
          <div key={c.name} className="pen-adv-block">
            <button type="button" role="switch" tabIndex={0} aria-checked={on} className="pen-popover-switch" onClick={() => (on ? set({ curvesOff: [...off, c.name] }) : turnOn())}>
              <span>{title}</span>
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
            </button>
            <div className={on ? 'pen-adv-graph' : 'pen-adv-graph is-off'}>
              <CurveEditor value={editPoints(curve) ?? start} pad={false} i18n={c.i18n} label={title} onTouch={turnOn} onChange={(v) => set({ [c.field]: v })} />
            </div>
          </div>
        )
      })}
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
        className="pen-chip pen-chip-preset"
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
        <span aria-hidden="true">+ </span>
        {t('editor.brush.presetSave')}
      </button>
    </div>
  )
}
