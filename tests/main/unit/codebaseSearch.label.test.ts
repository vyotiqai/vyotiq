import { describe, expect, it } from 'vitest'
import { codebaseSearchLexicalOnlyReason } from '@main/agent/tools/codebaseSearch'
import {
  DENSEON_ONNX_MODEL_ID,
  LFM2_EMBEDDING_MODEL_ID,
  MDENSEON_MODEL_ID
} from '@main/agent/codeindex/types'

describe('codebaseSearchLexicalOnlyReason', () => {
  it('same neural family (stored DenseOn-ONNX vs resolved mDenseOn) is not a mismatch', () => {
    const r = codebaseSearchLexicalOnlyReason(DENSEON_ONNX_MODEL_ID, MDENSEON_MODEL_ID)
    expect(r.hashFallback).toBe(false)
    expect(r.queryIndexMismatch).toBe(false)
  })

  it('identical model ids are not a mismatch', () => {
    const r = codebaseSearchLexicalOnlyReason(MDENSEON_MODEL_ID, MDENSEON_MODEL_ID)
    expect(r).toEqual({ hashFallback: false, queryIndexMismatch: false })
  })

  it('cross-family (lfm2 query vs LightOn store) is a true mismatch', () => {
    const r = codebaseSearchLexicalOnlyReason(MDENSEON_MODEL_ID, LFM2_EMBEDDING_MODEL_ID)
    expect(r.hashFallback).toBe(false)
    expect(r.queryIndexMismatch).toBe(true)
  })

  it('hash on either side is always hashFallback, never a separate mismatch', () => {
    expect(codebaseSearchLexicalOnlyReason('local-hash-v1', MDENSEON_MODEL_ID)).toEqual({
      hashFallback: true,
      queryIndexMismatch: false
    })
    expect(codebaseSearchLexicalOnlyReason(MDENSEON_MODEL_ID, 'local-hash-v1')).toEqual({
      hashFallback: true,
      queryIndexMismatch: false
    })
  })

  it('unknown/empty model ids do not produce a mismatch label', () => {
    expect(codebaseSearchLexicalOnlyReason('', MDENSEON_MODEL_ID).queryIndexMismatch).toBe(false)
    expect(codebaseSearchLexicalOnlyReason(MDENSEON_MODEL_ID, '').queryIndexMismatch).toBe(false)
  })
})
