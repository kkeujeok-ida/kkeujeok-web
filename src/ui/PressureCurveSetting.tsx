import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { PRESETS, curveValues, type CurveValues } from '../model/pressureCurve'
import { getPressureCurve, setPressureCurve, subscribePressureCurve } from '../storage/pressureCurve'
import { strokeOutline } from '../render/strokeOutline'

const NAMES = ['x1', 'y1', 'x2', 'y2'] as const
const PREVIEW_WIDTH = 6

/** Settings: pressure curve (pen-feel.md) as 3 presets or 4 control-point sliders, and a pad to draw a test stroke. */
export function PressureCurveSetting() {
  const { t } = useI18n()
  const curve = useSyncExternalStore(subscribePressureCurve, getPressureCurve, getPressureCurve)
  const values = curveValues(curve)
  const pad = useRef<HTMLCanvasElement>(null)
  const pts = useRef<number[][]>([])
  const [drawing, setDrawing] = useState(false)

  const paint = () => {
    const c = pad.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    if (pts.current.length === 0) return
    const k = c.width / (c.clientWidth || c.width)
    ctx.fillStyle = getComputedStyle(c).color
    ctx.beginPath()
    for (const [i, p] of strokeOutline(PREVIEW_WIDTH, true, pts.current, curve).entries()) {
      if (i) ctx.lineTo(p[0]! * k, p[1]! * k)
      else ctx.moveTo(p[0]! * k, p[1]! * k)
    }
    ctx.closePath()
    ctx.fill()
  }
  useEffect(paint, [curve]) // an earlier test stroke is drawn again with the new curve

  const add = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    pts.current.push([e.clientX - r.left, e.clientY - r.top, e.pointerType === 'pen' ? e.pressure : 0.5, 0])
    paint()
  }
  const setValue = (i: number, v: number) => {
    const next = [...values] as unknown as CurveValues & number[]
    next[i] = v
    setPressureCurve(next)
  }
  // The range of each slider keeps x1 <= x2 and y1 <= y2, so an invalid curve cannot be made.
  const lo = [0, 0, values[0], values[1]]
  const hi = [values[2], values[3], 1, 1]
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
      {NAMES.map((n, i) => (
        <label key={n} className="option">
          <span>{t(`settings.pressureCurve.${n}`)}</span>
          <input type="range" min={lo[i]} max={hi[i]} step={0.01} value={values[i]} onChange={(e) => setValue(i, Number(e.target.value))} />
          <output>{values[i]!.toFixed(2)}</output>
        </label>
      ))}
      <canvas
        ref={pad}
        className="pressure-pad"
        role="img"
        aria-label={t('settings.pressureCurve.pad')}
        width={640}
        height={160}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          pts.current = []
          setDrawing(true)
          add(e)
        }}
        onPointerMove={(e) => drawing && add(e)}
        onPointerUp={() => setDrawing(false)}
        onPointerCancel={() => setDrawing(false)}
      />
    </fieldset>
  )
}
