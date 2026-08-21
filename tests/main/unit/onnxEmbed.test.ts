import { describe, expect, it } from 'vitest'
import { clsPoolLastHidden } from '@main/agent/codeindex/onnxEmbed'

describe('clsPoolLastHidden', () => {
  it('takes the CLS token of each row in [batch, seq, hidden] and L2-normalizes', () => {
    // batch=2, seq=3, hidden=4
    // row0 CLS [3, 0, 0, 0] → [1, 0, 0, 0]
    // row1 CLS [0, 4, 0, 0] → [0, 1, 0, 0]
    const hidden = 4
    const seq = 3
    const data = new Float32Array([
      3, 0, 0, 0, 9, 9, 9, 9, 8, 8, 8, 8, // batch 0
      0, 4, 0, 0, 7, 7, 7, 7, 6, 6, 6, 6 // batch 1
    ])
    const out = clsPoolLastHidden(data, [2, seq, hidden], hidden, 2)
    expect(out).toHaveLength(2)
    expect([...out[0]!]).toEqual([1, 0, 0, 0])
    expect([...out[1]!]).toEqual([0, 1, 0, 0])
  })

  it('treats [seq, hidden] as a single sequence (first token)', () => {
    const data = new Float32Array([0, 5, 0, 0, 1, 1, 1, 1])
    const out = clsPoolLastHidden(data, [2, 4], 4, 1)
    expect(out).toHaveLength(1)
    expect([...out[0]!]).toEqual([0, 1, 0, 0])
  })
})
