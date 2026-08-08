import { afterEach, describe, expect, it } from 'vitest'
import { resetMcpSessionsForTests, setMcpReadOnlyHintsForTests } from '@main/agent/mcp'
import {
  isApprovalExemptTool,
  isParallelSafeTool
} from '@main/agent/tools/classify'
import { isToolGated } from '@main/agent/toolApproval'

afterEach(() => {
  resetMcpSessionsForTests()
})

describe('tool classify', () => {
  it('marks built-in parallel-safe tools', () => {
    expect(isParallelSafeTool('read')).toBe(true)
    expect(isParallelSafeTool('search')).toBe(true)
    expect(isParallelSafeTool('glob')).toBe(true)
    expect(isParallelSafeTool('grep')).toBe(true)
    expect(isParallelSafeTool('list_dir')).toBe(true)
    expect(isParallelSafeTool('memory_read')).toBe(true)
    expect(isParallelSafeTool('Skill')).toBe(true)
  })

  it('marks mutating built-in tools as serial-only', () => {
    expect(isParallelSafeTool('edit')).toBe(false)
    expect(isParallelSafeTool('terminal')).toBe(false)
    expect(isParallelSafeTool('memory_write')).toBe(false)
    expect(isParallelSafeTool('generate_image')).toBe(false)
    expect(isParallelSafeTool('edit_image')).toBe(false)
  })

  it('serializes browser_search with other browser tools', () => {
    expect(isParallelSafeTool('browser_search')).toBe(false)
    expect(isApprovalExemptTool('browser_search')).toBe(false)
    expect(isToolGated('browser_search', 'mutating', new Set(), [])).toBe(true)
  })

  it('serializes browser tools on the shared window and gates approval', () => {
    for (const name of [
      'browser_search',
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
      'browser_select_option'
    ]) {
      expect(isParallelSafeTool(name)).toBe(false)
      expect(isApprovalExemptTool(name)).toBe(false)
      expect(isToolGated(name, 'mutating', new Set(), [])).toBe(true)
    }
  })

  it('treats mcp_list_tools as parallel-safe but not approval-exempt', () => {
    expect(isParallelSafeTool('mcp_list_tools')).toBe(true)
    expect(isApprovalExemptTool('mcp_list_tools')).toBe(false)
    expect(isToolGated('mcp_list_tools', 'mutating', new Set(), [])).toBe(true)
  })

  it('treats request_mcp_tools and release_mcp_tools as serial and gated', () => {
    for (const name of ['request_mcp_tools', 'release_mcp_tools']) {
      expect(isParallelSafeTool(name)).toBe(false)
      expect(isApprovalExemptTool(name)).toBe(false)
      expect(isToolGated(name, 'mutating', new Set(), [])).toBe(true)
    }
  })

  it('treats MCP resource/prompt built-ins as serial and gated', () => {
    for (const name of [
      'mcp_list_resources',
      'mcp_read_resource',
      'mcp_list_prompts',
      'mcp_get_prompt'
    ]) {
      expect(isParallelSafeTool(name)).toBe(false)
      expect(isApprovalExemptTool(name)).toBe(false)
      expect(isToolGated(name, 'mutating', new Set(), [])).toBe(true)
    }
  })

  it('never treats MCP readOnlyHint as parallel-safe', () => {
    expect(isParallelSafeTool('mcp__fs__read_file')).toBe(false)
    expect(isApprovalExemptTool('mcp__fs__read_file')).toBe(false)
    expect(isParallelSafeTool('mcp__gh__create_issue')).toBe(false)
    setMcpReadOnlyHintsForTests({ 'mcp__fs__read_file': true })
    expect(isParallelSafeTool('mcp__fs__read_file')).toBe(false)
    expect(isApprovalExemptTool('mcp__fs__read_file')).toBe(false)
    expect(isToolGated('mcp__fs__read_file', 'mutating', new Set(), [])).toBe(true)
  })
})
