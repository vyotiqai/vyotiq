import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '@main/agent/tools'

describe('executeTool run-artifact remap', () => {
  let workspace: string
  let runDir: string

  afterEach(() => {
    if (workspace && existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  function setup(): void {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-remap-ws-'))
    runDir = join(workspace, '.run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'contract.md'),
      '## Goal\n\noriginal\n\n## Done when\n\n- done\n',
      'utf8'
    )
  }

  it('Agent mode edit remaps contract.md into the run directory', async () => {
    setup()
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({
        path: 'contract.md',
        contents: '## Goal\n\nupdated by agent\n\n## Done when\n\n- done\n'
      }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('updated by agent')
    expect(existsSync(join(workspace, 'contract.md'))).toBe(false)
  })

  it('Agent mode does not remap plan.md when no run plan exists', async () => {
    setup()
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Workspace plan\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(existsSync(join(workspace, 'plan.md'))).toBe(true)
    expect(existsSync(join(runDir, 'plan.md'))).toBe(false)
  })

  it('Agent mode remaps plan.md when a run plan artifact exists', async () => {
    setup()
    writeFileSync(join(runDir, 'plan.md'), '# Existing plan\n', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Updated plan\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toContain('# Updated plan')
    expect(existsSync(join(workspace, 'plan.md'))).toBe(false)
  })

  it('Plan mode remaps multi_edit plan artifacts', async () => {
    setup()
    const signal = new AbortController().signal
    const result = await executeTool(
      'multi_edit',
      JSON.stringify({
        edits: [
          { path: 'plan.md', contents: '# Multi plan\n' },
          { path: 'contract.md', contents: '## Goal\n\nmulti\n\n## Done when\n\n- x\n' }
        ]
      }),
      workspace,
      signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toContain('# Multi plan')
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('multi')
  })

  it('Plan mode still remaps plan.md and contract.md', async () => {
    setup()
    const signal = new AbortController().signal
    const plan = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Plan\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'plan' }
    )
    expect(plan.ok).toBe(true)
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toContain('# Plan')
    expect(existsSync(join(workspace, 'plan.md'))).toBe(false)

    const contract = await executeTool(
      'edit',
      JSON.stringify({
        path: 'contract.md',
        contents: '## Goal\n\nplan mode update\n\n## Done when\n\n- done\n'
      }),
      workspace,
      signal,
      { runDir, agentMode: 'plan' }
    )
    expect(contract.ok).toBe(true)
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('plan mode update')
  })
})
