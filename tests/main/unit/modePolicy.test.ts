import { describe, expect, it, beforeEach } from 'vitest'
import {
  assertToolAllowedInMode,
  filterToolDefsForMode,
  isBuiltinAllowedInMode,
  isPlanArtifactPath,
  isRunContractPath,
  modeSectionMarkdown
} from '../../../src/main/agent/tools/modePolicy'
import { isParallelSafeTool } from '../../../src/main/agent/tools/classify'
import { setMcpReadOnlyHintsForTests } from '../../../src/main/agent/mcp'

describe('modePolicy', () => {
  beforeEach(() => {
    setMcpReadOnlyHintsForTests({ 'mcp__srv__tool': false })
  })

  it('Ask mode allows generate_image and edit_image (dry-run in handler)', () => {
    expect(isBuiltinAllowedInMode('ask', 'generate_image')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'edit_image')).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'generate_image')).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'edit_image')).toBe(true)
  })

  it('Ask mode denies edit and terminal', () => {
    expect(isBuiltinAllowedInMode('ask', 'edit')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'terminal')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'read')).toBe(true)
    expect(assertToolAllowedInMode('ask', 'edit', { path: 'a.ts', contents: 'x' }).ok).toBe(false)
  })

  it('Agent mode allows all built-ins', () => {
    expect(isBuiltinAllowedInMode('agent', 'edit')).toBe(true)
    expect(isBuiltinAllowedInMode('agent', 'terminal')).toBe(true)
    expect(assertToolAllowedInMode('agent', 'delete', { path: 'x' }).ok).toBe(true)
  })

  it('isPlanArtifactPath recognizes plan and contract', () => {
    expect(isPlanArtifactPath('plan.md')).toBe(true)
    expect(isPlanArtifactPath('./contract.md')).toBe(true)
    expect(isPlanArtifactPath('src/plan.md')).toBe(true)
    expect(isPlanArtifactPath('src/app.ts')).toBe(false)
  })

  it('isRunContractPath matches only contract.md', () => {
    expect(isRunContractPath('contract.md')).toBe(true)
    expect(isRunContractPath('./contract.md')).toBe(true)
    expect(isRunContractPath('plan.md')).toBe(false)
    expect(isRunContractPath('src/app.ts')).toBe(false)
  })

  it('filterToolDefsForMode drops all MCP tools in Ask/Plan', () => {
    const defs = [
      { name: 'read' },
      { name: 'edit' },
      { name: 'mcp__srv__tool' },
      { name: 'mcp__srv__write' },
      { name: 'browser_click' },
      { name: 'browser_navigate' }
    ]
    setMcpReadOnlyHintsForTests({ 'mcp__srv__tool': true, 'mcp__srv__write': false })
    const ask = filterToolDefsForMode('ask', defs)
    expect(ask.map((d) => d.name)).toEqual(['read', 'browser_navigate'])
    expect(assertToolAllowedInMode('ask', 'mcp__srv__tool', {}).ok).toBe(false)
    expect(assertToolAllowedInMode('ask', 'mcp__srv__write', {}).ok).toBe(false)
    expect(assertToolAllowedInMode('agent', 'mcp__srv__tool', {}).ok).toBe(true)
  })

  it('Ask mode denies browser_click and browser_type', () => {
    expect(isBuiltinAllowedInMode('ask', 'browser_click')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'browser_type')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'browser_navigate')).toBe(true)
    expect(assertToolAllowedInMode('ask', 'browser_click', { selector: 'button' }).ok).toBe(false)
  })

  it('Ask mode denies browser_fill', () => {
    expect(isBuiltinAllowedInMode('ask', 'browser_fill')).toBe(false)
    expect(assertToolAllowedInMode('ask', 'browser_fill', { selector: 'input', value: 'x' }).ok).toBe(
      false
    )
  })

  it('Ask mode denies diagnostics and terminal; Plan allows diagnostics', () => {
    expect(isBuiltinAllowedInMode('ask', 'diagnostics')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'diagnostics')).toBe(true)
    expect(assertToolAllowedInMode('ask', 'diagnostics', {}).ok).toBe(false)
    expect(assertToolAllowedInMode('plan', 'diagnostics', {}).ok).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'terminal')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'terminal')).toBe(false)
  })

  it('Ask mode allows wait/history/tabs and denies press_key/select_option', () => {
    expect(isBuiltinAllowedInMode('ask', 'browser_tabs')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_back')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_forward')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_wait_for_selector')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_wait_for_url')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'mcp_list_tools')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'mcp_list_resources')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'mcp_read_resource')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_press_key')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'browser_select_option')).toBe(false)
  })

  it('modeSectionMarkdown covers all modes', () => {
    expect(modeSectionMarkdown('agent')).toContain('Agent mode')
    expect(modeSectionMarkdown('ask')).toContain('Ask mode')
    expect(modeSectionMarkdown('plan')).toContain('Plan mode')
    expect(modeSectionMarkdown('plan')).not.toMatch(/keep todos via/i)
  })

  it('modeSectionMarkdown has no switch_mode hints when autoModeSwitch is off', () => {
    expect(modeSectionMarkdown('agent')).not.toMatch(/switch_mode/)
    expect(modeSectionMarkdown('ask')).not.toMatch(/switch_mode/)
    expect(modeSectionMarkdown('plan')).not.toMatch(/switch_mode/)
    expect(modeSectionMarkdown('ask')).toMatch(/suggest switching to Agent mode/)
    expect(modeSectionMarkdown('plan')).toMatch(/switching to Agent mode/)
  })

  it('modeSectionMarkdown includes proactive switch_mode rules when autoModeSwitch is on', () => {
    const opts = { autoModeSwitch: true }
    expect(modeSectionMarkdown('agent', opts)).toMatch(/switch_mode.*ask/i)
    expect(modeSectionMarkdown('agent', opts)).toMatch(/switch_mode.*plan/i)
    expect(modeSectionMarkdown('ask', opts)).toMatch(/switch_mode.*plan/)
    expect(modeSectionMarkdown('ask', opts)).toMatch(/switch_mode.*agent/)
    expect(modeSectionMarkdown('plan', opts)).toMatch(/switch_mode.*agent/)
    expect(modeSectionMarkdown('plan', opts)).toMatch(/switch_mode.*ask/)
  })

  it('Ask forbids diagnostics and terminal; Plan allows diagnostics', () => {
    const ask = modeSectionMarkdown('ask')!
    const plan = modeSectionMarkdown('plan')!
    expect(ask).toMatch(/Do not edit files|Only avoid mutating/)
    expect(ask).toMatch(/`diagnostics`/)
    expect(ask).toMatch(/`terminal`/)
    expect(plan).toMatch(/`todo_write` and `diagnostics` are available/)
    expect(plan).toMatch(/`terminal`/)
  })
})
