import type { Key } from '../i18n'

export type PenTool = 'pen' | 'highlighter'

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

export const MAX_PEN_SLOTS = 12

/** Width range in pt per tool (spec pen.md). */
export const PEN_WIDTH: Record<PenTool, { min: number; max: number }> = {
  pen: { min: 0.5, max: 10 },
  highlighter: { min: 4, max: 30 },
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
