import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listConnectedMcpServerIdsForTests,
  registerMcpSessionForTests,
  resetMcpSessionsForTests
} from '@main/agent/mcp'
import { executeTool } from '@main/agent/tools'
import { isApprovalExemptTool, isParallelSafeTool } from '@main/agent/tools/classify'
import { isBuiltinAllowedInMode } from '@main/agent/tools/modePolicy'

function mockClient(overrides: {
  listResources?: ReturnType<typeof vi.fn>
  readResource?: ReturnType<typeof vi.fn>
  listPrompts?: ReturnType<typeof vi.fn>
  getPrompt?: ReturnType<typeof vi.fn>
}) {
  return {
    listTools: vi.fn(async () => ({ tools: [] })),
    listResources:
      overrides.listResources ??
      vi.fn(async () => ({
        resources: [{ uri: 'file:///notes.md', name: 'Notes', description: 'Scratch pad' }]
      })),
    readResource:
      overrides.readResource ??
      vi.fn(async () => ({ contents: [{ type: 'text', text: 'hello resource' }] })),
    listPrompts:
      overrides.listPrompts ??
      vi.fn(async () => ({
        prompts: [{ name: 'summarize', description: 'Summarize text', arguments: [{ name: 'text' }] }]
      })),
    getPrompt:
      overrides.getPrompt ??
      vi.fn(async () => ({
        description: 'Summarize prompt',
        messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this.' } }]
      })),
    getServerCapabilities: vi.fn(() => ({ resources: {}, prompts: {} })),
    close: vi.fn(async () => undefined)
  }
}

describe('MCP resource/prompt built-ins', () => {
  afterEach(() => {
    resetMcpSessionsForTests()
  })

  it('lists resources from a connected server', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_list_resources',
      JSON.stringify({ serverId: 'docs' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('file:///notes.md')
    expect(client.listResources).toHaveBeenCalled()
  })

  it('reads a resource by server id and uri', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'docs', uri: 'file:///notes.md' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('hello resource')
    expect(client.readResource).toHaveBeenCalledWith(
      { uri: 'file:///notes.md' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('lists prompts from a connected server', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_list_prompts',
      JSON.stringify({ serverId: 'docs' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('summarize')
    expect(client.listPrompts).toHaveBeenCalled()
  })

  it('fetches a prompt with arguments', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ serverId: 'docs', name: 'summarize', arguments: { text: 'hello' } }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('Summarize this.')
    expect(client.getPrompt).toHaveBeenCalledWith(
      { name: 'summarize', arguments: { text: 'hello' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('accepts the deprecated server_id alias on list_resources and list_prompts', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const resources = await executeTool(
      'mcp_list_resources',
      JSON.stringify({ server_id: 'docs' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(resources.ok).toBe(true)
    expect(resources.content).toContain('file:///notes.md')
    expect(client.listResources).toHaveBeenCalled()

    const prompts = await executeTool(
      'mcp_list_prompts',
      JSON.stringify({ server_id: 'docs' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(prompts.ok).toBe(true)
    expect(prompts.content).toContain('summarize')
    expect(client.listPrompts).toHaveBeenCalled()
  })

  it('rejects when the server is not connected', async () => {
    const result = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'missing', uri: 'file:///x' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['missing']) }
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/not connected/i)
  })

  it('rejects when the server is not enabled for the run', async () => {
    registerMcpSessionForTests('docs', mockClient({}))

    const result = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'docs', uri: 'file:///notes.md' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['other']) }
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/not enabled for this workspace run/i)
  })

  it('treats MCP resource/prompt tools as serial and approval-gated', () => {
    for (const name of [
      'mcp_list_resources',
      'mcp_read_resource',
      'mcp_list_prompts',
      'mcp_get_prompt'
    ]) {
      expect(isParallelSafeTool(name)).toBe(false)
      expect(isApprovalExemptTool(name)).toBe(false)
      expect(isBuiltinAllowedInMode('ask', name)).toBe(true)
    }
  })
})

describe('mcp_read_resource / mcp_get_prompt validation and gates', () => {
  afterEach(() => {
    resetMcpSessionsForTests()
  })

  it('rejects missing required args at the schema boundary', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const noUri = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'docs' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(noUri.ok).toBe(false)
    expect(noUri.summary).toBe('invalid args')
    expect(noUri.content).toMatch(/uri/i)

    const noName = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ serverId: 'docs' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(noName.ok).toBe(false)
    expect(noName.summary).toBe('invalid args')
    expect(noName.content).toMatch(/name/i)

    const noServer = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ name: 'summarize' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(noServer.ok).toBe(false)
    expect(noServer.summary).toBe('invalid args')

    expect(client.readResource).not.toHaveBeenCalled()
    expect(client.getPrompt).not.toHaveBeenCalled()
  })

  it('rejects whitespace-only required args via the handler backstop', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const blankUri = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'docs', uri: '   ' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(blankUri.ok).toBe(false)
    expect(blankUri.content).toBe('uri is required')

    const blankName = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ serverId: 'docs', name: '  ' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(blankName.ok).toBe(false)
    expect(blankName.content).toBe('name is required')

    const blankServer = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: '   ', uri: 'file:///notes.md' }),
      '/tmp/ws',
      new AbortController().signal
    )
    expect(blankServer.ok).toBe(false)
    expect(blankServer.content).toBe('serverId is required')

    expect(client.readResource).not.toHaveBeenCalled()
    expect(client.getPrompt).not.toHaveBeenCalled()
  })

  it('rejects the server_id alias on read_resource/get_prompt (strict schemas)', async () => {
    const client = mockClient({})
    registerMcpSessionForTests('docs', client)

    const read = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ server_id: 'docs', uri: 'file:///notes.md' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(read.ok).toBe(false)
    expect(read.summary).toBe('invalid args')

    const prompt = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ server_id: 'docs', name: 'summarize' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )
    expect(prompt.ok).toBe(false)
    expect(prompt.summary).toBe('invalid args')

    expect(client.readResource).not.toHaveBeenCalled()
    expect(client.getPrompt).not.toHaveBeenCalled()
  })

  it('gates mcp_get_prompt on server connection and run enablement', async () => {
    const missing = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ serverId: 'missing', name: 'summarize' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['missing']) }
    )
    expect(missing.ok).toBe(false)
    expect(missing.content).toMatch(/not connected/i)

    const client = mockClient({})
    registerMcpSessionForTests('docs', client)
    const notEnabled = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ serverId: 'docs', name: 'summarize' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['other']) }
    )
    expect(notEnabled.ok).toBe(false)
    expect(notEnabled.content).toMatch(/not enabled for this workspace run/i)
    expect(client.getPrompt).not.toHaveBeenCalled()
  })
})

