import { useId } from 'react'
import { useI18n } from '../../i18n'
import { type BrushPatch, brushResolve, patchBrush } from '../../model/brush'
import type { Pen } from '../../model/pen'
import { CurveEditor } from '../CurveEditor'

const LINEAR = [1 / 3, 1 / 3, 2 / 3, 2 / 3]
const TARGETS = ['none', 'size', 'opacity'] as const
const TEXTURES = ['none', 'pencil'] as const

/**
 * "Advanced" part of the pen popover (spec/brush.md): own pressure curve, tilt curve and target, opacity, texture.
 * Only the settings Epic 25 draws are shown. The result is stored on the pen as a sparse `brush`; strokes already drawn keep theirs.
 */
export function PenAdvanced({ pen, onChange, open, onToggle }: { pen: Pen; onChange: (patch: Partial<Pen>) => void; open: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const id = useId()
  const b = brushResolve(pen.tool, pen.brush)
  const set = (patch: BrushPatch) => onChange({ brush: patchBrush(pen.tool, pen.brush, patch) })
  const flat = pen.tool === 'highlighter' || pen.tool === 'tape'
  const ownPressure = b.pressureCurve !== null
  return (
    <div className="pen-advanced">
      <button type="button" className="pen-advanced-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        {t('editor.brush.advanced')}
      </button>
      {open && (
        <div id={id} className="pen-advanced-body">
          {!flat && pen.usePressure && (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={ownPressure}
                className="pen-popover-switch"
                onClick={() => set({ pressureCurve: ownPressure ? null : LINEAR })}
              >
                <span>{t('editor.brush.pressureOwn')}</span>
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
              </button>
              {ownPressure && <CurveEditor value={b.pressureCurve!} fixedCount={2} onChange={(v) => set({ pressureCurve: v })} />}
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
              {b.tiltTarget !== 'none' && <CurveEditor value={b.tiltCurve} mode="tilt" fixedCount={2} i18n="brush.tiltCurve" onChange={(v) => set({ tiltCurve: v })} />}
            </>
          )}
          {pen.tool !== 'tape' && (
            <label className="option">
              <span>{t('editor.brush.opacity')}</span>
              <input
                type="range"
                className="setting-range"
                min={0.05}
                max={1}
                step={0.05}
                value={b.opacity}
                onChange={(e) => set({ opacity: Math.round(Number(e.target.value) * 100) / 100 })}
              />
              <output>{Math.round(b.opacity * 100)}%</output>
            </label>
          )}
          {!flat && (
            <div className="segmented" role="radiogroup" aria-label={t('editor.brush.texture')}>
              {TEXTURES.map((k) => (
                <label key={k} className="segmented-option">
                  <input type="radio" name={`${id}-texture`} checked={b.texture === k} onChange={() => set({ texture: k })} />
                  <span>{t(`editor.brush.texture.${k}`)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
