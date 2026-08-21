/**
 * Classic overlapping trigrams for Instant Grep-style candidate pruning.
 * Source: Zobel/Cox / Cursor fast-regex-search (classic algorithm section).
 * False positives only — callers must verify with the real regex.
 */

export const TRIGRAM_LEN = 3

/** Extract unique overlapping 3-char grams from text. */
export function extractTrigrams(text: string, caseSensitive: boolean): Set<string> {
  const src = caseSensitive ? text : text.toLowerCase()
  const out = new Set<string>()
  if (src.length < TRIGRAM_LEN) return out
  for (let i = 0; i <= src.length - TRIGRAM_LEN; i++) {
    out.add(src.slice(i, i + TRIGRAM_LEN))
  }
  return out
}

/**
 * Literal runs long enough for trigrams (letters, digits, `_`, `$`, `.`, `-`).
 * Used when decomposing regex / substring queries.
 */
const LITERAL_RUN = /[A-Za-z0-9_$.-]{3,}/g

/**
 * Extract AND-required trigram sets from a user pattern.
 * Returns null when the pattern cannot safely prune (bail to live scan).
 *
 * Strategy (lean v1):
 * - Strip common regex metacharacter escapes for literal extraction on the
 *   remaining alphanumeric runs (identifiers, paths).
 * - Require at least one trigram; intersect all grams from all literal runs
 *   (AND). Over-prunes only if we miss alternations — for `(a|b)` we take grams
 *   from both runs as AND which is wrong; detect `|` outside classes → null.
 */
export function requiredTrigramsForPattern(
  pattern: string,
  caseSensitive: boolean
): Set<string> | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null

  // Broad / empty-match patterns — cannot prune safely.
  if (
    trimmed === '.' ||
    trimmed === '.*' ||
    trimmed === '.+' ||
    trimmed === '^' ||
    trimmed === '$' ||
    trimmed === '^$' ||
    /^\.\*$/.test(trimmed) ||
    /^\.\+$/.test(trimmed)
  ) {
    return null
  }

  // Alternation or lookaround → live scan (v1).
  if (/(^|[^\\])\|/.test(trimmed) || /\(\?/.test(trimmed)) return null

  // Character class with range or too many alternatives → skip.
  if (/\[[^\]]*[-^\\]/.test(trimmed) && /\[[^\]]{4,}\]/.test(trimmed)) {
    // Large/complex classes: still try literals outside classes
  }

  // Remove character classes content for literal harvest (keep surrounding).
  const withoutClasses = trimmed.replace(/\[[^\]]*]/g, ' ')
  // Unescape simple escaped literals: \. \( \) etc. → keep char if alphanumeric-ish
  const unescaped = withoutClasses.replace(/\\(.)/g, '$1')
  // Drop remaining regex metacharacters for run extraction
  const forRuns = unescaped.replace(/[.*+?^${}()|[\]\\]/g, ' ')

  const runs = forRuns.match(LITERAL_RUN)
  if (!runs || runs.length === 0) return null

  const required = new Set<string>()
  for (const run of runs) {
    const grams = extractTrigrams(run, caseSensitive)
    if (grams.size === 0) continue
    for (const g of grams) required.add(g)
  }
  if (required.size === 0) return null
  // Cap AND set size — too many grams → intersect becomes tiny/empty wrongly if
  // we AND across distant literals that may not co-occur in one file.
  // Use grams from the *longest* literal run only (most selective identifier).
  let best = runs[0]!
  for (const r of runs) {
    if (r.length > best.length) best = r
  }
  return extractTrigrams(best, caseSensitive)
}

/** Case-insensitive substring → required trigrams (null if query too short). */
export function requiredTrigramsForSubstring(
  query: string,
  caseSensitive: boolean
): Set<string> | null {
  const q = query.trim()
  if (q.length < TRIGRAM_LEN) return null
  const grams = extractTrigrams(q, caseSensitive)
  return grams.size > 0 ? grams : null
}
