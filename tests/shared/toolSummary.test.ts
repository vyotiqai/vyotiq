import { describe, expect, it } from 'vitest'
import { isUnresolvedToolName, summarizeToolArgs } from '@shared/utils/toolSummary'

describe('toolSummary', () => {
  it('never leaks raw JSON into summaries', () => {
    const summary = summarizeToolArgs(
      'terminal',
      JSON.stringify({ command: 'type C:\\\\Users\\\\foo\\\\bar.txt' })
    )
    expect(summary).not.toContain('{')
    expect(summary).toContain('bar.txt')
  })

  it('sanitizes quoted paths in summaries', () => {
    const summary = summarizeToolArgs(
      'read',
      JSON.stringify({ path: 'C:\\Users\\"youtube tools"\\app.tsx' })
    )
    expect(summary).not.toContain('"')
    expect(summary).toContain('app.tsx')
  })

  it('does not invent a Tool subtitle for unresolved streaming names', () => {
    expect(isUnresolvedToolName('tool')).toBe(true)
    expect(isUnresolvedToolName('')).toBe(true)
    expect(isUnresolvedToolName('todo_write')).toBe(false)
    const summary = summarizeToolArgs(
      'tool',
      JSON.stringify({
        todos: [{ id: '1', content: 'Audit Auth', status: 'in_progress' }]
      })
    )
    expect(summary).toBe('')
  })

  it('summarizes mcp_list_tools with serverId or deprecated server_id', () => {
    expect(
      summarizeToolArgs('mcp_list_tools', JSON.stringify({ serverId: 'github' }))
    ).toContain('github')
    expect(
      summarizeToolArgs('mcp_list_tools', JSON.stringify({ server_id: 'linear' }))
    ).toContain('linear')
    expect(summarizeToolArgs('mcp_list_tools', '{}')).toBe('mcp')
  })
})
