// A folder's color in the library list: one of 8 fixed colors, kept on this device only.
// shortcut: color local per device, sync via folderOp/appProperties when needed
export const FOLDER_COLORS = ['#E57373', '#FFB74D', '#FFD54F', '#81C784', '#4DB6AC', '#64B5F6', '#9575CD', '#A1887F'] as const
const KEY = 'kkeujeok.folderColors'

function load(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** The folder's color, or null for the neutral default. */
export function getFolderColor(id: string): string | null {
  const c = load()[id]
  return (FOLDER_COLORS as readonly string[]).includes(c as string) ? (c as string) : null
}

export function setFolderColor(id: string, color: string | null): void {
  const all = load()
  if (color === null) delete all[id]
  else all[id] = color
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // private mode or full: the color just isn't kept
  }
}
