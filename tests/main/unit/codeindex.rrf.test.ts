import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion } from '@main/agent/codeindex/rrf'

describe('reciprocalRankFusion', () => {
  it('merges ranked lists with stable RRF scores', () => {
    const fused = reciprocalRankFusion(
      [
        ['a', 'b', 'c'],
        ['b', 'd', 'a']
      ],
      60
    )
    expect(fused[0]!.id).toBe('b')
    expect(fused.map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    const scoreB = fused.find((x) => x.id === 'b')!.score
    const scoreA = fused.find((x) => x.id === 'a')!.score
    expect(scoreB).toBeGreaterThan(scoreA)
  })

  it('handles single list', () => {
    const fused = reciprocalRankFusion([['x', 'y']])
    expect(fused.map((f) => f.id)).toEqual(['x', 'y'])
  })
})
