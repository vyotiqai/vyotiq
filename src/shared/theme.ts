export type ResolvedTheme = 'light' | 'dark'

export function resolveTheme(
  preference: 'system' | 'light' | 'dark',
  systemDark = false
): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}
