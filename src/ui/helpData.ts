import type { Key } from '../i18n'

/** The one list the help page and the shortcut sheet both print, so they cannot differ. Keys are as typed (not translated). */
export type HelpRow = { keys: string; label: Key }
export type HelpGroup = { title: Key; rows: HelpRow[] }

const row = (keys: string, label: Key): HelpRow => ({ keys, label })

export const SHORTCUT_GROUPS: HelpGroup[] = [
  {
    title: 'help.g.library',
    rows: [row('/', 'help.k.search'), row('F2', 'help.k.rename'), row('Delete', 'help.k.deleteNote')],
  },
  {
    title: 'help.g.tools',
    rows: [row('1-9', 'help.k.slot'), row('P / H', 'help.k.penHighlighter'), row('E', 'help.k.eraser'), row('L', 'help.k.lasso'), row('T', 'help.k.text'), row('S', 'help.k.shape'), row('Enter', 'help.k.newTextBox'), row('Space (hold)', 'help.k.hand')],
  },
  {
    title: 'help.g.edit',
    rows: [
      row('Ctrl+Z', 'help.k.undo'),
      row('Ctrl+Shift+Z / Ctrl+Y', 'help.k.redo'),
      row('Ctrl+A', 'help.k.selectAll'),
      row('Ctrl+C / Ctrl+X / Ctrl+V', 'help.k.clipboard'),
      row('Delete', 'help.k.deleteSelection'),
      row('Esc', 'help.k.clearSelection'),
      row('Arrow keys', 'help.k.arrows'),
      row('Shift+Arrow keys', 'help.k.arrowsBig'),
      row('Ctrl+Arrow keys', 'help.k.resizeArrows'),
      row('Ctrl+B / Ctrl+I', 'help.k.boldItalic'),
    ],
  },
  {
    title: 'help.g.view',
    rows: [row('Ctrl++ / Ctrl+-', 'help.k.zoom'), row('Ctrl+0', 'help.k.fit'), row('PageUp / PageDown', 'help.k.pageStep'), row('Home / End', 'help.k.pageEnds'), row('F6 / Shift+F6', 'help.k.regions'), row('Ctrl+P', 'help.k.print'), row('?', 'help.k.sheet')],
  },
  {
    title: 'help.g.toolbar',
    rows: [row('Arrow keys, Home, End', 'help.k.toolbarMove'), row('Alt+Arrow keys', 'help.k.toolbarReorder')],
  },
  {
    title: 'help.g.overview',
    rows: [row('Arrow Up / Down', 'help.k.ovMove'), row('Alt+Arrow Up / Down', 'help.k.ovReorder'), row('Ctrl+Space', 'help.k.ovPick'), row('Shift+Arrow Up / Down', 'help.k.ovRange'), row('Enter', 'help.k.ovGo'), row('Delete', 'help.k.ovDelete')],
  },
]

export const POINTER_ROWS: HelpRow[] = [
  row('pen', 'help.p.pen'),
  row('mouse', 'help.p.mouse'),
  row('pen button', 'help.p.penButton'),
  row('wheel', 'help.p.wheel'),
  row('Ctrl+wheel', 'help.p.ctrlWheel'),
  row('Shift+wheel', 'help.p.shiftWheel'),
  row('middle button', 'help.p.middle'),
  row('1 finger', 'help.p.oneFinger'),
  row('2 fingers', 'help.p.twoFingers'),
]
