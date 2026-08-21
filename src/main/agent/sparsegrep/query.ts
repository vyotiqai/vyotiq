import { join } from 'path'
import { existsSync } from 'fs'
import { SparseGrepStore } from './store'
import { requiredTrigramsForPattern, requiredTrigramsForSubstring } from './trigram'

export type CandidateLookup =
  | { ok: true; paths: string[]; mode: 'trigram' }
  | { ok: false; reason: 'not_ready' | 'unusable_pattern' }

/**
 * Resolve candidate relative paths for a regex pattern, or signal live fallback.
 */
export function lookupCandidatesForRegex(
  store: SparseGrepStore,
  pattern: string,
  caseSensitive: boolean
): CandidateLookup {
  const status = store.getStatus()
  if (!status.ready) return { ok: false, reason: 'not_ready' }
  // Index stores lowercase trigrams — always extract CI grams for prune.
  const grams = requiredTrigramsForPattern(pattern, false)
  if (!grams) return { ok: false, reason: 'unusable_pattern' }
  void caseSensitive // verify step uses real flags; prune is CI
  const paths = store.filesContainingAllTrigrams(grams)
  return { ok: true, paths, mode: 'trigram' }
}

/** Substring (non-regex) search content prune. */
export function lookupCandidatesForSubstring(
  store: SparseGrepStore,
  query: string
): CandidateLookup {
  const status = store.getStatus()
  if (!status.ready) return { ok: false, reason: 'not_ready' }
  const grams = requiredTrigramsForSubstring(query, false)
  if (!grams) return { ok: false, reason: 'unusable_pattern' }
  const paths = store.filesContainingAllTrigrams(grams)
  return { ok: true, paths, mode: 'trigram' }
}

/** Map relative paths to absolute under workspace; drop missing. */
export function resolveCandidateFullPaths(
  workspaceRoot: string,
  relPaths: string[]
): { full: string; rel: string }[] {
  const out: { full: string; rel: string }[] = []
  for (const rel of relPaths) {
    const full = join(workspaceRoot, ...rel.split('/'))
    if (existsSync(full)) out.push({ full, rel })
  }
  return out
}
