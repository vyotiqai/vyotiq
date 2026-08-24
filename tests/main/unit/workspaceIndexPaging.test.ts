import { describe, expect, it } from 'vitest'
import {
  INDEX_WARM_BACKOFF_MS,
  INDEX_WARM_STALL_LIMIT,
  advanceWarmPagingState,
  nextWarmBackoffMs,
  warmProgressKey
} from '@main/agent/workspaceIndexPaging'

describe('workspaceIndex paging backoff', () => {
  it('fingerprints scanned/indexed/complete/cursor so zero-progress repeats are visible', () => {
    const a = warmProgressKey({
      codeScanned: 0,
      codeIndexed: 0,
      codeComplete: false,
      codeCursor: 'src/a.ts',
      sparseComplete: true
    })
    const b = warmProgressKey({
      codeScanned: 0,
      codeIndexed: 0,
      codeComplete: false,
      codeCursor: 'src/a.ts',
      sparseComplete: true
    })
    const c = warmProgressKey({
      codeScanned: 80,
      codeIndexed: 12,
      codeComplete: false,
      codeCursor: 'src/z.ts',
      sparseComplete: true
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('steps backoff 2s → 5s → 30s and stalls after two no-progress warms', () => {
    expect(nextWarmBackoffMs(undefined)).toBe(INDEX_WARM_BACKOFF_MS[0])
    expect(nextWarmBackoffMs(2_000)).toBe(INDEX_WARM_BACKOFF_MS[1])
    expect(nextWarmBackoffMs(5_000)).toBe(INDEX_WARM_BACKOFF_MS[2])
    expect(INDEX_WARM_STALL_LIMIT).toBe(1)

    const key = warmProgressKey({ codeComplete: false, codeCursor: 'same' })
    const first = advanceWarmPagingState(undefined, key)
    expect(first.stalled).toBe(false)
    expect(first.stallCount).toBe(0)
    const second = advanceWarmPagingState(first, key)
    expect(second.stalled).toBe(true)
    expect(second.stallCount).toBe(1)
  })

  it('resets stall count when the cursor/file fingerprint moves', () => {
    const first = advanceWarmPagingState(undefined, 'a')
    const stalledToward = advanceWarmPagingState(first, 'a')
    const moved = advanceWarmPagingState(stalledToward, 'b')
    expect(moved.stallCount).toBe(0)
    expect(moved.stalled).toBe(false)
    expect(moved.backoffMs).toBe(INDEX_WARM_BACKOFF_MS[0])
  })
})
