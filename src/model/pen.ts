// A pen as the toolbar holds it (spec stroke-geometry.md default pen).
export type Pen = {
  color: string // `#rrggbb`, written to strokes as is
  width: number // pt
  usePressure: boolean
  colorName: 'black' // maps to a ko/en color name in the UI
}

export const defaultPen: Pen = { color: '#000000', width: 2.0, usePressure: true, colorName: 'black' }

// The slot list a device starts with: one slot now; Epic 5 extends it.
export const defaultPenSlots: readonly Pen[] = [defaultPen]
