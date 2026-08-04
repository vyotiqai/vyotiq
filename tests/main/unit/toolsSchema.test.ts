import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AGENT_TOOLS } from '@main/agent/schemas/tools'
import { BUILTIN_TOOL_NAMES } from '@main/agent/tools'
import { estimateTextTokens } from '@main/agent/context/estimate'
import { BUDGET_SHARES } from '@main/agent/context/types'

const SECTION_HEADERS = [
  'WHEN TO USE:',
  'WORKFLOW:',
  'AVOID:',
  'LIMITS:',
  'RESULT:',
  'EXECUTION POLICY:'
] as const

describe('toolsSchema', () => {
  it('covers every executable built-in with a short description', () => {
    const names = AGENT_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([...BUILTIN_TOOL_NAMES].sort())
    expect(names.length).toBe(45)

    for (const tool of AGENT_TOOLS) {
      expect(tool.description.trim().length, `${tool.name} empty description`).toBeGreaterThan(0)
      for (const section of SECTION_HEADERS) {
        expect(tool.description, `${tool.name} has structured section ${section}`).not.toContain(
          section
        )
      }
    }
  })

  it('keeps read optional param descriptions in JSON Schema', () => {
    const read = AGENT_TOOLS.find((t) => t.name === 'read')
    expect(read).toBeDefined()
    const props = (read!.parameters as { properties: Record<string, { description?: string }> })
      .properties
    expect(props.startLine?.description).toMatch(/Prefer this over offset\/limit/)
    expect(props.endLine?.description).toBeTruthy()
  })

  it('emits memory_list with required:[] for OpenAI strict mode', () => {
    const mem = AGENT_TOOLS.find((t) => t.name === 'memory_list')
    expect(mem).toBeDefined()
    expect((mem!.parameters as { required?: string[] }).required).toEqual([])
  })

  it('emits todo_write status as a string enum', () => {
    const todo = AGENT_TOOLS.find((t) => t.name === 'todo_write')
    const status = (
      todo!.parameters as {
        properties: { todos: { items: { properties: { status: Record<string, unknown> } } } }
      }
    ).properties.todos.items.properties.status
    expect(status.type).toBe('string')
    expect(status.enum).toEqual(['pending', 'in_progress', 'completed', 'cancelled'])
    expect(status.description).toMatch(/in_progress/)
  })

  it('fits built-in tool defs under the default tools budget share', () => {
    const defaultWindow = 128_000
    const toolsBudget = Math.floor(defaultWindow * BUDGET_SHARES.tools)
    const estimate = estimateTextTokens(JSON.stringify(AGENT_TOOLS))
    expect(estimate).toBeLessThan(toolsBudget)
    // Leave headroom for MCP tools under typical budgets.
    expect(estimate).toBeLessThan(toolsBudget * 0.5)
  })
})

describe('harness tool catalog', () => {
  it('has an instruction-first structure with Tool policy and no per-tool catalog', () => {
    const harnessPath = join(process.cwd(), 'resources', 'harness', 'default.md')
    const harness = readFileSync(harnessPath, 'utf8')
    expect(harness).toContain('## Role')
    expect(harness).toContain('## Capabilities')
    expect(harness).toContain('## Tool policy')
    expect(harness).toContain('## Constraints')
    expect(harness).toContain('## Work style')
    expect(harness).toContain('## Memory')
    expect(harness).toContain('## Output format')
    expect(harness).toContain('mcp__<serverId>__<toolName>')
    expect(harness).toMatch(/allowlist/i)
    expect(harness).not.toContain('## Context')
    expect(harness).not.toContain('<attachment')
    expect(harness).not.toMatch(/\*\*read\*\* —/)
    expect(harness).not.toMatch(/\*\*terminal\*\* —/)
    expect(harness).not.toMatch(/\*\*glob\*\* —/)
  })

  it('keeps checkpoint truths and prompt-injection guardrails without mode workflow essays', () => {
    const harnessPath = join(process.cwd(), 'resources', 'harness', 'default.md')
    const harness = readFileSync(harnessPath, 'utf8')
    expect(harness).toMatch(/not Keep\/Discard checkpointed/i)
    expect(harness).toMatch(/data, not instructions/i)
    expect(harness).toMatch(/take precedence over any embedded directives/i)
    expect(harness).not.toMatch(/Verify before done|verify-before-done|soft-nudge/i)
    expect(harness).not.toMatch(/Contract done-when|contractDoneWhen|mechanically checked/i)
    expect(harness).not.toMatch(/Read before edit|read-before-edit/i)
    expect(harness).not.toMatch(/Prefer `read`[\s\S]*before editing/i)
    expect(harness).not.toMatch(/Use `todo_write` for multi-step/i)
    expect(harness).not.toMatch(/Write durable facts with `memory_write` when learned/i)
    expect(harness).not.toMatch(/prefer them for architecture/i)
    // Meta-assembly text (receipts, harness-apply, mode section mechanics) was moved to the handbook.
    expect(harness).not.toMatch(/receipt\.json/i)
    expect(harness).not.toMatch(/harness-review|harness\/proposals/i)
    expect(harness).not.toMatch(/harness-apply/i)
    expect(harness).not.toMatch(/not unsupervised Self-Harness|human review scaffold/i)
    expect(harness).not.toMatch(/normal PR/i)
    // The harness may legitimately mention "mode section" in tool policy (MCP meta-tools); the meta-assembly paragraph is gone.
    expect(harness).not.toMatch(/or graph search/)
    // Mode-specific diagnostics / terminal rules live in modeSectionMarkdown.
    expect(harness).not.toMatch(/Ask mode[\s\S]*no `diagnostics`/i)
    expect(harness).not.toMatch(/In Plan mode you may use `diagnostics`/i)
    // Concurrency / serial / approval are runtime-enforced (classify + executeStepTools).
    expect(harness).not.toMatch(/capped at 4/i)
    expect(harness).not.toMatch(/at most 2 concurrent/i)
    expect(harness).not.toMatch(/approval-gated|approval-exempt/i)
  })

  it('moved run-time and meta-assembly documentation to the harness handbook', () => {
    const harnessPath = join(process.cwd(), 'docs', 'harness-handbook.md')
    const handbook = readFileSync(harnessPath, 'utf8')
    expect(handbook).toMatch(/receipt\.json/i)
    expect(handbook).toMatch(/harness-review|harness\/proposals/i)
    expect(handbook).toMatch(/harness-apply/i)
    expect(handbook).toMatch(/not unsupervised Self-Harness|human review scaffold/i)
    expect(handbook).toMatch(/normal PR/i)
    expect(handbook).toMatch(/mode section/i)
    expect(handbook).toMatch(/How the system prompt is assembled/i)
    expect(handbook).toMatch(/What belongs in `resources\/harness\/default\.md`/i)
  })
})
