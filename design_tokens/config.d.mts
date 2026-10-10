export function generate(): Promise<{ css: string; dart: string }>
/** Resolved token values keyed by dotted path, e.g. "color.accent". */
export function loadTokens(theme: 'light' | 'dark'): Promise<Record<string, { value: unknown; type?: string }>>
