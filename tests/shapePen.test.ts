// @vitest-environment jsdom
// Story 29.5: the shape tool's own pen, its popover rows, the line-draw ruler mark, the filled shapes icon.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import ko from '../src/i18n/ko.json'
import en from '../src/i18n/en.json'
import { defaultPenSlots, defaultShapePen } from '../src/model/pen'
import { SHAPE_PEN_KEY, createShapePen } from '../src/storage/shapePen'
import { PenToolbar } from '../src/ui/library/PenToolbar'
import { ShapePopover } from '../src/ui/library/ShapePopover'
import { Writer } from '../src/ui/library/writer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mem = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[SHAPE_PEN_KEY, initial]])
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

test('store: default black 2.0 opacity 1; round trip; bad value or failing read gives the default', () => {
  expect(createShapePen(mem()).read()).toEqual(defaultShapePen)
  const st = mem()
  createShapePen(st).write({ ...defaultShapePen, color: '#e03131', width: 4, brush: { opacity: 0.5 } })
  expect(createShapePen(st).read()).toMatchObject({ color: '#e03131', width: 4, brush: { opacity: 0.5 }, usePressure: false })
  expect(createShapePen(mem('{"color":"red","width":2}')).read()).toEqual(defaultShapePen)
  expect(createShapePen(mem('not json')).read()).toEqual(defaultShapePen)
  expect(createShapePen({ getItem: () => { throw new Error('x') }, setItem: () => {} }).read()).toEqual(defaultShapePen)
})

test('a dragged shape is saved with the shape pen, a slot pen change leaves it alone', () => {
  const slot = { ...defaultPenSlots[0]!, color: '#000000' }
  const shapePen = { ...defaultShapePen, color: '#e03131', width: 4, brush: { opacity: 0.5 } }
  const self = { shapePen, pen: () => slot, build: (Writer.prototype as never as { build: (...a: unknown[]) => unknown }).build, shown: () => [] }
  const strokeOf = (Writer.prototype as never as { strokeOf: (d: unknown) => Record<string, unknown> | null }).strokeOf
  const st = strokeOf.call(self, { strokeId: 's', shape: 'rect', lock: false, points: [[0, 0], [50, 40]] })!
  expect(st).toMatchObject({ color: '#e03131', width: 4, usePressure: false, brush: { opacity: 0.5 } })
  expect(slot.color).toBe('#000000')
})

function mount(node: React.ReactElement) {
  const host = document.body.appendChild(document.createElement('div'))
  act(() => createRoot(host).render(node))
  return host
}

test('shape popover: no kind switch, texture, pressure, line drawing, advanced or delete; has width and opacity', () => {
  const host = mount(createElement(ShapePopover, { kind: 'rect', pen: defaultShapePen, recent: [], onPenChange: vi.fn(), onRecent: vi.fn(), anchor: null, tool: 'x', onChange: vi.fn(), onClose: vi.fn() }))
  expect(host.querySelectorAll('[role="radio"][data-shape-kind]')).toHaveLength(3)
  expect(host.querySelector('.pen-advanced-toggle')).toBeNull()
  expect(host.querySelector('.pen-popover-delete')).toBeNull()
  expect(host.querySelector('[role="switch"]')).toBeNull()
  expect(host.querySelectorAll('input[type="range"]')).toHaveLength(2) // width, opacity
  expect(host.querySelector('.pen-palette')).not.toBeNull()
})

const bar = (tool: 'pen' | 'shape', pens = [{ ...defaultPenSlots[0]!, lineMode: true }, defaultPenSlots[1]!]) =>
  mount(createElement(PenToolbar, { pens, selected: 0, onSelect: vi.fn(), onEdit: vi.fn(), onAdd: vi.fn(), onMove: vi.fn(), tool, onToolChange: vi.fn(), onShapeEdit: vi.fn(), eraserMode: 'stroke', onEraserEdit: vi.fn(), canUndo: false, canRedo: false, onUndo: vi.fn(), onRedo: vi.fn() } as never))

test('toolbar: ruler only on the line-draw slot, named; shape tool deselects the slots; icon shapes are filled', () => {
  const host = bar('pen')
  const slots = host.querySelectorAll<HTMLElement>('.pen-slot')
  expect(slots[0]!.querySelector('.pen-ruler')).not.toBeNull()
  expect(slots[0]!.getAttribute('aria-label')).toContain('Straight lines on')
  expect(slots[1]!.querySelector('.pen-ruler')).toBeNull()
  expect(slots[0]!.getAttribute('aria-checked')).toBe('true')
  const icon = host.querySelectorAll('[data-tool="shape"] path')
  expect(icon).toHaveLength(3)
  expect(icon[0]!.parentElement!.getAttribute('fill')).toBe('var(--shapes-face)')
  const shaped = bar('shape')
  expect([...shaped.querySelectorAll('.pen-slot')].map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'false'])
  expect(shaped.querySelector('.pen-slot-selected')).toBeNull()
})

test('ko and en carry the ruler label', () => {
  expect((ko as Record<string, string>)['editor.lineDrawOn']).toBe('직선 그리기 켜짐')
  expect((en as Record<string, string>)['editor.lineDrawOn']).toBe('Straight lines on')
})
