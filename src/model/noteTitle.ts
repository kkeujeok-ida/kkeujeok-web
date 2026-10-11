// Spec `note.title`.
export const MAX_TITLE_LENGTH = 100

// The exact trim set; U+0085 and U+200B are deliberately absent.
const WS = '\\t-\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g')

/** The normalized title, or null when longer than 100 code points. */
export function normalizeTitle(title: string, existingTitles: Iterable<string>): string | null {
  const t = title.replace(TRIM, '')
  if ([...t].length > MAX_TITLE_LENGTH) return null
  if (t) return t
  const taken = new Set(existingTitles)
  let n = 1
  while (taken.has(`이름 없는 노트 ${n}`)) n++
  return `이름 없는 노트 ${n}`
}
