import { describe, expect, it } from 'vitest'
import {
  resolveNewCommandBlockUntilMs,
  resolveSessionPollBlockUntilMs,
  TERMINAL_DEFAULT_TIMEOUT_MS
} from '@main/agent/tools/terminal'

describe('resolveNewCommandBlockUntilMs', () => {
  it('uses timeoutMs when block_until_ms is omitted', () => {
    expect(resolveNewCommandBlockUntilMs({ timeoutMs: 120_000 })).toBe(120_000)
  })

  it('uses block_until_ms when timeoutMs is omitted', () => {
    expect(resolveNewCommandBlockUntilMs({ block_until_ms: 1_000 })).toBe(1_000)
  })

  it('waits the larger when both are set', () => {
    expect(
      resolveNewCommandBlockUntilMs({ block_until_ms: 1_000, timeoutMs: 120_000 })
    ).toBe(120_000)
    expect(
      resolveNewCommandBlockUntilMs({ block_until_ms: 180_000, timeoutMs: 120_000 })
    ).toBe(180_000)
  })

  it('backgrounds immediately when block_until_ms is 0 even if timeoutMs is set', () => {
    expect(resolveNewCommandBlockUntilMs({ block_until_ms: 0, timeoutMs: 120_000 })).toBe(0)
  })

  it('defaults when both are omitted', () => {
    expect(resolveNewCommandBlockUntilMs({})).toBe(TERMINAL_DEFAULT_TIMEOUT_MS)
  })
})

describe('resolveSessionPollBlockUntilMs', () => {
  it('uses block_until_ms when set', () => {
    expect(resolveSessionPollBlockUntilMs({ block_until_ms: 10_000 })).toBe(10_000)
  })

  it('defaults to 30s when omitted', () => {
    expect(resolveSessionPollBlockUntilMs({})).toBe(30_000)
  })

  it('does not use timeoutMs', () => {
    expect(resolveSessionPollBlockUntilMs({ block_until_ms: 50, timeoutMs: 120_000 } as { block_until_ms?: number })).toBe(50)
  })
})
