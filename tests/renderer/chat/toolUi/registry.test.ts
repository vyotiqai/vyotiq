import { describe, expect, it } from 'vitest'
import { FallbackBody } from '@renderer/features/chat/toolUi/bodies/McpBody'
import { getToolBody, getToolEntry, getToolHeaderMeta } from '@renderer/features/chat/toolUi/registry'
import type { UiToolRow } from '@shared/transcript'

const FORMER_FALLBACK_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_fill',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_press_key',
  'browser_select_option',
  'diagnostics',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  'request_mcp_tools',
  'release_mcp_tools',
  'Skill',
  'ask_question',
  'switch_mode',
  'git_commit',
  'generate_image',
  'edit_image'
] as const

describe('tool UI registry coverage', () => {
  it('registers structured bodies for all former FallbackBody builtins', () => {
    for (const name of FORMER_FALLBACK_TOOLS) {
      expect(getToolBody(name)).not.toBe(FallbackBody)
      expect(getToolEntry(name).Body).not.toBe(FallbackBody)
    }
  })

  it('keeps unknown tools on content-only FallbackBody without args dump', () => {
    expect(getToolBody('totally_unknown_tool_xyz')).toBe(FallbackBody)
    const entry = getToolEntry('totally_unknown_tool_xyz')
    const tool: UiToolRow = {
      id: 't1',
      name: 'totally_unknown_tool_xyz',
      summary: '',
      status: 'done',
      argsPreview: JSON.stringify({ secret: true }),
      content: 'hello result'
    }
    expect(entry.hasBody(tool)).toBe(true)
    expect(
      entry.hasBody({
        ...tool,
        content: '',
        argsPreview: JSON.stringify({ only: 'args' })
      })
    ).toBe(false)
  })

  it('resolves header meta for Skill and MCP pin/release tools', () => {
    const skill: UiToolRow = {
      id: 's1',
      name: 'Skill',
      summary: 'code-review',
      status: 'done',
      content: '# Skill: code-review\n\nBody'
    }
    expect(getToolHeaderMeta(skill)).toMatchObject({
      verb: 'Loaded skill',
      target: 'code-review',
      icon: 'sparkles'
    })

    const pin: UiToolRow = {
      id: 'p1',
      name: 'request_mcp_tools',
      summary: '2 pinned',
      status: 'done',
      argsPreview: JSON.stringify({ serverId: 'gh' }),
      content: 'Pinned for next step (2): mcp__gh__a, mcp__gh__b'
    }
    expect(getToolHeaderMeta(pin)).toMatchObject({
      verb: 'Pinned MCP',
      target: 'gh',
      icon: 'plug'
    })
    expect(getToolEntry('request_mcp_tools').hasBody(pin)).toBe(true)

    const release: UiToolRow = {
      id: 'r1',
      name: 'release_mcp_tools',
      summary: '1 released',
      status: 'running',
      argsPreview: JSON.stringify({ tools: ['mcp__gh__a'] }),
      content: ''
    }
    expect(getToolHeaderMeta(release)).toMatchObject({
      verb: 'Releasing MCP',
      target: 'mcp__gh__a',
      icon: 'plug'
    })
  })

  it('does not treat chip-only ask_question/switch_mode as expandable', () => {
    const ask: UiToolRow = {
      id: 'a1',
      name: 'ask_question',
      summary: '',
      status: 'done',
      content: ''
    }
    const mode: UiToolRow = {
      id: 'm1',
      name: 'switch_mode',
      summary: '',
      status: 'done',
      content: ''
    }
    expect(getToolEntry('ask_question').hasBody(ask)).toBe(false)
    expect(getToolEntry('switch_mode').hasBody(mode)).toBe(false)
  })
})
