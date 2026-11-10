// @vitest-environment jsdom
// Story 29.3: curve editing (add / delete by touch), curve switches, one-column advanced settings, presets.
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { brushCurves, brushResolve } from '../src/model/brush'
import { curveEdit } from '../src/model/curve'
import type { Pen } from '../src/model/pen'
import { createBrushPresets } from '../src/storage/brushPresets'
import { CurveEditor } from '../src/ui/CurveEditor'
import { PenAdvancedPanel } from '../src/ui/library/PenAdvanced'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const i18n = () => createI18n({ navigatorLanguage: 'ko-KR', storage: { getItem: () => null, setItem: () => {} } })

const ptr = (el: Element, type: string, clientX: number, clientY: number) =>
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY })))
// the graph box is 220 px and its rect is at 0,0 in jsdom: (x, y) in 0..1 with y up
const at = (x: number, y: number) => [x * 220, (1 - y) * 220] as const

function mountGraph(init: number[][], props: object = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const seen = { value: init, touched: 0 }
  function Harness() {
    const [v, setV] = useState(init)
    seen.value = v
    return createElement(CurveEditor, { value: v, pad: false, onChange: (n: unknown) => setV(n as number[][]), onTouch: () => seen.touched++, ...props })
  }
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(Harness))))
  return { svg: host.querySelector('svg')!, host, seen }
}

describe('curve graph (brush.curveEdit)', () => {
  test('rule: add off the line, not on it, not past 8 points; release outside deletes inner only', () => {
    const two = [[0, 0], [1, 1]]
    expect(curveEdit(two, { kind: 'add', x: 0.5, y: 0.9 })).toEqual([[0, 0], [0.5, 0.9], [1, 1]])
    expect(curveEdit(two, { kind: 'add', x: 0.5, y: 0.52 })).toEqual(two)
    const eight = Array.from({ length: 8 }, (_, i) => [i / 7, i % 2])
    expect(curveEdit(eight, { kind: 'add', x: 0.07, y: 0.5 })).toHaveLength(8)
    const three = [[0, 0], [0.5, 0.9], [1, 1]]
    expect(curveEdit(three, { kind: 'release', index: 1, outside: 0.5 })).toEqual(two)
    expect(curveEdit(three, { kind: 'release', index: 0, outside: 0.5 })).toEqual(three)
    expect(curveEdit(two, { kind: 'release', index: 1, outside: 0.5 })).toEqual(two)
  })

  test('touching off the line adds a point; dragging it out of the box deletes it; no popup or slider appears', () => {
    const { svg, host, seen } = mountGraph([[0, 0], [1, 1]])
    ptr(svg, 'pointerdown', ...at(0.5, 0.9))
    expect(seen.value).toEqual([[0, 0], [0.5, 0.9], [1, 1]])
    expect(seen.touched).toBe(1)
    expect(host.querySelector('input[type="range"]')).toBeNull()
    expect(host.querySelectorAll('circle')).toHaveLength(3)
    ptr(svg, 'pointerup', ...at(0.5, -0.5))
    expect(seen.value).toEqual([[0, 0], [1, 1]])
  })

  test('a point let go inside the box stays; an end point dragged out stays (clamped)', () => {
    const { svg, seen } = mountGraph([[0, 0], [0.5, 0.9], [1, 1]])
    ptr(svg, 'pointerdown', ...at(0.5, 0.9)) // on the point: selects it
    ptr(svg, 'pointermove', ...at(0.6, 0.7))
    ptr(svg, 'pointerup', ...at(0.6, 0.7))
    expect(seen.value).toEqual([[0, 0], [0.6, 0.7], [1, 1]])
    ptr(svg, 'pointerdown', ...at(1, 1))
    ptr(svg, 'pointermove', ...at(1.5, 2))
    ptr(svg, 'pointerup', ...at(1.5, 2))
    expect(seen.value).toEqual([[0, 0], [0.6, 0.7], [1, 1]])
  })

  test('Delete removes a selected inner point, never an end point', () => {
    const { host, seen } = mountGraph([[0, 0], [0.5, 0.9], [1, 1]])
    const dots = host.querySelectorAll('circle')
    act(() => void dots[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
    expect(seen.value).toHaveLength(3)
    act(() => void dots[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
    expect(seen.value).toEqual([[0, 0], [1, 1]])
  })
})

const pen0: Pen = { tool: 'pen', color: '#000000', width: 2, usePressure: true }
function mountPanel(init: Pen) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const seen = { pen: init }
  function Harness() {
    const [pen, setPen] = useState(init)
    seen.pen = pen
    return createElement(PenAdvancedPanel, { pen, onChange: (patch: Partial<Pen>) => setPen((p) => ({ ...p, ...patch })) })
  }
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(Harness))))
  const switches = () => Array.from(host.querySelectorAll<HTMLElement>('button[role="switch"]'))
  const graphs = () => Array.from(host.querySelectorAll('svg.pressure-graph'))
  return { host, seen, switches, graphs }
}

