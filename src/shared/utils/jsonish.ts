/**
 * First complete JSON value in `text` when trailing junk follows it, else null.
 * Recovers payloads a host closed twice (`[…]}`) instead of discarding them.
 */
export function completeJsonPrefix(text: string): string | null {
  const first = text[0]
  if (first !== '{' && first !== '[') return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
      continue
    }
    if (ch !== '}' && ch !== ']') continue
    depth--
    if (depth < 0) return null
    if (depth === 0) {
      return i + 1 < text.length ? text.slice(0, i + 1) : null
    }
  }
  return null
}

function endsAfterCompleteValue(text: string): boolean {
  let i = text.length - 1
  while (i >= 0 && /\s/.test(text[i]!)) i--
  if (i < 0) return false
  const ch = text[i]!
  if (ch === '}' || ch === ']' || ch === '"') return true
  if (/[0-9]/.test(ch)) return true
  const slice = text.slice(Math.max(0, i - 4), i + 1)
  return /(?:^|[^a-zA-Z])(?:true|false|null)$/.test(slice)
}

/**
 * Append missing `]` / `}` when containers are still open and the walk ended
 * after a complete value (not inside a string, not after `:` / `,`).
 */
export function closeUnterminatedJson(text: string): string | null {
  const first = text[0]
  if (first !== '{' && first !== '[') return null

  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      continue
    }
    if (ch !== '}' && ch !== ']') continue
    const open = stack.pop()
    if (!open) return null
    if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null
  }

  if (inString || stack.length === 0) return null
  if (!endsAfterCompleteValue(text)) return null

  let closed = text
  for (let i = stack.length - 1; i >= 0; i--) {
    closed += stack[i] === '{' ? '}' : ']'
  }
  return closed
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function parseJsonValue(text: string): unknown | undefined {
  const direct = tryParseJson(text)
  if (direct !== undefined) return direct
  const prefix = completeJsonPrefix(text)
  if (prefix) {
    const parsed = tryParseJson(prefix)
    if (parsed !== undefined) return parsed
  }
  const closed = closeUnterminatedJson(text)
  return closed ? tryParseJson(closed) : undefined
}

/**
 * Nested tool-arg JSON that models stringify, double-encode, or close one
 * bracket short. Truncation inside a string is never salvaged.
 */
export function parseJsonish(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const parsed = parseJsonValue(trimmed)
  if (typeof parsed === 'string') {
    const inner = parsed.trim()
    if (inner.startsWith('{') || inner.startsWith('[')) {
      const again = parseJsonValue(inner)
      if (again !== undefined) return again
    }
  }
  return parsed
}
