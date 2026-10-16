// Spec `drive.duplicates`: which of several items with one `kkeujeokId` stays.
// The caller guarantees well-formed input. Strings compare by UTF-16 code unit.
export type DuplicatesResult = { keep: string | null; merge: string[] } | { error: 'noItems' }

export function driveDuplicatesRule(input: {
  kkeujeokId: string
  items: { id: string; createdTime: string }[]
}): DuplicatesResult {
  if (input.kkeujeokId.startsWith('asset:')) return { keep: null, merge: [] }
  if (input.items.length === 0) return { error: 'noItems' }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const sorted = [...input.items].sort((a, b) => cmp(a.createdTime, b.createdTime) || cmp(a.id, b.id))
  return { keep: sorted[0]!.id, merge: sorted.slice(1).map((i) => i.id) }
}