describe('mcp_read_resource / mcp_get_prompt content and failures', () => {
  afterEach(() => {
    resetMcpSessionsForTests()
  })

  it('passes through text and formats binary blob resource contents', async () => {
    const client = mockClient({
      readResource: vi.fn(async () => ({
        contents: [
          { type: 'text', text: 'first page' },
          { type: 'resource', blob: 'QUJD', mimeType: 'application/pdf' }
        ]
      }))
    })
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'docs', uri: 'file:///doc.pdf' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('first page')
    expect(result.content).toContain('[binary blob mime=application/pdf base64 len=4]')
  })

  it('reports (empty) when a resource has no contents', async () => {
    const client = mockClient({
      readResource: vi.fn(async () => ({ contents: [] }))
    })
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'docs', uri: 'file:///empty' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toBe('(empty)')
  })

  it('formats prompt description plus role-prefixed messages', async () => {
    const client = mockClient({
      getPrompt: vi.fn(async () => ({
        description: 'Summarize prompt',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Summarize this.' } },
          { role: 'assistant', content: 'Sure thing.' }
        ]
      }))
    })
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ serverId: 'docs', name: 'summarize' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('Summarize prompt')
    expect(result.content).toContain('user: Summarize this.')
    expect(result.content).toContain('assistant: Sure thing.')
    expect(client.getPrompt).toHaveBeenCalledWith(
      { name: 'summarize', arguments: undefined },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('propagates read_resource failures and disconnects the server', async () => {
    const client = mockClient({
      readResource: vi.fn(async () => {
        throw new Error('resource backend on fire')
      })
    })
    registerMcpSessionForTests('docs', client)
    expect(listConnectedMcpServerIdsForTests()).toContain('docs')

    const result = await executeTool(
      'mcp_read_resource',
      JSON.stringify({ serverId: 'docs', uri: 'file:///notes.md' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(false)
    expect(result.content).toContain('resource backend on fire')
    expect(client.close).toHaveBeenCalled()
    expect(listConnectedMcpServerIdsForTests()).not.toContain('docs')
  })

  it('propagates get_prompt failures and disconnects the server', async () => {
    const client = mockClient({
      getPrompt: vi.fn(async () => {
        throw new Error('prompt store unavailable')
      })
    })
    registerMcpSessionForTests('docs', client)

    const result = await executeTool(
      'mcp_get_prompt',
      JSON.stringify({ serverId: 'docs', name: 'summarize', arguments: { text: 'hi' } }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['docs']) }
    )

    expect(result.ok).toBe(false)
    expect(result.content).toContain('prompt store unavailable')
    expect(client.close).toHaveBeenCalled()
    expect(listConnectedMcpServerIdsForTests()).not.toContain('docs')
  })
})
