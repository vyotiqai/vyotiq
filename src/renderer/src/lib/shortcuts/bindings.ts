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
  | 'dictation'
  | 'cycleMode'
  | 'panelTerminal'
  | 'panelChanges'
  | 'panelBrowser'
  | 'panelFiles'
  | 'panelPlan'
  | 'panelPr'
  | 'closeChat'
  | 'findInFiles'
  | 'commandPalette'

export type ShortcutShift = 'forbid' | 'allow' | 'require'

export type ShortcutBinding = {
  id: ShortcutId
  /** Normalized key (`e.key.toLowerCase()`). */
  key: string
  /** Requires Cmd (macOS) or Ctrl. */
  mod: boolean
  /** Mod chords default to forbidding Shift. */
  shift?: ShortcutShift
}

export const SHORTCUT_BINDINGS: Record<ShortcutId, ShortcutBinding> = {
  sidebar: { id: 'sidebar', key: 'b', mod: true },
  search: { id: 'search', key: 'k', mod: true },
  newChat: { id: 'newChat', key: 'n', mod: true },
  settings: { id: 'settings', key: ',', mod: true },
  focusComposer: { id: 'focusComposer', key: 'l', mod: true },
  stop: { id: 'stop', key: 'escape', mod: false },
  find: { id: 'find', key: 'f', mod: true },
  refresh: { id: 'refresh', key: 'r', mod: true },
  dictation: { id: 'dictation', key: 'm', mod: true },
  cycleMode: { id: 'cycleMode', key: '.', mod: true, shift: 'allow' },
  panelTerminal: { id: 'panelTerminal', key: '`', mod: true },
  panelChanges: { id: 'panelChanges', key: 'e', mod: true },
  panelBrowser: { id: 'panelBrowser', key: 'b', mod: true, shift: 'require' },
  panelFiles: { id: 'panelFiles', key: 'e', mod: true, shift: 'require' },
  panelPlan: { id: 'panelPlan', key: 'd', mod: true, shift: 'require' },
  panelPr: { id: 'panelPr', key: 'g', mod: true, shift: 'require' },
  closeChat: { id: 'closeChat', key: 'w', mod: true },
  findInFiles: { id: 'findInFiles', key: 'f', mod: true, shift: 'require' },
  commandPalette: { id: 'commandPalette', key: 'p', mod: true, shift: 'require' }
}
