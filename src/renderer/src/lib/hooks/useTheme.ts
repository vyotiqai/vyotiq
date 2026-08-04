import { useCallback, useEffect, useState } from 'react'
import type { ThemeId } from '@shared/ipc'
import { resolveTheme } from '@shared/theme'

/**
 * Visual theme only — persistence lives in useSettings.update so Settings UI
 * stays in sync with the controlled theme menu.
 */
export function useTheme(initial: ThemeId = 'system') {
  const [theme, setThemeState] = useState<ThemeId>(initial)
  const [resolved, setResolved] = useState<'light' | 'dark'>('light')

  const apply = useCallback((next: ThemeId) => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const value = resolveTheme(next, prefersDark)
    document.documentElement.setAttribute('data-theme', value)
    setResolved(value)
  }, [])

  useEffect(() => {
    apply(theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      if (theme === 'system') apply('system')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme, apply])

  const setTheme = useCallback(
    (next: ThemeId) => {
      setThemeState(next)
      apply(next)
    },
    [apply]
  )

  const toggle = useCallback(() => {
    const next = resolved === 'dark' ? 'light' : 'dark'
    setTheme(next)
  }, [resolved, setTheme])

  return { theme, resolved, setTheme, toggle, hydrate: setThemeState }
}