describe('advanced settings (one column, curve switches)', () => {
  test('pen: four blocks in order, always open, one column, no slider', () => {
    const { host, switches, graphs } = mountPanel(pen0)
    expect(switches().map((s) => s.textContent)).toEqual(['두께 필압 커브', '두께 기울기 커브', '불투명도 필압 커브', '불투명도 기울기 커브'])
    expect(graphs()).toHaveLength(4)
    expect(host.querySelector('input[type="range"]')).toBeNull()
    expect(host.querySelectorAll('.pen-adv-col')).toHaveLength(1)
    expect(graphs().every((g) => Number(g.getAttribute('width')) >= 160)).toBe(true)
  })

  test('highlighter: the width curve only; tape: none; pencil adds the density curve', () => {
    expect(mountPanel({ ...pen0, tool: 'highlighter' }).switches()).toHaveLength(1)
    expect(mountPanel({ ...pen0, tool: 'tape' }).switches()).toHaveLength(0)
    expect(mountPanel({ ...pen0, tool: 'pencil' }).switches().map((s) => s.textContent).at(-1)).toBe('농도 필압 커브')
  })

  test('off keeps the points, on brings them back', () => {
    const brush = { pressureCurve: [[0, 0], [0.4, 0.8], [1, 1]] }
    const { seen, switches } = mountPanel({ ...pen0, brush })
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('true')
    act(() => switches()[0]!.click())
    expect(seen.pen.brush).toEqual({ ...brush, curvesOff: ['pressure'] })
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('false')
    act(() => switches()[0]!.click())
    expect(seen.pen.brush).toEqual(brush)
  })

  test('on with no stored curve starts from the spec shape (pressure rises, tilt is the constant 1)', () => {
    const { seen, switches } = mountPanel(pen0)
    act(() => switches()[0]!.click())
    expect(seen.pen.brush).toEqual({ pressureCurve: [[0, 0], [1, 1]] })
    act(() => switches()[1]!.click())
    expect((seen.pen.brush as Record<string, unknown>).sizeTiltCurve).toEqual([[0, 1], [1, 1]])
  })

  test('touching a switched-off graph turns it on and edits it in the same gesture', () => {
    const { seen, graphs } = mountPanel({ ...pen0, brush: { opacityPressureCurve: [[0, 0], [1, 1]], curvesOff: ['opacityPressure', 'sizeTilt'] } })
    ptr(graphs()[2]!, 'pointerdown', ...at(0.5, 0.9))
    const b = seen.pen.brush as Record<string, unknown>
    expect(b.curvesOff).toEqual(['sizeTilt'])
    expect(b.opacityPressureCurve).toEqual([[0, 0], [0.5, 0.9], [1, 1]])
  })

  test('the old tiltTarget/tiltCurve show as the size tilt curve and stay in the brush', () => {
    const brush = { tiltTarget: 'size', tiltCurve: [0.3, 0.3, 0.6, 0.6] }
    const { seen, switches } = mountPanel({ ...pen0, brush })
    expect(switches()[1]!.getAttribute('aria-checked')).toBe('true')
    act(() => switches()[1]!.click())
    expect(seen.pen.brush).toEqual({ ...brush, curvesOff: ['sizeTilt'] })
  })
})

describe('rendering reads and presets keep the new fields', () => {
  test('a switched-off pressure curve is ignored; size tilt reads the new field and the old pair', () => {
    expect(brushResolve('pen', { pressureCurve: [[0, 0], [1, 1]], curvesOff: ['pressure'] }).pressureCurve).toBeNull()
    expect(brushResolve('pen', { pressureCurve: [[0, 0], [1, 1]] }).pressureCurve).not.toBeNull()
    expect(brushCurves({ sizeTiltCurve: [[0, 1], [1, 0.5]] }).sizeTiltCurve).toEqual([[0, 1], [1, 0.5]])
    expect(brushCurves({ tiltTarget: 'size' }).sizeTiltCurve).not.toBeNull()
    expect(brushCurves({ tiltTarget: 'size', curvesOff: ['sizeTilt'] }).sizeTiltCurve).toBeNull()
  })

  test('a preset round trip keeps the curves and curvesOff', () => {
    const store = new Map<string, string>()
    const presets = createBrushPresets({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) })
    const brush = { sizeTiltCurve: [[0, 1], [1, 0.5]], densityPressureCurve: [[0, 1], [1, 0]], curvesOff: ['sizeTilt'] }
    const saved = presets.save('x', { ...pen0, brush }, 'id1')!
    expect(saved[0]!.brush).toEqual(brush)
    expect(presets.read()[0]!.brush).toEqual(brush)
    expect(saved[0]!.brush).not.toBe(brush)
  })
})
