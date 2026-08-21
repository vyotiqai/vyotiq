import { describe, expect, it } from 'vitest'
import {
  loopHintForEvictedMcpTools,
  loopHintForMcpNotInCatalogFailFast,
  MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD,
  mcpNotInCatalogFailFastMessage,
  recordMcpNotInCatalogFailure
} from '../../../src/main/agent/loopPolicy'
import { mcpToolsOmittedRunNotice } from '../../../src/shared/utils/mcpRunNotice'

describe('mcpToolsOmittedRunNotice', () => {
  it('returns undefined when nothing was omitted', () => {
    expect(mcpToolsOmittedRunNotice(0)).toBeUndefined()
  })

  it('mentions request_mcp_tools for deferred MCP tools', () => {
    const notice = mcpToolsOmittedRunNotice(3, 'budget')
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