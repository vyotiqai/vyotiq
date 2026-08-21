import { describe, expect, it } from 'vitest'
import { buildStepToolCatalog } from '@main/agent/context/toolsBudget'
import type { ToolDefinition } from '@main/agent/providers/types'
import { geminiFunctionCallingMode } from '@main/agent/providers/gemini'
import {
  isCurrentInvoke,
  markRunTurnComplete,
  registerRunAbort,
  resetActiveRunsForTests
} from '@main/agent/runRegistry'

describe('omitted MCP tools hint', () => {
  it('keeps the full catalog even when the tools budget is tiny', () => {
    const tools: ToolDefinition[] = [
      { name: 'read', description: 'r', parameters: {} },
      { name: 'mcp__a__one', description: 'x'.repeat(800), parameters: {} },
      { name: 'mcp__b__two', description: 'y'.repeat(800), parameters: {} }
    ]
    const result = buildStepToolCatalog(tools, 50, {
      pinnedMcpNames: new Set(['mcp__a__one', 'mcp__b__two'])
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual([
      'read',
      'mcp__a__one',
      'mcp__b__two'
    ])
    expect(result.evictedMcpNames).toEqual([])
    expect(result.budgetOmittedMcpNames).toEqual([])
  })
})

describe('geminiFunctionCallingMode', () => {
  it('maps loop toolChoice to Gemini modes', () => {
    expect(geminiFunctionCallingMode('auto')).toBe('AUTO')
    expect(geminiFunctionCallingMode('required')).toBe('ANY')
    expect(geminiFunctionCallingMode('none')).toBe('NONE')
    expect(geminiFunctionCallingMode(undefined)).toBe('AUTO')
  })

  it('puts functionCallingConfig on generateContent bodies', async () => {
    const { buildGeminiBody } = await import('@main/agent/providers/gemini')
    const body = buildGeminiBody({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'required',
      apiKey: 'x',
      signal: new AbortController().signal
    })
    expect(
      (body.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode
    ).toBe('ANY')
  })
})

describe('isCurrentInvoke', () => {
  it('keeps the same invoke until clearRunAbort (no overlap while unwinding)', () => {
    resetActiveRunsForTests()
    const first = registerRunAbort('run-a', '/tmp/ws')
    expect(isCurrentInvoke('run-a', first.invokeId)).toBe(true)
    markRunTurnComplete('run-a', first.invokeId)
    // turnComplete must not spawn a second invoke — that raced the prior finally.
    const second = registerRunAbort('run-a', '/tmp/ws')
    expect(second.invokeId).toBe(first.invokeId)
    expect(isCurrentInvoke('run-a', first.invokeId)).toBe(true)
    resetActiveRunsForTests()
  })
})
