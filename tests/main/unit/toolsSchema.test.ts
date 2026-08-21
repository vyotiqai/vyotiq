import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AGENT_TOOLS, AWAIT_AGENT_INSTANCE_MAX_MS, BUILTIN_TOOL_NAMES, validateToolArgs } from '@main/agent/schemas/tools'
import {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_CHARS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_NAV_TIMEOUT_MS,
  MAX_TYPE_CHARS,
  SETTLE_FALLBACK_MS
} from '@main/app/browserUrl'
import { estimateTextTokens } from '@main/agent/context/estimate'
import { BUDGET_SHARES } from '@main/agent/context/types'
import { HARNESS_SECTION_TAGS } from '@main/agent/harnessSections'

const SECTION_HEADERS = [
  'WHEN TO USE:',
  'WORKFLOW:',
  'AVOID:',
  'LIMITS:',
  'RESULT:',
  'EXECUTION POLICY:'
] as const

describe('toolsSchema', () => {
  it('tells file and web tools how to cite this-turn evidence', () => {
    for (const name of ['read', 'grep', 'search', 'codebase_search'] as const) {
      const tool = AGENT_TOOLS.find((t) => t.name === name)
      expect(tool?.description, name).toContain('[[path]]')
    }
    for (const name of ['browser_search', 'browser_navigate', 'browser_snapshot'] as const) {
      const tool = AGENT_TOOLS.find((t) => t.name === name)
      expect(tool?.description, name).toContain('[[https://url]]')
    }
  })

  it('covers every executable built-in with a short description', () => {
    const names = AGENT_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([...BUILTIN_TOOL_NAMES].sort())
    expect(names.length).toBe(53)

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
    expect(read!.description).toMatch(/omit offset\/limit/i)
    expect(read!.description).toMatch(/byte window, not lines/i)
    const props = (read!.parameters as { properties: Record<string, { description?: string }> })
      .properties
    expect(props.startLine?.description).toMatch(/Prefer this over offset\/limit/)
    expect(props.endLine?.description).toBeTruthy()
    expect(props.offset?.description).toMatch(/not a line number/)
    expect(props.offset?.description).toMatch(/Omit when using startLine\/endLine/)
    expect(props.limit?.description).toMatch(/Bytes, not lines/)
  })

  it('emits memory_list with required:[] for OpenAI strict mode', () => {
    const mem = AGENT_TOOLS.find((t) => t.name === 'memory_list')
    expect(mem).toBeDefined()
    expect((mem!.parameters as { required?: string[] }).required).toEqual([])
  })

  it('does not register compact_context (auto + menu compact only)', () => {
    expect(AGENT_TOOLS.find((t) => t.name === 'compact_context')).toBeUndefined()
  })

  it('describes terminal as builds/CLI not file inspection', () => {
    const terminal = AGENT_TOOLS.find((t) => t.name === 'terminal')
    expect(terminal).toBeDefined()
    expect(terminal!.description).toMatch(/shell command/i)
    expect(terminal!.description).toMatch(/not for cat\/type\/findstr/i)
    expect(terminal!.description).toMatch(/keeps running|session_id/i)
    expect(terminal!.description).not.toMatch(/Command timed out/i)
    expect(terminal!.description).not.toMatch(/Settings → Tools/)
    const termProps = (
      terminal!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    expect(termProps.command?.description).not.toMatch(/Settings → Tools/)
    expect(termProps.timeoutMs?.description).toMatch(/New-command wait/)
    expect(termProps.working_directory?.description).toMatch(/Ignored when polling/)
  })

  it('keeps codebase_search conceptual vs exact-id guidance in the tool schema', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'codebase_search')
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/conceptual/i)
    expect(tool!.description).toMatch(/grep\/search/i)
    expect(tool!.description).not.toMatch(/nomic-embed/i)
    const props = (
      tool!.parameters as {
        properties: { query?: { description?: string }; mode?: { description?: string } }
      }
    ).properties
    expect(props.query?.description).toMatch(/grep/i)
    expect(props.mode?.description).toMatch(/lexical/i)
    expect(props.mode?.description).toMatch(/symbol/i)
  })

  it('owns browser @eN freshness and ask_question stacking in tool schemas', () => {
    const snap = AGENT_TOOLS.find((t) => t.name === 'browser_snapshot')
    const nav = AGENT_TOOLS.find((t) => t.name === 'browser_navigate')
    const ask = AGENT_TOOLS.find((t) => t.name === 'ask_question')
    const request = AGENT_TOOLS.find((t) => t.name === 'request_mcp_tools')
    expect(snap!.description).toMatch(/@eN/)
    expect(snap!.description).toMatch(/untrusted/i)
    expect(nav!.description).toMatch(/invalidates prior refs/i)
    expect(request!.description).toMatch(/built-in|MCP/i)
    expect(ask!.description).toMatch(/prefer 1–2|prefer 1-2/i)
  })

  it('emits todo_write status as a string enum', () => {
    const todo = AGENT_TOOLS.find((t) => t.name === 'todo_write')
    expect(todo).toBeTruthy()
    expect(todo!.description).toMatch(/merge/i)
    expect(todo!.description).toMatch(/in_progress/)
    expect(todo!.description).toMatch(/demoted to pending/)
    expect(todo!.description).not.toMatch(/before edit, str_replace, multi_edit, delete, or terminal/)
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
    expect(harness).toContain('<role>')
    expect(harness).toContain('<capabilities>')
    expect(harness).toContain('<tool_policy>')
    expect(harness).toContain('<constraints>')
    expect(harness).toContain('<work_style>')
    expect(harness).toContain('<memory>')
    expect(harness).not.toContain('## Codebase search')
    expect(harness).toMatch(/Prefer `codebase_search` for conceptual/i)
    expect(harness).toContain('<compaction>')
    expect(harness).toContain('auto-compacts')
    expect(harness).toMatch(/memory_write/)
    expect(harness).not.toMatch(/(?<![a-zA-Z])\/compact(?![a-zA-Z])/)
    expect(harness).not.toMatch(/context meter/i)
    expect(harness).not.toContain('compact_context')
    expect(harness).not.toMatch(/\*\*Fire\*\*/)
    expect(harness).not.toMatch(/\*\*Suppress\*\*/)
    expect(harness).toContain('<output_format>')
    expect(harness).toContain('<patterns>')
    expect(harness).toContain('<scope_boundaries>')
    expect(harness).toContain('<reference_points>')
    expect(harness).toContain('<aliases>')
    expect(harness).toContain('<examples>')
    expect(harness).toMatch(/`D1`/)
    expect(harness).toMatch(/`R1`/)
    expect(harness).toMatch(/`F1`/)
    expect(harness).toMatch(/`str`/)
    expect(harness).toMatch(/`eli`/)
    expect(harness).not.toMatch(/pnpm test parseArgs/)
    expect(harness).not.toMatch(/Talk less/i)
    expect(harness).toMatch(/Call tools to inspect and edit/)
    expect(harness).toMatch(/Do not recap the request/)
    expect(harness).toMatch(/narrate routine tool/)
    expect(harness).toMatch(/Before the first tool call/)
    expect(harness).toMatch(/one sentence stating the first step/)
    expect(harness).not.toMatch(/silence between batches/i)
    expect(harness).not.toMatch(/no assistant prose/i)
    expect(harness).toMatch(/ask_question/)
    expect(harness).toMatch(/materially different work/)
    expect(harness).toMatch(/visible reply is the outcome/)
    expect(harness).toMatch(/\[\[path\]\]/)
    expect(harness).toMatch(/\[\[https:\/\/url\]\]/)
    expect(harness).toMatch(/Do not write a Sources list/)
    for (const tag of HARNESS_SECTION_TAGS) {
      if (tag === 'workspace_harness') {
        expect(harness, 'spine must not wrap itself as workspace appendix').not.toContain(
          `</${tag}>`
        )
        continue
      }
      expect(harness).toContain(`<${tag}>`)
      expect(harness).toContain(`</${tag}>`)
    }
    expect(harness).not.toMatch(/^##\s+/m)
    expect(harness).toContain('mcp__<serverId>__<toolName>')
    // MCP allowedTools/deniedTools are runtime-enforced; do not invent allowlist/denylist.
    expect(harness).not.toMatch(/\ballowlist\b/i)
    expect(harness).not.toMatch(/\bdenylist\b/i)
    // WHEN to spawn is catalog-gated in Tool policy; merge HOW stays in the mode overlay.
    expect(harness).toMatch(/Batch independent inspect\/search\/edit\/create/)
    expect(harness).toMatch(/different files only/)
    expect(harness).toMatch(/If `spawn_agent_instance` is in this turn's catalog/)
    expect(harness).toMatch(/one spawn per independent workstream/)
    expect(harness).toMatch(/`goal` complete for that child/)
    expect(harness).toMatch(/then await those `run_id`s in the same step/)
    expect(harness).toMatch(/Do not wrap the whole request as one child/)
    expect(harness).toMatch(/Do not spawn to verify or double-check/)
    expect(harness).not.toMatch(/merge_agent_instance/)
    expect(harness).not.toContain('## Context')
    expect(harness).not.toContain('<attachment')
    expect(harness).not.toMatch(/\*\*read\*\* —/)
    expect(harness).not.toMatch(/\*\*terminal\*\* —/)
    expect(harness).not.toMatch(/\*\*glob\*\* —/)
    expect(harness).toMatch(/workspace file inspection, search, and edits/i)
    expect(harness).toMatch(/not shell commands/i)
    expect(harness).toMatch(/configured host shell/)
    expect(harness).not.toMatch(/On PowerShell/i)
    expect(harness).not.toMatch(/Get-Content/)
    expect(harness).not.toMatch(/Select-Object/)
    expect(harness).toMatch(/Call only names in this turn's catalog/i)
    expect(harness).not.toMatch(/such as `write`/)
    // Index / embedder / settings internals belong in tool schemas, not the harness.
    expect(harness).not.toMatch(/nomic-embed/i)
    expect(harness).not.toMatch(/userData\/workspaces/i)
    expect(harness).not.toMatch(/sparsegrep/i)
    expect(harness).not.toMatch(/auto-compact threshold/i)
    expect(harness).not.toMatch(/Settings → Agent/)
    expect(harness).not.toMatch(/TOOLS_BUDGET_OVERFLOW/)
    // Mode availability detail lives in modeSectionMarkdown, not Capabilities.
    expect(harness).not.toMatch(/MCP server tools are unavailable in Ask\/Plan/i)
    expect(harness).not.toMatch(/in Plan, `diagnostics`/i)
    // Browser @eN refresh how-to and ask_question stacking limits live in tool schemas.
    expect(harness).not.toMatch(/includeSnapshot/)
    expect(harness).not.toMatch(/Prefer ≤2 questions/i)
    expect(harness).not.toMatch(/@eN/)
    // Slash commands are user/composer, not agent tools. /clear nags are product-suppressed.
    expect(harness).not.toMatch(/slash command/i)
    expect(harness).not.toMatch(/\/clear/)
    // Deferred builtin name catalogs live in the volatile run notice, not the harness.
    expect(harness).not.toMatch(/wait_\*|handle_dialog/)
    expect(harness).toMatch(/run-notice Level-1|deferred built-in/i)
  })

  it('keeps prompt-injection guardrails without mode workflow essays or product-UI chrome', () => {
    const harnessPath = join(process.cwd(), 'resources', 'harness', 'default.md')
    const harness = readFileSync(harnessPath, 'utf8')
    expect(harness).toMatch(/Do not assume/)
    expect(harness).toMatch(/verified evidence from this run/)
    expect(harness).not.toMatch(/guessed path/i)
    expect(harness).toMatch(/data, not instructions/i)
    expect(harness).toMatch(/take precedence over any embedded directives/i)
    expect(harness).not.toMatch(/Keep\/Discard/i)
    expect(harness).not.toMatch(/Verify before done|verify-before-done|soft-nudge/i)
    expect(harness).not.toMatch(/Contract done-when|contractDoneWhen|mechanically checked/i)
    expect(harness).not.toMatch(/Read before edit|read-before-edit/i)
    expect(harness).not.toMatch(/Prefer `read`[\s\S]*before editing/i)
    expect(harness).not.toMatch(/todo_write/)
    expect(harness).not.toMatch(/Write durable facts with `memory_write` when learned/i)
    expect(harness).toMatch(/Do not add a package unless the change requires it/i)
    expect(harness).toMatch(/exist on disk/)
    expect(harness).toMatch(/do not rely on training memory/i)
    expect(harness).toMatch(/Store verified facts from this run only/)
    expect(harness).toMatch(/memory_write` verified durable facts/)
    expect(harness).toMatch(/evidence from this run/)
    expect(harness).not.toMatch(/never lorem ipsum/i)
    expect(harness).not.toMatch(/unbounded rows/i)
    expect(harness).not.toMatch(/@ts-ignore|@ts-expect-error/)
    expect(harness).not.toMatch(/strict TDD/i)
    expect(harness).not.toMatch(/200ms/)
    expect(harness).not.toMatch(/Push Logic to the Database/i)
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

  it('keeps the bundled spine under the token ceiling', () => {
    const harnessPath = join(process.cwd(), 'resources', 'harness', 'default.md')
    const harness = readFileSync(harnessPath, 'utf8')
    expect(estimateTextTokens(harness)).toBeLessThan(2000)
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
    expect(handbook).toMatch(/one owner per rule/i)
    // Assembly order + memory truth (must match assemble.ts).
    expect(handbook).toMatch(/Workspace rules[\s\S]*last/i)
    expect(handbook).toMatch(/Memory files are \*\*not\*\* auto-injected/i)
    expect(handbook).toMatch(/workspace_harness/)
    expect(handbook).toMatch(/capHarness/)
    expect(handbook).not.toMatch(/compact fire\/suppress/i)
    expect(handbook).toMatch(/untrusted_content/)
    expect(handbook).toMatch(/cannot override Constraints/i)
    expect(handbook).toMatch(/host-agnostic/)
    expect(handbook).toMatch(/configured\/host shell/)
    // Single receipt.json table row (no duplicate conflicting descriptions).
    const receiptRows = handbook.match(/^\| `receipt\.json`/gm) ?? []
    expect(receiptRows.length).toBe(1)
  })

  it('defaults await_agent_instance timeout_ms without a maximum clamp', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'await_agent_instance')
    expect(tool).toBeDefined()
    const timeout = (
      tool!.parameters as { properties: Record<string, { minimum?: number; maximum?: number; description?: string }> }
    ).properties.timeout_ms
    expect(timeout.minimum).toBe(1_000)
    expect(timeout.maximum).toBeUndefined()
    expect(timeout.description).toContain(String(AWAIT_AGENT_INSTANCE_MAX_MS))
    expect(
      validateToolArgs(
        'await_agent_instance',
        JSON.stringify({ run_id: 'child-1', timeout_ms: AWAIT_AGENT_INSTANCE_MAX_MS + 1 })
      ).ok
    ).toBe(true)
  })

  it('describes spawn as an independent workstream and rejects whitespace-only goals at Zod', () => {
    const spawn = AGENT_TOOLS.find((t) => t.name === 'spawn_agent_instance')
    expect(spawn).toBeDefined()
    expect(spawn!.description).toMatch(/independent workstream/)
    expect(spawn!.description).toMatch(/Multiple independent spawns in one step/)
    expect(spawn!.description).toMatch(/then await those ids together/)
    const goal = (
      spawn!.parameters as { properties: Record<string, { description?: string }> }
    ).properties.goal
    expect(goal.description).toMatch(/child-only user prompt/i)
    expect(goal.description).toMatch(/sub-tasks/)
    expect(goal.description).toMatch(/no parent transcript/i)
    expect(validateToolArgs('spawn_agent_instance', JSON.stringify({ goal: '   ' })).ok).toBe(false)
    expect(validateToolArgs('spawn_agent_instance', JSON.stringify({ goal: 'audit src/main' })).ok).toBe(
      true
    )
  })

  it('describes await as waiting those spawn ids together in one step', () => {
    const awaitTool = AGENT_TOOLS.find((t) => t.name === 'await_agent_instance')
    expect(awaitTool).toBeDefined()
    expect(awaitTool!.description).toMatch(/summary/)
    expect(awaitTool!.description).toMatch(/Await those spawn ids together in one step/)
  })

  it('describes search as text-only without a skip-size cap', () => {
    const search = AGENT_TOOLS.find((t) => t.name === 'search')
    expect(search).toBeDefined()
    expect(search!.description).toMatch(/Text files only/)
    expect(search!.description).not.toMatch(/256 KB/)
    expect(search!.description).not.toMatch(/512 KB/)
  })

  it('describes grep as text-only without a skip-size cap', () => {
    const grep = AGENT_TOOLS.find((t) => t.name === 'grep')
    expect(grep).toBeDefined()
    expect(grep!.description).toMatch(/Text files only/)
    expect(grep!.description).not.toMatch(/KB are skipped/)
  })

  it('emits codebase_search maxResults without a maximum', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'codebase_search')
    expect(tool).toBeDefined()
    const maxResults = (
      tool!.parameters as { properties: Record<string, { maximum?: number }> }
    ).properties.maxResults
    expect(maxResults.maximum).toBeUndefined()
  })

  it('keeps handler-true descriptions for delete, list_dir, git_commit, ask, diagnostics', () => {
    const byName = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t.description]))
    expect(byName.delete).toMatch(/non-empty directory/)
    expect(byName.list_dir).toMatch(/Gitignore/)
    expect(byName.git_commit).toMatch(/paths is omitted/)
    expect(byName.ask_question).toMatch(/Never call with \{\}/)
    expect(byName.diagnostics).toMatch(/no override command/)
  })

  it('emits memory_write contents without a maxLength', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'memory_write')
    expect(tool).toBeDefined()
    const contents = (
      tool!.parameters as { properties: Record<string, { maxLength?: number }> }
    ).properties.contents
    expect(contents.maxLength).toBeUndefined()
    expect(tool!.description).not.toMatch(/64 KiB/)
    expect(
      validateToolArgs(
        'memory_write',
        JSON.stringify({ path: 'index.md', contents: 'x'.repeat(80_000) })
      ).ok
    ).toBe(true)
  })

  it('emits nav and wait timeoutMs without a maximum clamp', () => {
    const nav = AGENT_TOOLS.find((t) => t.name === 'browser_navigate')
    const wait = AGENT_TOOLS.find((t) => t.name === 'browser_wait_for_selector')
    const navTimeout = (
      nav!.parameters as { properties: Record<string, { maximum?: number }> }
    ).properties.timeoutMs
    const waitTimeout = (
      wait!.parameters as { properties: Record<string, { maximum?: number }> }
    ).properties.timeoutMs
    expect(navTimeout.maximum).toBeUndefined()
    expect(waitTimeout.maximum).toBeUndefined()
    expect(
      validateToolArgs(
        'browser_navigate',
        JSON.stringify({ url: 'https://example.com', timeoutMs: MAX_NAV_TIMEOUT_MS + 1 })
      ).ok
    ).toBe(true)
  })

  it('rejects empty search/glob/grep patterns at Zod', () => {
    expect(validateToolArgs('search', JSON.stringify({ query: '' })).ok).toBe(false)
    expect(validateToolArgs('glob', JSON.stringify({ pattern: '' })).ok).toBe(false)
    expect(validateToolArgs('grep', JSON.stringify({ pattern: '' })).ok).toBe(false)
    expect(validateToolArgs('search', JSON.stringify({ query: '   ' })).ok).toBe(false)
    expect(validateToolArgs('glob', JSON.stringify({ pattern: '   ' })).ok).toBe(false)
    expect(validateToolArgs('grep', JSON.stringify({ pattern: '   ' })).ok).toBe(false)
  })

  it('rejects empty required paths and browser_navigate URLs at Zod', () => {
    expect(validateToolArgs('read', JSON.stringify({ path: '' })).ok).toBe(false)
    expect(validateToolArgs('memory_read', JSON.stringify({ path: '   ' })).ok).toBe(false)
    expect(validateToolArgs('browser_navigate', JSON.stringify({ url: '' })).ok).toBe(false)
  })

  it('rejects whitespace-only required browser selectors, keys, and MCP ids', () => {
    expect(validateToolArgs('browser_click', JSON.stringify({ selector: '   ' })).ok).toBe(false)
    expect(validateToolArgs('browser_press_key', JSON.stringify({ key: '   ' })).ok).toBe(false)
    expect(
      validateToolArgs('mcp_read_resource', JSON.stringify({ serverId: '   ', uri: 'file://x' })).ok
    ).toBe(false)
  })

  it('describes settle and nav/wait defaults from the same browser constants', () => {
    const click = AGENT_TOOLS.find((t) => t.name === 'browser_click')
    const nav = AGENT_TOOLS.find((t) => t.name === 'browser_navigate')
    const wait = AGENT_TOOLS.find((t) => t.name === 'browser_wait_for_selector')
    const clickProps = (
      click!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    const navProps = (
      nav!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    const waitProps = (
      wait!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    expect(clickProps.settleMs?.description).toContain(String(SETTLE_FALLBACK_MS))
    expect(navProps.timeoutMs?.description).toContain(String(DEFAULT_NAV_TIMEOUT_MS))
    expect(waitProps.timeoutMs?.description).toContain(String(DEFAULT_WAIT_TIMEOUT_MS))
  })

  it('rejects browser_tabs select without tab_id', () => {
    const result = validateToolArgs('browser_tabs', JSON.stringify({ action: 'select' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/tab_id is required/)
  })

  it('emits browser_type/fill without a maxLength', () => {
    const type = AGENT_TOOLS.find((t) => t.name === 'browser_type')
    const fill = AGENT_TOOLS.find((t) => t.name === 'browser_fill')
    const typeText = (
      type!.parameters as { properties: Record<string, { maxLength?: number }> }
    ).properties.text
    const fillValue = (
      fill!.parameters as { properties: Record<string, { maxLength?: number }> }
    ).properties.value
    expect(typeText.maxLength).toBeUndefined()
    expect(fillValue.maxLength).toBeUndefined()
    expect(
      validateToolArgs(
        'browser_type',
        JSON.stringify({ text: 'x'.repeat(MAX_TYPE_CHARS + 1) })
      ).ok
    ).toBe(true)
  })

  it('emits snapshot maxChars default matching DEFAULT_SNAPSHOT_CHARS', () => {
    const snap = AGENT_TOOLS.find((t) => t.name === 'browser_snapshot')
    expect(snap).toBeDefined()
    const maxChars = (
      snap!.parameters as { properties: Record<string, { description?: string }> }
    ).properties.maxChars
    expect(maxChars.description).toContain(String(DEFAULT_SNAPSHOT_CHARS))
  })

  it('prefers line-range when offset/limit are also passed', () => {
    const mixed = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', startLine: 1, endLine: 10, offset: 1, limit: 240 })
    )
    expect(mixed.ok).toBe(true)
    if (!mixed.ok) return
    expect(mixed.data.startLine).toBe(1)
    expect(mixed.data.endLine).toBe(10)
    expect(mixed.data.offset).toBeUndefined()
    expect(mixed.data.limit).toBeUndefined()

    const offsetZero = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', startLine: 1, offset: 0 })
    )
    expect(offsetZero.ok).toBe(true)
    if (!offsetZero.ok) return
    expect(offsetZero.data.startLine).toBe(1)
    expect(offsetZero.data.offset).toBeUndefined()
  })

  it('swaps inverted startLine/endLine instead of failing', () => {
    const swapped = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', startLine: 20, endLine: 5 })
    )
    expect(swapped.ok).toBe(true)
    if (!swapped.ok) return
    expect(swapped.data.startLine).toBe(5)
    expect(swapped.data.endLine).toBe(20)
  })

  it('treats offset 0 with no limit as unset and keeps a real byte window', () => {
    const noop = validateToolArgs('read', JSON.stringify({ path: 'a.ts', offset: 0 }))
    expect(noop.ok).toBe(true)
    if (!noop.ok) return
    expect(noop.data.offset).toBeUndefined()
    expect(noop.data.limit).toBeUndefined()

    const fromStart = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', offset: 0, limit: 20 })
    )
    expect(fromStart.ok).toBe(true)
    if (!fromStart.ok) return
    expect(fromStart.data.offset).toBe(0)
    expect(fromStart.data.limit).toBe(20)

    const window = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', offset: 10, limit: 20 })
    )
    expect(window.ok).toBe(true)
    if (!window.ok) return
    expect(window.data.offset).toBe(10)
    expect(window.data.limit).toBe(20)
    expect(window.data.startLine).toBeUndefined()
  })

  it('accepts terminal command together with session_id (command wins)', () => {
    const result = validateToolArgs(
      'terminal',
      JSON.stringify({
        command: 'echo hi',
        session_id: 'e8b8f89f-1b26-4c5b-a1dd-a93800d05fbb',
        pattern: ''
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.command).toBe('echo hi')
    expect(result.data.session_id).toBeUndefined()
    expect(result.data.pattern).toBeUndefined()
  })

  it('rejects multi_edit items that pass both contents and diff', () => {
    const result = validateToolArgs(
      'multi_edit',
      JSON.stringify({
        edits: [{ path: 'a.ts', contents: 'x', diff: '@@ -1 +1 @@\n-a\n+b\n' }]
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/contents or diff, not both/)
  })

  it('rejects request_mcp_tools and release_mcp_tools without tools or serverId', () => {
    const request = validateToolArgs('request_mcp_tools', '{}')
    const release = validateToolArgs('release_mcp_tools', '{}')
    expect(request.ok).toBe(false)
    expect(release.ok).toBe(false)
    if (!request.ok) expect(request.error).toMatch(/tools: string\[\] and\/or serverId/)
    if (!release.ok) expect(release.error).toMatch(/tools: string\[\] and\/or serverId/)
  })

  it('rejects whitespace-only git_commit messages at Zod', () => {
    const result = validateToolArgs('git_commit', JSON.stringify({ message: '   ' }))
    expect(result.ok).toBe(false)
  })

  it('accepts memory_write contents of any size at Zod', () => {
    const result = validateToolArgs(
      'memory_write',
      JSON.stringify({ path: 'index.md', contents: 'x'.repeat(80_000) })
    )
    expect(result.ok).toBe(true)
  })
})
