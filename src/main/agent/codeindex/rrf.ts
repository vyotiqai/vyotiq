import { RRF_K } from './types'

export type RankedId = { id: string; rank: number }

/**
 * Reciprocal Rank Fusion over one or more ranked id lists.
 * score(d) = Σ 1/(k + rank) with 1-based ranks.
 */
export function reciprocalRankFusion(
  rankedLists: string[][],
  k: number = RRF_K
): { id: string; score: number }[] {
  const scores = new Map<string, number>()
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!
      const add = 1 / (k + i + 1)
      scores.set(id, (scores.get(id) ?? 0) + add)
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
