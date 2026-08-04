/** App / panel shortcut identifiers. */
export type ShortcutId =
  | 'sidebar'
  | 'search'
  | 'newChat'
  | 'settings'
  | 'focusComposer'
  | 'stop'
  | 'find'
  | 'refresh'

export type ShortcutBinding = {
  id: ShortcutId
  /** Normalized key (`e.key.toLowerCase()`). */
  key: string
  /** Requires Cmd (macOS) or Ctrl. */
  mod: boolean
}

export const SHORTCUT_BINDINGS: Record<ShortcutId, ShortcutBinding> = {
  sidebar: { id: 'sidebar', key: 'b', mod: true },
  search: { id: 'search', key: 'k', mod: true },
  newChat: { id: 'newChat', key: 'n', mod: true },
  settings: { id: 'settings', key: ',', mod: true },
  focusComposer: { id: 'focusComposer', key: 'l', mod: true },
  stop: { id: 'stop', key: 'escape', mod: false },
  find: { id: 'find', key: 'f', mod: true },
  refresh: { id: 'refresh', key: 'r', mod: true }
}
