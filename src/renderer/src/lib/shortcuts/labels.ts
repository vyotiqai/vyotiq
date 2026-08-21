import { SHORTCUT_BINDINGS, type ShortcutId } from './bindings'

function isDarwin(): boolean {
  return typeof window !== 'undefined' && window.vyotiq?.platform === 'darwin'
}

function keyGlyph(key: string): string {
  if (key === 'escape') return 'Esc'
  if (key === ',') return ','
  return key.toUpperCase()
}

function modPrefix(): string {
  return isDarwin() ? '⌘' : 'Ctrl+'
}

/** Platform-correct label for a shortcut (Darwin `⌘K` vs `Ctrl+K`). */
export function shortcutLabel(id: ShortcutId): string {
  const binding = SHORTCUT_BINDINGS[id]
  const glyph = keyGlyph(binding.key)
  if (!binding.mod) return glyph
  const shift = binding.shift === 'require'
  if (isDarwin()) return shift ? `⌘⇧${glyph}` : `⌘${glyph}`
  return shift ? `Ctrl+Shift+${glyph}` : `Ctrl+${glyph}`
}

export const SHORTCUT_TITLES: Record<ShortcutId, string> = {
  sidebar: 'Toggle sidebar',
  search: 'Search chats',
  newChat: 'New chat',
  settings: 'Open settings',
  focusComposer: 'Focus composer',
  stop: 'Stop run',
  find: 'Find in transcript, changes, or PR',
  refresh: 'Refresh changes or PR',
  dictation: 'Dictation',
  cycleMode: 'Cycle Ask / Plan / Agent',
  panelTerminal: 'Terminal panel',
  panelChanges: 'Changes panel',
  panelBrowser: 'Browser panel',
  closeChat: 'Close chat tab'
}

export type ShortcutCatalogEntry = {
  id: string
  title: string
  label: string
}

/** Chords that exist in the app but are not in SHORTCUT_BINDINGS. */
export function extraShortcutCatalog(): ShortcutCatalogEntry[] {
  const mod = modPrefix()
  return [
    { id: 'jump-latest', title: 'Jump to latest', label: 'End' },
    { id: 'jump-top', title: 'Jump to top', label: 'Home' },
    { id: 'edit-last', title: 'Edit last prompt', label: '↑' },
    { id: 'font-smaller', title: 'Smaller text', label: `${mod}-` },
    { id: 'font-larger', title: 'Larger text', label: `${mod}=` },
    { id: 'font-reset', title: 'Reset text size', label: `${mod}0` }
  ]
}

export function shortcutCatalog(): ShortcutCatalogEntry[] {
  const ids = Object.keys(SHORTCUT_BINDINGS) as ShortcutId[]
  return [
    ...ids.map((id) => ({
      id,
      title: SHORTCUT_TITLES[id],
      label: shortcutLabel(id)
    })),
    ...extraShortcutCatalog()
  ]
}
