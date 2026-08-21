import { useEffect } from 'react'
import { shouldDeferAppEscapeStop } from './escape'
import {
  COMPOSER_MESSAGE_SELECTOR,
  focusBrowserUrlIfOpen,
  isEditableShortcutTarget,
  matchShortcut,
  shouldBlockAppShortcut
} from './match'

export type AppShortcutHandlers = {
  onToggleSidebar: () => void
  onFocusSearch: () => void
  /** Clear + blur when Cmd/Ctrl+K fires while search is focused. */
  onClearSearchFocus: () => void
  isSearchFocused: () => boolean
  onNewChat: () => void
  onOpenSettings: () => void
  /** Close the current chat tab (no-op when drafting). */
  onCloseChat?: () => void
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
    onCloseChat,
    chatViewActive,
    running,
    onStop,
    drawerOpen,
    hasSessionQuery
  } = handlers

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (matchShortcut(e, 'sidebar')) {
        if (shouldBlockAppShortcut(e.target)) return
        e.preventDefault()
        onToggleSidebar()
        return
      }

      if (matchShortcut(e, 'search')) {
        if (isSearchFocused()) {
          e.preventDefault()
          onClearSearchFocus()
          return
        }
        if (shouldBlockAppShortcut(e.target)) return
        e.preventDefault()
        onFocusSearch()
        return
      }

      if (matchShortcut(e, 'newChat')) {
        if (shouldBlockAppShortcut(e.target)) return
        e.preventDefault()
        onNewChat()
        return
      }

      if (matchShortcut(e, 'settings')) {
        if (shouldBlockAppShortcut(e.target)) return
        e.preventDefault()
        onOpenSettings()
        return
      }

      if (matchShortcut(e, 'closeChat')) {
        if (!chatViewActive) return
        if (shouldBlockAppShortcut(e.target)) return
        e.preventDefault()
        onCloseChat?.()
        return
      }

      if (matchShortcut(e, 'focusComposer')) {
        if (!chatViewActive) return
        if (isEditableShortcutTarget(e.target)) return
        e.preventDefault()
        if (focusBrowserUrlIfOpen()) return
        const el = document.querySelector(COMPOSER_MESSAGE_SELECTOR) as HTMLElement | null
        if (!el) return
        if (el.getAttribute('contenteditable') === 'false') return
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
    onCloseChat,
    chatViewActive,
    running,
    onStop,
    drawerOpen,
    hasSessionQuery
  ])
}
