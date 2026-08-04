import { SHORTCUT_BINDINGS, type ShortcutId } from './bindings'

function isDarwin(): boolean {
  return typeof window !== 'undefined' && window.vyotiq?.platform === 'darwin'
}

function keyGlyph(key: string): string {
  if (key === 'escape') return 'Esc'
  if (key === ',') return ','
  return key.toUpperCase()
}

/** Platform-correct label for a shortcut (Darwin `⌘K` vs `Ctrl+K`). */
export function shortcutLabel(id: ShortcutId): string {
  const binding = SHORTCUT_BINDINGS[id]
  const glyph = keyGlyph(binding.key)
  if (!binding.mod) return glyph
  return isDarwin() ? `⌘${glyph}` : `Ctrl+${glyph}`
}
