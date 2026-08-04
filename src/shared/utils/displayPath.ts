import { basename } from './path'

/** Strip wrapping quotes and unescape common path escape sequences for display. */
export function sanitizeDisplayPath(path: string): string {
  let value = path.trim()
  // Unwrap shell-quoted segments while keeping path separators: \"foo\" -> \foo
  value = value.replace(/\\"([^"]*)"/g, '\\$1')
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  value = value.replace(/\\"/g, '').replace(/"/g, '').replace(/\\\\/g, '\\')
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
  return value
}

/** Clean a shell command string for UI display. */
export function sanitizeCommandForDisplay(command: string): string {
  return sanitizeDisplayPath(command)
}

export function parentPath(path: string): string {
  const match = path.match(/^(.*)[/\\][^/\\]+$/)
  return match?.[1] ?? ''
}

export function formatPathForDisplay(path: string): { name: string; parent: string; full: string } {
  const full = sanitizeDisplayPath(path)
  return { name: basename(full), parent: parentPath(full), full }
}

/** Truncate long strings in the middle, preserving start and end. */
export function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const keep = Math.floor((maxLen - 1) / 2)
  return `${text.slice(0, keep)}…${text.slice(-keep)}`
}

/** Human label for a directory path in listings (avoids `. · N` looking like `.. N`). */
export function formatListDirPathLabel(path: string): string {
  const normalized = sanitizeDisplayPath(path).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || normalized === '.') return 'workspace root'
  if (normalized === '..') return 'parent directory'
  return formatPathLabel(normalized)
}

/** Normalize a raw byte size string for directory listings. */
export function formatDisplaySize(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^\d+(\.\d+)?[BKMG]$/i.test(trimmed)) return trimmed.toUpperCase()
  if (/^\d+$/.test(trimmed)) {
    const bytes = Number(trimmed)
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`
  }
  return trimmed
}

/** Show `parent/name` with middle truncation when needed. */
export function formatPathLabel(path: string, maxLen = 72): string {
  const { name, parent, full } = formatPathForDisplay(path)
  if (!parent) return truncateMiddle(full, maxLen)
  const label = `${truncateMiddle(parent, 40)}/${name}`
  return label.length > maxLen ? truncateMiddle(label, maxLen) : label
}

const READ_ONLY_TERMINAL =
  /^(?:type|cat|more|less|head|tail|Get-Content|gc)\s+/i

/** True when a terminal command only reads file contents (not mutating). */
export function isReadOnlyTerminalCommand(command: string): boolean {
  return READ_ONLY_TERMINAL.test(command.trim())
}

/** Extract the file path from a read-only shell command, if present. */
export function extractPathFromTerminalCommand(command: string): string | null {
  const match = command.trim().match(/^(?:type|cat|more|less|head|tail|Get-Content|gc)\s+(.+)$/i)
  if (!match?.[1]) return null
  return sanitizeDisplayPath(match[1].trim())
}
