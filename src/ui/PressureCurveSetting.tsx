import { useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { PRESETS, curveValues } from '../model/pressureCurve'
import { getPressureCurve, setPressureCurve, subscribePressureCurve } from '../storage/pressureCurve'
import { CurveEditor } from './CurveEditor'

/** Settings: pressure curve (pen-feel.md) as 3 presets or a graph with draggable, addable, deletable points, and a pen-only test pad. */
export function PressureCurveSetting() {
  const { t } = useI18n()
  const curve = useSyncExternalStore(subscribePressureCurve, getPressureCurve, getPressureCurve)
  return (
    <fieldset className="settings-group">
      <legend>{t('settings.pressureCurve')}</legend>
      <div className="segmented">
        {PRESETS.map((v) => (
          <label key={v} className="segmented-option">
            <input type="radio" name="pressureCurve" value={v} checked={curve === v} onChange={() => setPressureCurve(v)} />
            <span>{t(`settings.pressureCurve.${v}`)}</span>
          </label>
        ))}
      </div>
      <CurveEditor value={curveValues(curve)} onChange={(v) => setPressureCurve(v)} curveOf={() => curve} onReset={() => setPressureCurve('normal')} />
    </fieldset>
  )
}
