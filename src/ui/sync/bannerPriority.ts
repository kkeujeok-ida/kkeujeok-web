// The banner slot is one (UX-DR40): of the states that hold at once, the first of this list shows.
// `conflictReadOnly` (Story 3.20): an unresolved conflict page in the open note, also a page the other device deleted. `deleted` and `newVersion`
// (Story 3.18, UX-DR40 update of 2026-10-10) sit between the other-tab banner and the token banner.
export const BANNER_ORDER = ['conflictReadOnly', 'otherTab', 'deleted', 'newVersion', 'reauth', 'quota', 'offline'] as const
export type BannerKind = (typeof BANNER_ORDER)[number]

export function pickBanner(on: Partial<Record<BannerKind, boolean>> | null | undefined): BannerKind | null {
  return BANNER_ORDER.find((k) => on?.[k] === true) ?? null
}
