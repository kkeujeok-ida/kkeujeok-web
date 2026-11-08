// Nib icon shapes (spec/tool-icons.md): absolute M L H V Z only, in a 20 x 36 box.
const D: Record<string, string> = {
  pen: 'M3 0V22.3L10 36L17 22.3V0M3 22.3H17',
  highlighter: 'M3 0V36L17 28V0M3 22.3H17',
  fountain: 'M3 0V18L10 36L17 18V0M3 18H17M10 18V26',
  pencil: 'M3 0V28L10 36L17 28V0ZM3 6H17M3 28H17',
  tape: 'M3 8H17V28H3ZM7 14H13M7 22H13',
}
export const penGlyphD = (tool: string): string => D[tool] ?? D.pen!
