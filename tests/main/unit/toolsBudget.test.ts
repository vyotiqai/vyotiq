import { describe, expect, it } from 'vitest'
import {
  trimToolsToBudget,
  toolCatalogFingerprint,
  selectMcpPinsToEvict
} from '@main/agent/context/toolsBudget'
import type { ToolDefinition } from '@main/agent/providers/types'
import {
  MCP_PIN_IDLE_TTL_STEPS,
  MCP_PINNED_SOFT_MAX
} from '../../../src/shared/domain/contextBudget'

function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} }
  }
}

describe('trimToolsToBudget', () => {
  it('keeps all built-in tools even when budget is tight', () => {
    const builtins = [
      tool('read', 'read files'),
      tool('edit', 'edit files'),
      tool('search', 'search files')
    ]
    const result = trimToolsToBudget(builtins, 50)
    expect(result.tools.map((t) => t.name)).toEqual(['read', 'edit', 'search'])
  })

  it('defers unpinned MCP by default (pin via request_mcp_tools)', () => {
    const tools = [
      tool('read', 'read'),
      tool('mcp__a__one', 'small'),
      tool('mcp__b__two', 'also small')
    ]
    const result = trimToolsToBudget(tools, 1_000_000)
    expect(result.tools.some((t) => t.name.startsWith('mcp__'))).toBe(false)
    expect(result.omittedMcp).toBe(2)
  })

  it('keeps pinned MCP when deferred mode is on', () => {
    const tools = [
      tool('read', 'read'),
      tool('mcp__a__one', 'small'),
      tool('mcp__pin__need', 'needed')
    ]
    const result = trimToolsToBudget(tools, 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__need']),
      deferUnpinnedMcp: true
    })
    expect(result.tools.map((t) => t.name)).toContain('mcp__pin__need')
    expect(result.tools.map((t) => t.name)).not.toContain('mcp__a__one')
  })

  it('drops MCP tools when over budget (legacy fill mode)', () => {
    const tools = [
      tool('read', 'read'),
      tool('mcp__a__one', 'x'.repeat(500)),
      tool('mcp__b__two', 'y'.repeat(500))
    ]
    const result = trimToolsToBudget(tools, 50, { deferUnpinnedMcp: false })
    expect(result.tools.some((t) => t.name.startsWith('mcp__'))).toBe(false)
    expect(result.omittedMcp).toBeGreaterThan(0)
  })

  it('does not pin oversized MCP tools ahead of smaller ones', () => {
    const builtins = [tool('read', 'r')]
    const small = tool('mcp__other__small', 's')
    const bigTool = tool('mcp__heavy-graph__big', 'G'.repeat(4000))
    const base = trimToolsToBudget(builtins, 1_000_000, { deferUnpinnedMcp: false }).estimate
    const withSmall = trimToolsToBudget([...builtins, small], 1_000_000, {
      deferUnpinnedMcp: false
    }).estimate
    const budget = withSmall + 1
    const result = trimToolsToBudget([...builtins, bigTool, small], budget, {
      deferUnpinnedMcp: false
    })
    const keptMcp = result.tools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name)
    expect(keptMcp).toEqual(['mcp__other__small'])
    expect(result.omittedMcpNames).toContain('mcp__heavy-graph__big')
    expect(base).toBeLessThan(withSmall)
  })

  it('prefers pinned MCP tools over smaller unpinned ones', () => {
    const builtins = [tool('read', 'r')]
    const small = tool('mcp__other__small', 's')
    const pinnedBig = tool('mcp__pin__big', 'P'.repeat(2000))
    const base = trimToolsToBudget(builtins, 1_000_000, { deferUnpinnedMcp: false }).estimate
    const withSmall = trimToolsToBudget([...builtins, small], 1_000_000, {
      deferUnpinnedMcp: false
    }).estimate
    const smallCost = withSmall - base
    const budget = base + smallCost + 50
    const result = trimToolsToBudget([...builtins, small, pinnedBig], budget, {
      pinnedMcpNames: new Set(['mcp__pin__big']),
      deferUnpinnedMcp: false
    })
    expect(result.tools.map((t) => t.name)).toContain('mcp__pin__big')
  })

  it('sheds optional builtins before dropping MCP tools', () => {
    const required = [tool('read', 'r')]
    const optional = [tool('browser_navigate', 'B'.repeat(800))]
    const mcp = tool('mcp__git__status', 'm')
    const withMcp = trimToolsToBudget([...required, mcp], 1_000_000, {
      deferUnpinnedMcp: false
    }).estimate
    const result = trimToolsToBudget([...required, ...optional, mcp], withMcp + 5, {
      deferUnpinnedMcp: false
    })
    expect(result.tools.map((t) => t.name)).toContain('mcp__git__status')
    expect(result.tools.map((t) => t.name)).not.toContain('browser_navigate')
    expect(result.omittedMcp).toBe(0)
  })



  it('keeps a sticky catalog across steps (fingerprint stable)', () => {
    const required = [tool('read', 'r'), tool('edit', 'e')]
    const optional = [tool('browser_navigate', 'nav')]
    const first = trimToolsToBudget([...required, ...optional], 1_000_000)
    expect(first.fingerprint).toBe(toolCatalogFingerprint(first.tools))
    const second = trimToolsToBudget([...required, ...optional], 1_000_000, {
      stickyKeptNames: new Set(first.tools.map((t) => t.name))
    })
    expect(second.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name))
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('append-admits pins and sheds sticky optionals when over tools budget', () => {
    const required = [tool('read', 'r')]
    const optional = [tool('browser_navigate', 'B'.repeat(2000))]
    const pinned = tool('mcp__pin__need', 'P'.repeat(2000))
    const first = trimToolsToBudget([...required, ...optional], 1_000_000)
    expect(first.tools.map((t) => t.name)).toContain('browser_navigate')
    const tight = first.estimate + 20
    const sticky = trimToolsToBudget([...required, ...optional, pinned], tight, {
      pinnedMcpNames: new Set(['mcp__pin__need']),
      stickyKeptNames: new Set(first.tools.map((t) => t.name))
    })
    const stickyNoBudget = trimToolsToBudget([...required, ...optional, pinned], 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__need']),
      stickyKeptNames: new Set(first.tools.map((t) => t.name))
    })
    expect(sticky.tools.map((t) => t.name)).toContain('mcp__pin__need')
    expect(sticky.tools.map((t) => t.name)).toContain('read')
    // Optional shed so pin admit does not keep immortal optional schema tax.
    expect(sticky.tools.map((t) => t.name)).not.toContain('browser_navigate')
    expect(stickyNoBudget.tools.map((t) => t.name)).toContain('browser_navigate')
    expect(sticky.estimate).toBeLessThan(stickyNoBudget.estimate)
  })

  it('admits new pins append-only mid-run without reshuffling sticky order', () => {
    const required = [tool('read', 'r')]
    const optional = [tool('web_search', 'search')]
    const pinned = tool('mcp__pin__need', 'small pin')
    const first = trimToolsToBudget([...required, ...optional], 1_000_000)
    const sticky = trimToolsToBudget([...required, ...optional, pinned], 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__need']),
      stickyKeptNames: new Set(first.tools.map((t) => t.name))
    })
    expect(sticky.tools.map((t) => t.name).slice(0, first.tools.length)).toEqual(
      first.tools.map((t) => t.name)
    )
    expect(sticky.tools.map((t) => t.name)).toContain('mcp__pin__need')
    expect(sticky.tools.map((t) => t.name).at(-1)).toBe('mcp__pin__need')
    expect(sticky.fingerprint).not.toBe(first.fingerprint)
    expect(sticky.omittedMcpNames).not.toContain('mcp__pin__need')
  })

  it('does not append unpinned MCP into a sticky catalog', () => {
    const required = [tool('read', 'r')]
    const unpinned = tool('mcp__other__skip', 'skip me')
    const first = trimToolsToBudget(required, 1_000_000)
    const sticky = trimToolsToBudget([...required, unpinned], 1_000_000, {
      stickyKeptNames: new Set(first.tools.map((t) => t.name)),
      deferUnpinnedMcp: true
    })
    expect(sticky.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name))
    expect(sticky.omittedMcpNames).toContain('mcp__other__skip')
  })

  it('evicts idle pinned MCP from sticky catalog after TTL', () => {
    const required = [tool('read', 'r')]
    const pinned = tool('mcp__pin__old', 'old')
    const first = trimToolsToBudget([...required, pinned], 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__old']),
      currentStep: 1,
      mcpLastUsedByName: new Map([['mcp__pin__old', 1]])
    })
    expect(first.tools.map((t) => t.name)).toContain('mcp__pin__old')
    const later = trimToolsToBudget([...required, pinned], 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__old']),
      stickyKeptNames: new Set(first.tools.map((t) => t.name)),
      currentStep: 1 + MCP_PIN_IDLE_TTL_STEPS,
      mcpLastUsedByName: new Map([['mcp__pin__old', 1]])
    })
    expect(later.tools.map((t) => t.name)).not.toContain('mcp__pin__old')
    expect(later.evictedMcpNames).toContain('mcp__pin__old')
    expect(later.tools.map((t) => t.name)).toContain('read')
  })

  it('never evicts required builtins when shedding idle MCP', () => {
    const required = [tool('read', 'r'), tool('edit', 'e')]
    const pinned = tool('mcp__pin__x', 'x')
    const result = trimToolsToBudget([...required, pinned], 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__x']),
      stickyKeptNames: new Set(['read', 'edit', 'mcp__pin__x']),
      currentStep: 100,
      mcpLastUsedByName: new Map([['mcp__pin__x', 1]])
    })
    expect(result.tools.map((t) => t.name)).toEqual(['read', 'edit'])
    expect(result.evictedMcpNames).toEqual(['mcp__pin__x'])
  })

  it('append-admits re-pin after idle eviction', () => {
    const required = [tool('read', 'r')]
    const pinned = tool('mcp__pin__need', 'need')
    const afterEvict = trimToolsToBudget([...required, pinned], 1_000_000, {
      pinnedMcpNames: new Set(),
      stickyKeptNames: new Set(['read']),
      currentStep: 20,
      mcpLastUsedByName: new Map()
    })
    expect(afterEvict.tools.map((t) => t.name)).not.toContain('mcp__pin__need')
    const repin = trimToolsToBudget([...required, pinned], 1_000_000, {
      pinnedMcpNames: new Set(['mcp__pin__need']),
      stickyKeptNames: new Set(afterEvict.tools.map((t) => t.name)),
      currentStep: 21,
      mcpLastUsedByName: new Map([['mcp__pin__need', 21]])
    })
    expect(repin.tools.map((t) => t.name)).toContain('mcp__pin__need')
    expect(repin.evictedMcpNames).toEqual([])
  })
})

describe('selectMcpPinsToEvict', () => {
  it('evicts LRU when over soft max', () => {
    const names = Array.from({ length: MCP_PINNED_SOFT_MAX + 3 }, (_, i) => `mcp__s__t${i}`)
    const lastUsed = new Map(names.map((n, i) => [n, i + 1]))
    const evicted = selectMcpPinsToEvict(names, {
      currentStep: 50,
      lastUsedByName: lastUsed,
      idleTtlSteps: 1000,
      softMax: MCP_PINNED_SOFT_MAX
    })
    expect(evicted).toHaveLength(3)
    expect(evicted).toEqual(['mcp__s__t0', 'mcp__s__t1', 'mcp__s__t2'])
  })
})
