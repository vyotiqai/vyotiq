import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@main/agent/providers/types'
import { AGENT_TOOLS } from '@main/agent/types'
import {
  buildStepToolCatalog,
  isOptionalBuiltinName,
  loopHintForDeferredMcpTools,
  DEFERRED_MCP_HINT_CAP,
  UNUSED_PINNED_MCP_TTL_STEPS,
  toolCatalogFingerprint
} from '@main/agent/context/toolsBudget'
import { toolsBudgetFromRaw } from '@shared/domain/contextBudget'

function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} }
  }
}

describe('buildStepToolCatalog', () => {
  it('keeps every builtin including formerly deferred browser and merge tools', () => {
    const builtins = [
      tool('read', 'read files'),
      tool('edit', 'edit files'),
      tool('browser_navigate', 'nav'),
      tool('browser_click', 'click'),
      tool('browser_hover', 'hover'),
      tool('diagnostics', 'diag'),
      tool('merge_agent_instance', 'merge')
    ]
    const result = buildStepToolCatalog(builtins, 1_000_000)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(builtins.map((t) => t.name))
    expect(result.tools.map((t) => t.name)).toContain('browser_hover')
    expect(result.tools.map((t) => t.name)).toContain('merge_agent_instance')
  })

  it('keeps sticky names without dropping tools from the full catalog', () => {
    const builtins = [
      tool('read', 'read'),
      tool('browser_navigate', 'nav'),
      tool('browser_hover', 'hover')
    ]
    const sticky = buildStepToolCatalog(builtins, 1_000_000, {
      stickyKeptNames: new Set(['read', 'browser_navigate'])
    })
    expect(sticky.ok).toBe(true)
    if (!sticky.ok) return
    expect(sticky.tools.map((t) => t.name)).toEqual(builtins.map((t) => t.name))
  })

  it('offers the full AGENT_TOOLS catalog including hover and merge', () => {
    expect(isOptionalBuiltinName('browser_hover')).toBe(true)
    expect(isOptionalBuiltinName('merge_agent_instance')).toBe(true)

    const result = buildStepToolCatalog(AGENT_TOOLS, toolsBudgetFromRaw(32_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.some((t) => t.name === 'browser_navigate')).toBe(true)
    expect(result.tools.some((t) => t.name === 'diagnostics')).toBe(true)
    expect(result.tools.some((t) => t.name === 'spawn_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'await_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'pull_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'merge_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'browser_hover')).toBe(true)
    expect(result.evictedMcpNames).toEqual([])
    expect(result.budgetOmittedMcpNames).toEqual([])
    expect(result.omittedMcp).toBe(0)
  })

  it('includes unpinned MCP tools', () => {
    const tools = [
      tool('read', 'read'),
      tool('mcp__a__one', 'small'),
      tool('mcp__b__two', 'also small')
    ]
    const result = buildStepToolCatalog(tools, 1_000_000)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(result.omittedMcp).toBe(0)
    expect(result.policyDeferredMcpNames).toEqual([])
    expect(result.budgetOmittedMcpNames).toEqual([])
  })

  it('does not drop unpinned MCP when a pin set is provided', () => {
    const tools = [
      tool('read', 'read'),
      tool('mcp__a__one', 'small'),
      tool('mcp__pin__need', 'needed')
    ]
    const result = buildStepToolCatalog(tools, 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__need']),
      deferUnpinnedMcp: true
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(result.policyDeferredMcpNames).toEqual([])
  })

  it('builds a Level-1 hint for deferred MCP tools with cap', () => {
    expect(loopHintForDeferredMcpTools([])).toBeUndefined()
    const names = Array.from({ length: DEFERRED_MCP_HINT_CAP + 3 }, (_, i) => `mcp__s__t${i}`)
    const defs = names.map((name) => tool(name, `desc for ${name}`))
    const hint = loopHintForDeferredMcpTools(names, defs)
    expect(hint).toBeTruthy()
    expect(hint).toMatch(/connected MCP tool\(s\) are omitted/)
    expect(hint).toMatch(/unpinned/)
    expect(hint).toMatch(/mcp__s__t0: desc for mcp__s__t0/)
    expect(hint).toMatch(/request_mcp_tools/)
    expect(hint).toMatch(/mcp_list_tools/)
    expect(hint).toMatch(new RegExp(`\\+${3} more`))
    expect(hint).not.toMatch(/mcp__s__t12:/)
  })

  it('never returns TOOLS_BUDGET_OVERFLOW', () => {
    const tools = [
      tool('read', 'read'),
      tool('mcp__b__two', 'y'.repeat(500))
    ]
    const result = buildStepToolCatalog(tools, 50, { deferUnpinnedMcp: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
  })

  it('keeps sticky catalog fingerprint stable for the full tool list', () => {
    const required = [tool('read', 'r'), tool('edit', 'e')]
    const optional = [tool('browser_hover', 'hover')]
    const first = buildStepToolCatalog([...required, ...optional], 1_000_000)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.fingerprint).toBe(toolCatalogFingerprint(first.tools))
    expect(first.tools.map((t) => t.name)).toContain('browser_hover')
    const second = buildStepToolCatalog([...required, ...optional], 1_000_000, {
      stickyKeptNames: new Set(first.tools.map((t) => t.name))
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('does not evict unused pinned MCP after the idle TTL', () => {
    const tools = [
      tool('read', 'Read a file in the workspace'),
      tool('edit', 'Edit a file in the workspace'),
      tool('browser_hover', 'Hover a snapshot ref'),
      tool('mcp__github__create_issue', 'Create a GitHub issue from title and body'),
      tool('mcp__github__list_issues', 'List GitHub issues in the current repository')
    ]
    const pinned = new Set(['mcp__github__create_issue', 'mcp__github__list_issues'])
    const lastUsed = new Map([
      ['mcp__github__create_issue', 2],
      ['mcp__github__list_issues', 2]
    ])
    const expired = buildStepToolCatalog(tools, 1_000_000, {
      pinnedMcpNames: pinned,
      deferUnpinnedMcp: true,
      catalogStep: 2 + UNUSED_PINNED_MCP_TTL_STEPS,
      mcpLastUsedByName: lastUsed
    })
    expect(expired.ok).toBe(true)
    if (!expired.ok) return
    expect(expired.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(expired.evictedMcpNames).toEqual([])
  })

  it('keeps required builtins, deferred builtins, and unstamped pins', () => {
    const tools = [
      tool('read', 'Read a file in the workspace'),
      tool('browser_hover', 'Hover a snapshot ref'),
      tool('mcp__linear__create_issue', 'Create a Linear issue from title and description')
    ]
    const result = buildStepToolCatalog(tools, 1_000_000, {
      pinnedMcpNames: new Set(['mcp__linear__create_issue']),
      stickyKeptNames: new Set(['read', 'browser_hover', 'mcp__linear__create_issue']),
      deferUnpinnedMcp: true,
      catalogStep: 20,
      mcpLastUsedByName: new Map()
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(result.evictedMcpNames).toEqual([])
  })

  it('does not evict unused sticky MCP pins', () => {
    const tools = [
      tool('read', 'Read a file in the workspace'),
      tool('mcp__github__create_issue', 'Create a GitHub issue from title and body'),
      tool('mcp__github__list_pulls', 'List pull requests for the current repository')
    ]
    const result = buildStepToolCatalog(tools, 1_000_000, {
      pinnedMcpNames: new Set(['mcp__github__create_issue', 'mcp__github__list_pulls']),
      stickyKeptNames: new Set(['read', 'mcp__github__create_issue', 'mcp__github__list_pulls']),
      deferUnpinnedMcp: true,
      catalogStep: 10,
      mcpLastUsedByName: new Map([
        ['mcp__github__create_issue', 9],
        ['mcp__github__list_pulls', 3]
      ])
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(result.evictedMcpNames).toEqual([])
  })
})
