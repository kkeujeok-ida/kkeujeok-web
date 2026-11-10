// Settings layout rules from spec/settings.md (sections and scroll highlight).
export type SectionId = 'general' | 'input' | 'tools' | 'support' | 'account'
export type Section = { id: SectionId; items: string[] }

const SECTIONS: Section[] = [
  { id: 'general', items: ['language', 'theme'] },
  { id: 'input', items: ['leftHanded', 'penOnly', 'straighten', 'smooth', 'pressureCurve'] },
  { id: 'tools', items: ['visibleTools', 'penPalette'] },
  { id: 'support', items: ['help', 'privacy', 'exportLog', 'penDiag'] },
  { id: 'account', items: ['logOut', 'disconnect'] },
]

export function settingsSections({ signedIn, platform }: { signedIn: boolean; platform: 'android' | 'web' }): Section[] {
  return SECTIONS.filter((s) => signedIn || s.id !== 'account').map((s) => ({
    id: s.id,
    items: s.items.filter((i) => platform === 'android' || i !== 'penDiag'),
  }))
}

export type SearchItem = { id: string; section: string; text: string }

// spec/settings.md settings.search: every whitespace-separated term must be a substring of the item text.
export function settingsSearch({ query, items }: { query: string; items: SearchItem[] }): { visible: string[]; counts: Record<string, number> } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const counts: Record<string, number> = {}
  const visible: string[] = []
  for (const it of items) {
    counts[it.section] ??= 0
    const text = it.text.toLowerCase()
    if (terms.every((t) => text.includes(t))) {
      visible.push(it.id)
      counts[it.section]!++
    }
  }
  return { visible, counts }
}

export type ActiveInput = { headings: { id: string; top: number }[]; viewportTop: number; offset: number; atEnd: boolean }

export function settingsActiveSection({ headings, viewportTop, offset, atEnd }: ActiveInput): string {
  if (atEnd) return headings[headings.length - 1]!.id
  let id = headings[0]!.id
  for (const h of headings) if (h.top <= viewportTop + offset) id = h.id
  return id
}
