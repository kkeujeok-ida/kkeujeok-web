import type { Key } from '../i18n'

export const PEN_TOOLS = ['pen', 'highlighter', 'fountain', 'pencil', 'tape'] as const
export type PenTool = (typeof PEN_TOOLS)[number]

// A pen slot as the toolbar holds it (spec pen.md `pen.defaultSlots`).
export type Pen = {
  tool: PenTool
  color: string // `#rrggbb`, written to strokes as is
  width: number // pt
  usePressure: boolean
}

export const defaultPen: Pen = { tool: 'pen', color: '#000000', width: 2.0, usePressure: true }

// The slots a device starts with (spec pen.md): black pen, blue pen, yellow highlighter.
export const defaultPenSlots: readonly Pen[] = [
  defaultPen,
  { tool: 'pen', color: '#1971c2', width: 2.0, usePressure: true },
  { tool: 'highlighter', color: '#ffe066', width: 14, usePressure: false },
]

/** Width range in pt per tool (spec pen.md). */
export const PEN_WIDTH: Record<PenTool, { min: number; max: number }> = {
  pen: { min: 0.5, max: 10 },
  highlighter: { min: 4, max: 30 },
  fountain: { min: 0.5, max: 8 },
  pencil: { min: 0.5, max: 6 },
  tape: { min: 8, max: 30 },
}

/** Width default and `usePressure` default per tool (spec pen.md). */
export const PEN_DEFAULTS: Record<PenTool, { width: number; usePressure: boolean }> = {
  pen: { width: 2, usePressure: true },
  highlighter: { width: 14, usePressure: false },
  fountain: { width: 1.5, usePressure: true },
  pencil: { width: 1.5, usePressure: true },
  tape: { width: 20, usePressure: false },
}

/** The palette (and stored-palette key) a tool uses: tape draws with the highlighter's (spec pen.md `pen.kinds`). */
export const paletteFamily = (tool: PenTool): 'pen' | 'highlighter' => (tool === 'highlighter' || tool === 'tape' ? 'highlighter' : 'pen')

/** Palette colors in grid order (spec pen.md `pen.palette`). */
export const PEN_PALETTE: Record<'pen' | 'highlighter', { columns: number; rows: number; colors: string[] }> = {
  pen: {
    columns: 6,
    rows: 2,
    colors: ['#000000', '#2f9e44', '#1971c2', '#e03131', '#f59f00', '#495057', '#f76707', '#0c8599', '#3b5bdb', '#9c36b5', '#d6336c', '#7f5539'],
  },
  highlighter: { columns: 6, rows: 1, colors: ['#ffe066', '#8ce99a', '#74c0fc', '#faa2c1', '#ffc078', '#d0bfff'] },
}

/** Spec pen.md `pen.switchKind`: the kind's default width and usePressure; the color stays when it is in the kind's palette. The same kind resets only the width. */
export const switchKind = (slot: Pen, to: PenTool): Pen => {
  const d = PEN_DEFAULTS[to]
  const colors = PEN_PALETTE[paletteFamily(to)].colors
  if (to === slot.tool) return { ...slot, width: d.width }
  return { tool: to, color: colors.includes(slot.color.toLowerCase()) ? slot.color : colors[0]!, ...d }
}

/** `v` clamped to the tool's range and rounded to 0.1, so no 2.3000000000000003 is stored. */
export const snapWidth = (v: number, tool: PenTool): number => {
  const { min, max } = PEN_WIDTH[tool]
  return Math.round(Math.min(max, Math.max(min, v)) * 10) / 10
}

/** The color of the text and selection menus: one ink, independent of the slot list. */
export const inkColors: readonly string[] = [defaultPen.color]

// Palette hex -> color name key (spec pen.md `pen.palette`, both palettes).
const COLOR_KEY: Record<string, Key> = {
  '#000000': 'editor.color.black',
  '#495057': 'editor.color.darkGray',
  '#e03131': 'editor.color.red',
  '#f76707': 'editor.color.orange',
  '#f59f00': 'editor.color.yellow',
  '#2f9e44': 'editor.color.green',
  '#0c8599': 'editor.color.teal',
  '#1971c2': 'editor.color.blue',
  '#3b5bdb': 'editor.color.indigo',
  '#9c36b5': 'editor.color.purple',
  '#d6336c': 'editor.color.pink',
  '#7f5539': 'editor.color.brown',
  '#ffe066': 'editor.color.yellow',
  '#8ce99a': 'editor.color.green',
  '#74c0fc': 'editor.color.sky',
  '#faa2c1': 'editor.color.pink',
  '#ffc078': 'editor.color.orange',
  '#d0bfff': 'editor.color.lavender',
}

export const colorNameKey = (hex: string): Key => COLOR_KEY[hex.toLowerCase()] ?? 'editor.colorCustom'
