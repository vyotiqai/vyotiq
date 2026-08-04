/**
 * Streamed tool arguments arrive as concatenated deltas, so a dropped or
 * truncated frame leaves JSON that is structurally unfinished but otherwise
 * intact. Repair is deliberately limited to punctuation: trailing commas,
 * unterminated strings, and unclosed braces/brackets. No value is ever
 * invented, and a partially received key/value pair is discarded rather than
 * guessed.
 */

/**
 * Linear scan is cheap; size only bounds pathological / DoS-sized payloads.
 * Live evidence: Luna streamed a truncated `edit` at ~293 KiB — under the old
 * 256 KiB cap repair was skipped and the call failed as TOOL_ARGS.
 */
export const MAX_REPAIR_BYTES = 1024 * 1024

type ScanState = {
  /** Open containers in order, e.g. ['{', '[']. */
  stack: string[]
  inString: boolean
  escaped: boolean
  /** Cut index just past the last complete element, i.e. after an opener or before a comma. */
  lastBoundary: number
}

function scan(text: string): ScanState {
  const stack: string[] = []
  let inString = false
  let escaped = false
  let lastBoundary = -1

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
      lastBoundary = i + 1
      continue
    }
    if (ch === '}' || ch === ']') {
      stack.pop()
      continue
    }
    if (ch === ',' && stack.length > 0) lastBoundary = i
  }

  return { stack, inString, escaped, lastBoundary }
}

function closers(stack: string[]): string {
  return stack
    .slice()
    .reverse()
    .map((open) => (open === '{' ? '}' : ']'))
    .join('')
}

function stripTrailingComma(text: string): string {
  return text.replace(/,\s*$/, '')
}

function tryParse(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    // Tool arguments are always an object; a bare scalar or array means the repair
    // produced something the caller cannot use.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return text
  } catch {
    return null
  }
}

/**
 * Returns a parseable JSON string, or `null` when the input cannot be repaired
 * without guessing. Input that already parses is returned unchanged.
 */
export function repairToolArgs(raw: string): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  if (text.length > MAX_REPAIR_BYTES) return null

  const asIs = tryParse(text)
  if (asIs) return asIs

  const state = scan(text)
  if (state.stack.length === 0 && !state.inString) return null

  // 1. Close an unterminated string, drop a trailing comma, close containers.
  let candidate = state.escaped ? text.slice(0, -1) : text
  if (state.inString) candidate += '"'
  candidate = stripTrailingComma(candidate) + closers(state.stack)
  const closed = tryParse(candidate)
  if (closed) return closed

  // 2. The tail holds a half-received pair (`"path":` or `"pa`). Cut back to the
  //    last complete element and close from there.
  if (state.lastBoundary >= 0) {
    const head = text.slice(0, state.lastBoundary)
    const headState = scan(head)
    if (!headState.inString) {
      const truncated = stripTrailingComma(head) + closers(headState.stack)
      const repaired = tryParse(truncated)
      if (repaired) return repaired
    }
  }

  return null
}
