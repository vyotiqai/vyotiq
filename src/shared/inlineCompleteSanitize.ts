const SUGGESTION_MAX = 500
const CURSOR_MARK = '<<<CURSOR>>>'

export { CURSOR_MARK, SUGGESTION_MAX }

function identAtEnd(prefix: string): string {
  let i = prefix.length
  while (i > 0 && /[A-Za-z0-9_$]/.test(prefix.charAt(i - 1))) i -= 1
  return prefix.slice(i)
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  const wrapped = trimmed.match(/^```(?:[\w.+-]+)?\n([\s\S]*?)\n```$/)
  if (wrapped?.[1] != null) return wrapped[1]
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:[\w.+-]+)?\n?/, '').replace(/\n?```$/, '')
  }
  return text
}

function dropPrefixEcho(text: string, prefix: string): string {
  const tail = prefix.slice(-80)
  if (tail.length >= 8 && text.startsWith(tail)) return text.slice(tail.length)

  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (
    lastLine.length >= 2 &&
    /[\s=(){}[\];,.:<>+\-*/]/.test(lastLine) &&
    text.startsWith(lastLine)
  ) {
    return text.slice(lastLine.length)
  }

  const ident = identAtEnd(prefix)
  if (ident.length > 0 && text.startsWith(ident)) return text.slice(ident.length)
  return text
}

function dropSuffixEcho(text: string, suffix: string): string {
  const suffixHead = suffix.slice(0, 200)
  for (let n = Math.min(text.length, suffixHead.length); n > 0; n--) {
    if (text.endsWith(suffixHead.slice(0, n))) {
      return text.slice(0, text.length - n)
    }
  }
  return text
}

function dropOverlap(text: string, prefix: string, suffix: string): string {
  let next = dropPrefixEcho(text, prefix)
  if (next.startsWith('\n') && prefix.endsWith('\n')) next = next.replace(/^\n+/, '')
  return dropSuffixEcho(next, suffix)
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^\s+/, '')
    if (trimmed) return trimmed
  }
  return ''
}

function substantialLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 16)
}

/** True when the suggestion is copying a nearby line instead of filling the gap. */
export function isContextEcho(text: string, prefix: string, suffix: string): boolean {
  const context = new Set([...substantialLines(prefix), ...substantialLines(suffix)])
  for (const line of substantialLines(text)) {
    if (context.has(line)) return true
  }
  const probe = firstNonEmptyLine(text)
  if (probe.length < 16) return false
  const clip = probe.slice(0, 40)
  return prefix.includes(clip) || suffix.includes(clip)
}

/** True when PREFIX ends in a token and the suggestion starts an unrelated construct. */
export function ignoresCurrentToken(prefix: string, suggestion: string): boolean {
  const ident = identAtEnd(prefix)
  if (ident.length < 2) return false
  const start = suggestion.match(/\S/)?.[0]
  if (!start) return false
  if (/[A-Za-z0-9_$.]/.test(start)) return false
  if (/[([{,;:=!?*+\-/|&]/.test(start)) return false
  return true
}

function capAtLine(text: string): string {
  if (text.length <= SUGGESTION_MAX) return text
  const sliced = text.slice(0, SUGGESTION_MAX)
  const lastNl = sliced.lastIndexOf('\n')
  if (lastNl >= Math.floor(SUGGESTION_MAX * 0.5)) return sliced.slice(0, lastNl)
  return sliced
}

/** Strip fences, suffix/prefix echo, and junk. Empty when there is nothing to insert. */
export function sanitizeInlineSuggestion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/\r\n/g, '\n')
  text = stripFences(text)
  text = text.replace(/```(?:[\w.+-]+)?\n?/g, '').replace(/```/g, '')
  if (/<\|[^|]{0,40}\|>/.test(text)) return ''
  const visible = text.trim()
  if (!visible) return ''
  if (/\bPREFIX\b|\bSUFFIX\b/.test(visible) && visible.length < 40) return ''
  if (text.includes(CURSOR_MARK)) return ''
  text = dropOverlap(text, prefix, suffix)
  text = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
  if (!text.trim()) return ''
  if (ignoresCurrentToken(prefix, text) || isContextEcho(text, prefix, suffix)) return ''
  return capAtLine(text)
}
