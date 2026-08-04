import { describe, expect, it } from 'vitest'
import {
  loopHintForCompactionPaybackSkip,
  loopHintForEvictedMcpTools,
  loopHintForMcpNotInCatalogFailFast,
  MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD,
  mcpNotInCatalogFailFastMessage,
  recordMcpNotInCatalogFailure,
  runNoticeForHighThinkingCost,
  runNoticeForOmittedMcpTools
} from '../../../src/main/agent/loopPolicy'

describe('runNoticeForOmittedMcpTools', () => {
  it('returns undefined when nothing was omitted', () => {
    expect(runNoticeForOmittedMcpTools(0)).toBeUndefined()
  })

  it('mentions request_mcp_tools for deferred MCP tools', () => {
    const notice = runNoticeForOmittedMcpTools(3)
    expect(notice).toMatch(/3 MCP tools were deferred/i)
    expect(notice).toMatch(/request_mcp_tools/)
  })
})

describe('loopHintForEvictedMcpTools', () => {
  it('mentions re-pin and release after idle unload', () => {
    expect(loopHintForEvictedMcpTools([])).toBeUndefined()
    const hint = loopHintForEvictedMcpTools(['mcp__a__t', 'mcp__b__u'])
    expect(hint).toMatch(/unloaded/)
    expect(hint).toMatch(/request_mcp_tools/)
    expect(hint).toMatch(/release_mcp_tools/)
  })
})

describe('token-cost loop notices', () => {
  it('mentions /clear when compaction LLM is skipped', () => {
    expect(loopHintForCompactionPaybackSkip('fold_too_small')).toMatch(/\/clear/)
    expect(loopHintForCompactionPaybackSkip('residual_above_trigger')).toMatch(/soft trigger/)
  })

  it('surfaces high thinking cost without changing settings', () => {
    expect(runNoticeForHighThinkingCost(12)).toMatch(/step 12/)
    expect(runNoticeForHighThinkingCost(12)).toMatch(/\/clear/)
  })
})

describe('MCP not-in-catalog fail-fast', () => {
  it('records per-tool counts and builds fail-fast copy', () => {
    const counts = new Map<string, number>()
    expect(recordMcpNotInCatalogFailure(counts, 'mcp__a__t')).toBe(1)
    expect(recordMcpNotInCatalogFailure(counts, 'mcp__a__t')).toBe(2)
    expect(MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD).toBe(2)
    expect(mcpNotInCatalogFailFastMessage('mcp__a__t', 2)).toMatch(/FAIL-FAST/)
    expect(loopHintForMcpNotInCatalogFailFast(['mcp__a__t'])).toMatch(/request_mcp_tools/)
    expect(loopHintForMcpNotInCatalogFailFast([])).toBeUndefined()
  })
})