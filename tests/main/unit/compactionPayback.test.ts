import { describe, expect, it } from 'vitest'
import {
  COMPACTION_LLM_MIN_FOLD_TOKENS,
  residualFloorAfterFold,
  shouldInvokeCompactionLlm
} from '../../../src/main/agent/context/compactionPayback'

describe('shouldInvokeCompactionLlm', () => {
  it('skips when fold is below absolute minimum', () => {
    const d = shouldInvokeCompactionLlm({
      foldTokens: COMPACTION_LLM_MIN_FOLD_TOKENS - 1,
      residualFloor: 10_000,
      trigger: 64_000
    })
    expect(d).toEqual({ invokeLlm: false, reason: 'fold_too_small' })
  })

  it('skips when residual floor cannot land under trigger', () => {
    const d = shouldInvokeCompactionLlm({
      foldTokens: 20_000,
      residualFloor: 70_000,
      trigger: 64_000
    })
    expect(d).toEqual({ invokeLlm: false, reason: 'residual_above_trigger' })
  })

  it('prefers trim for marginal fold with prior summary', () => {
    const d = shouldInvokeCompactionLlm({
      foldTokens: 8_000,
      residualFloor: 58_000,
      trigger: 64_000,
      hasPriorLlmSummary: true
    })
    expect(d).toEqual({ invokeLlm: false, reason: 'prefer_trim' })
  })

  it('invokes when fold is large and residual can pay back', () => {
    const d = shouldInvokeCompactionLlm({
      foldTokens: 40_000,
      residualFloor: 30_000,
      trigger: 64_000
    })
    expect(d).toEqual({ invokeLlm: true, reason: 'payback' })
  })
})

describe('residualFloorAfterFold', () => {
  it('sums kept + system + tools + summary reserve', () => {
    expect(
      residualFloorAfterFold({
        keptTokens: 10_000,
        systemTokens: 5_000,
        toolsTokens: 8_000,
        summaryReserve: 1_200
      })
    ).toBe(24_200)
  })
})
