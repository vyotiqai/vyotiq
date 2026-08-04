import { SHORTCUT_BINDINGS, type ShortcutId } from './bindings'

export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

/**
 * True when `e` matches the binding for `id`.
 * Mod chords require Cmd/Ctrl, reject Alt and Shift.
 * Escape (stop) ignores Ctrl/Meta/Alt so modified Esc never stops a run.
 */
export function matchShortcut(e: ShortcutKeyEvent, id: ShortcutId): boolean {
  const binding = SHORTCUT_BINDINGS[id]
  if (e.key.toLowerCase() !== binding.key) return false
  if (binding.mod) {
    if (!(e.metaKey || e.ctrlKey)) return false
    if (e.altKey) return false
    if (e.shiftKey) return false
    return true
  }
  if (id === 'stop') {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
  }
  return true
}

/** True when the event target is a text field where app chords should not steal. */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  return Boolean(el.isContentEditable)
}
