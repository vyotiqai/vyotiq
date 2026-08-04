import { describe, expect, it } from 'vitest'
import {
  toolCategory,
  toolIconName,
  toolLabel,
  toolPresentation
} from '@renderer/features/chat/toolUi/meta'
import { toolHasBody } from '@renderer/features/chat/toolUi/registry'

describe('toolUi meta', () => {
  it('routes terminal and edit tools to prominent cards', () => {
    expect(toolPresentation('terminal')).toBe('prominent')
    expect(toolPresentation('edit')).toBe('prominent')
    expect(toolPresentation('multi_edit')).toBe('prominent')
    expect(toolPresentation('str_replace')).toBe('prominent')
    expect(toolPresentation('todo_write')).toBe('compact')
    expect(toolPresentation('delete')).toBe('compact')
    expect(toolPresentation('read')).toBe('compact')
  })

  it('demotes read-only terminal commands to compact', () => {
    expect(toolPresentation('terminal', '{"command":"cat README.md"}')).toBe('compact')
    expect(toolPresentation('terminal', undefined, 'cat README.md')).toBe('compact')
    expect(toolPresentation('terminal', '{"command":"pnpm test"}')).toBe('prominent')
  })

  it('categorizes tools for group headers', () => {
    expect(toolCategory('read')).toBe('file')
    expect(toolCategory('grep')).toBe('search')
    expect(toolCategory('list_dir')).toBe('browse')
    expect(toolCategory('memory_list')).toBe('browse')
    expect(toolCategory('git_commit')).toBe('command')
    expect(toolCategory('terminal')).toBe('command')
    expect(toolCategory('Skill')).toBe('search')
    expect(toolCategory('mcp__srv__read_text_file')).toBe('file')
    expect(toolCategory('mcp__srv__list_allowed_directories')).toBe('browse')
    expect(toolCategory('mcp__srv__grep_search')).toBe('search')
  })

  it('icons Skill as sparkles not file', () => {
    expect(toolIconName('Skill')).toBe('sparkles')
    expect(toolIconName('Skill')).not.toBe('file')
  })

  it('labels MCP tools with readable verbs', () => {
    expect(toolLabel('mcp__github__create_issue', 'running')).toBe('Calling Create Issue')
    expect(toolLabel('mcp__github__read_text_file', 'done')).toBe('Read file')
    expect(toolLabel('mcp__github__list_allowed_directories', 'done')).toBe('Listed directories')
  })

  it('labels ask_question from TOOL_LABELS', () => {
    expect(toolLabel('ask_question', 'running')).toBe('Asking')
    expect(toolLabel('ask_question', 'done')).toBe('Asked')
  })

  it('uses in-progress verb when tool content is interrupted', () => {
    expect(toolLabel('ask_question', 'fail', 'Cancelled')).toBe('Asking')
    expect(toolLabel('ask_question', 'fail', 'Interrupted')).toBe('Asking')
    expect(toolLabel('ask_question', 'done', 'Stopped')).toBe('Asking')
    expect(toolLabel('read', 'fail', 'Cancelled')).toBe('Reading')
    // Non-interrupt fail still uses the done form.
    expect(toolLabel('ask_question', 'fail', 'Error: boom')).toBe('Asked')
  })

  it('labels Skill from TOOL_LABELS', () => {
    expect(toolLabel('Skill', 'running')).toBe('Loading skill')
    expect(toolLabel('Skill', 'done')).toBe('Loaded skill')
  })

  it('humanizes unknown built-in tool names', () => {
    expect(toolLabel('future_unknown_tool', 'running')).toBe('Running Future Unknown Tool')
    expect(toolLabel('future_unknown_tool', 'done')).toBe('Future Unknown Tool')
  })

  it('labels unresolved streaming tool names as Preparing', () => {
    expect(toolLabel('tool', 'running')).toBe('Preparing…')
    expect(toolLabel('', 'running')).toBe('Preparing…')
  })

  it('does not claim a body for unresolved running tool rows', () => {
    expect(
      toolHasBody({
        id: 'pending_0',
        name: 'tool',
        summary: '',
        status: 'running',
        argsPreview: '{"todos":[{"id":"1"}]}'
      })
    ).toBe(false)
  })
})
