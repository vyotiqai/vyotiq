import { useEffect } from 'react'
import { shouldDeferAppEscapeStop } from './escape'
import { isEditableShortcutTarget, matchShortcut } from './match'

const COMPOSER_SELECTOR = '[role="textbox"][aria-label="Message"]'

export type AppShortcutHandlers = {
  onToggleSidebar: () => void
  onFocusSearch: () => void
  /** Clear + blur when Cmd/Ctrl+K fires while search is focused. */
  onClearSearchFocus: () => void
  isSearchFocused: () => boolean
  onNewChat: () => void
  onOpenSettings: () => void
  /** When false/undefined, Cmd/Ctrl+L is a no-op. */
  chatViewActive?: boolean
  running?: boolean
  onStop?: () => void
  drawerOpen?: boolean
  /** Live check — session query lives in hot UI store, not always in React props. */
  hasSessionQuery?: () => boolean
}

/**
 * Single window keydown listener for app chords (replaces AppShell B/K effect).
 * Escape-to-stop is bubble-phase last-resort only.
 */
export function useAppShortcuts(handlers: AppShortcutHandlers): void {
  const {
    onToggleSidebar,
    onFocusSearch,
    onClearSearchFocus,
    isSearchFocused,
    onNewChat,
    onOpenSettings,
    chatViewActive,
    running,
    onStop,
    drawerOpen,
    hasSessionQuery
  } = handlers

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (matchShortcut(e, 'sidebar')) {
        if (isEditableShortcutTarget(e.target)) return
        e.preventDefault()
        onToggleSidebar()
        return
      }

      if (matchShortcut(e, 'search')) {
        if (isEditableShortcutTarget(e.target)) {
          if (isSearchFocused()) {
            e.preventDefault()
            onClearSearchFocus()
          }
          return
        }
        e.preventDefault()
        onFocusSearch()
        return
      }

      if (matchShortcut(e, 'newChat')) {
        if (isEditableShortcutTarget(e.target)) return
        e.preventDefault()
        onNewChat()
        return
      }

      if (matchShortcut(e, 'settings')) {
        if (isEditableShortcutTarget(e.target)) return
        e.preventDefault()
        onOpenSettings()
        return
      }

      if (matchShortcut(e, 'focusComposer')) {
        if (!chatViewActive) return
        if (isEditableShortcutTarget(e.target)) return
        const el = document.querySelector(COMPOSER_SELECTOR) as HTMLElement | null
        if (!el) return
        if (el.getAttribute('contenteditable') === 'false') return
        e.preventDefault()
        el.focus()
        return
      }

      if (matchShortcut(e, 'stop')) {
        if (!chatViewActive || !running || !onStop) return
        if (e.defaultPrevented) return
        if (
          shouldDeferAppEscapeStop({
            drawerOpen,
            hasSessionQuery: hasSessionQuery?.()
          })
        ) {
          return
        }
        e.preventDefault()
        onStop()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    onToggleSidebar,
    onFocusSearch,
    onClearSearchFocus,
    isSearchFocused,
    onNewChat,
    onOpenSettings,
    chatViewActive,
    running,
    onStop,
    drawerOpen,
    hasSessionQuery
  ])
}
