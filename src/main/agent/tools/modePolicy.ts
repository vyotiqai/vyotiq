import { basename, normalize } from 'path'
import type { AgentInteractionMode } from '../../../shared/ipc'
import { parseMcpToolName } from '../mcp'
import { wrapPromptSection } from '../promptSections'
import { AGENT_ONLY_BUILTIN } from './classify'

/** Options for mode policy gates (tool allowlists + mode section prompts). */
export type ModePolicyOptions = {
  /** When true, agent may call `switch_mode`. Default false. */
  autoModeSwitch?: boolean
  /** When true, omit root-only instance tools (depth-1 nesting). */
  inlineInstance?: boolean
}

/**
 * Built-in tools allowed in Ask mode (read-only / parallel-safe).
 * `browser_search` intentionally navigates the agent browser to a search URL
 * (browse-only — same egress as `browser_navigate`; not click/type/fill).
 */
export const ASK_SAFE_BUILTIN = new Set([
  'read',
  'search',
  'glob',
  'grep',
  'codebase_search',
  'list_dir',
  'browser_search',
  'ask_question',
  // Browse-only: click/type/fill/press_key/select can mutate live sites.
  'browser_navigate',
  'browser_snapshot',
  'browser_scroll',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_wait_for_text',
  'browser_hover',
  // Catalog listers only. `mcp_read_resource` / `mcp_get_prompt` call into a
  // server and return server-controlled content, so they stay Agent-only like
  // every other MCP invocation.
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_list_prompts',
  'memory_list',
  'memory_read',
  'Skill',
  'git_status',
  'git_diff'
  // `diagnostics` spawns a shell — Plan-only (see PLAN_EXTRA / agent), not Ask.
])

/** Plan mode also allows todos + plan-artifact edits + diagnostics. */
const PLAN_EXTRA_BUILTIN = new Set(['todo_write', 'edit', 'str_replace', 'multi_edit', 'diagnostics'])

/** Filenames Plan mode may write inside the run directory. */
export const PLAN_ARTIFACT_NAMES = new Set(['contract.md', 'plan.md'])

export function isPlanArtifactPath(pathArg: string): boolean {
  const base = basename(normalize(pathArg.replace(/\\/g, '/')))
  return PLAN_ARTIFACT_NAMES.has(base)
}

/** Workspace-relative path with `./` stripped — not nested `src/contract.md`. */
function exactRunArtifactRelPath(pathArg: string): string {
  return pathArg.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Run contract file — remapped to the run directory in Plan and Agent modes. */
export function isRunContractPath(pathArg: string): boolean {
  return exactRunArtifactRelPath(pathArg) === 'contract.md'
}

/** Run plan.md — remapped in Plan always; in Agent when a run plan artifact exists. */
export function isRunPlanPath(pathArg: string): boolean {
  return exactRunArtifactRelPath(pathArg) === 'plan.md'
}

function autoModeSwitchEnabled(opts?: ModePolicyOptions): boolean {
  return opts?.autoModeSwitch === true
}

function autoModeSwitchBanner(mode: AgentInteractionMode, auto: boolean): string[] {
  if (!auto) {
    return [
      'Automatic mode switching is OFF. `switch_mode` is unavailable — only the user changes Ask / Plan / Agent (composer picker or slash).'
    ]
  }
  switch (mode) {
    case 'agent':
      return [
        'Automatic mode switching is ON. Call `switch_mode` to `ask` for pure Q&A with no edits, or to `plan` for a fresh multi-step plan before more edits. Do not wait for the user to change mode in the composer.'
      ]
    case 'ask':
      return [
        'Automatic mode switching is ON. Call `switch_mode` to `plan` before writing plan artifacts, or to `agent` before editing. Do not wait for the user to change mode in the composer.'
      ]
    case 'plan':
      return [
        'Automatic mode switching is ON. Call `switch_mode` to `agent` before editing product code, or to `ask` for Q&A with no plan. Do not wait for the user to change mode in the composer.'
      ]
    default: {
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}

export function modeSectionMarkdown(
  mode: AgentInteractionMode,
  opts?: ModePolicyOptions
): string | null {
  const auto = autoModeSwitchEnabled(opts)
  switch (mode) {
    case 'agent':
      return wrapPromptSection(
        'mode',
        [
          'Agent mode. Edit files, run `terminal`, write memory, and use the catalog (subject to approval). Prefer non-destructive commands. Workspace tool-vs-shell rules live in Tool policy.',
          ...autoModeSwitchBanner(mode, auto),
          'Follow the run contract; if an approved plan is present, implement it unless the user redirects. Use `ask_question` for ambiguous product decisions.',
          ...(opts?.inlineInstance
            ? []
            : [
                "`spawn_agent_instance` `goal` is the child's only user message (no parent transcript or plan.md). Write it as that workstream's complete prompt: outcome, dependent sub-tasks, done-when, and path constraints. Spawn each independent workstream, then `await_agent_instance` those `run_id`s together. Dependent work stays in one `goal` (children cannot nest). Git worktrees isolate writes; without a worktree, `path_scope` is required. `pull_agent_instance` for outline or tail. Pin `merge_agent_instance` for a done worktree branch (parent clean, one at a time). Shared `path_scope` instances already wrote in the parent tree — do not merge them."
              ])
        ].join('\n')
      )
    case 'ask':
      return wrapPromptSection(
        'mode',
        [
          'Ask mode. Use read-only built-in tools. MCP server tools are not available (server-reported readOnlyHint is untrusted); you may still list MCP catalogs, but not read resources or fetch prompts.',
          'Only avoid mutating tools. Do not edit files, delete paths, run the `terminal` tool, run `diagnostics`, or write memory.',
          ...autoModeSwitchBanner(mode, auto),
          ...(auto
            ? []
            : ['If the user needs changes, explain what you would do and suggest switching to Agent mode.'])
        ].join('\n')
      )
    case 'plan':
      return wrapPromptSection(
        'mode',
        [
          'Plan mode. Explore with read-only built-in tools. MCP server tools, resources, and prompts are not available — readOnlyHint is untrusted as a security gate; catalog listing is still allowed. Update `plan.md` and `contract.md` incrementally (run plan artifacts — not product source). Prefer updating the injected plan rather than re-deriving it.',
          'Fill `plan.md` with Goal (desired result), Success criteria (how we know it worked), Scope (included and excluded), Open questions (needs a user decision), Approach (direction and why), Ordered steps (small phases), Verification (how finished work will be checked), and Risks or trade-offs. Copy Success criteria into `contract.md` ## Done when. Use `ask_question` for blocking Open questions.',
          '`todo_write` is available. `diagnostics` runs the configured workspace diagnostics command (process exec — not read-only; subject to tool approval). Do not edit application code, delete files, or run the `terminal` tool.',
          ...autoModeSwitchBanner(mode, auto),
          ...(auto
            ? []
            : ['End with a clear plan the user can approve by switching to Agent mode.'])
        ].join('\n')
      )
    default: {
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}

export function isBuiltinAllowedInMode(
  mode: AgentInteractionMode,
  name: string,
  opts?: ModePolicyOptions
): boolean {
  if (name === 'switch_mode') return autoModeSwitchEnabled(opts)
  if (mode === 'agent') return true
  if (ASK_SAFE_BUILTIN.has(name)) return true
  if (mode === 'plan' && PLAN_EXTRA_BUILTIN.has(name)) return true
  return false
}

/**
 * MCP tools are Agent-mode only. Server-reported `readOnlyHint` is untrusted
 * as a security gate (see classify.ts) — never use it to allow Ask/Plan.
 */
export function isMcpAllowedInMode(mode: AgentInteractionMode, _fullName: string): boolean {
  return mode === 'agent'
}

export function filterToolDefsForMode<T extends { name: string }>(
  mode: AgentInteractionMode,
  defs: T[],
  opts?: ModePolicyOptions
): T[] {
  let filtered =
    mode === 'agent' && autoModeSwitchEnabled(opts)
      ? defs
      : defs.filter((t) => {
          if (parseMcpToolName(t.name)) return isMcpAllowedInMode(mode, t.name)
          return isBuiltinAllowedInMode(mode, t.name, opts)
        })
  if (opts?.inlineInstance) {
    filtered = filtered.filter((t) => !AGENT_ONLY_BUILTIN.has(t.name))
  }
  return filtered
}

/** Drop `codebase_search` when Settings → Indexing is off. */
export function filterToolDefsForCodeIndex<T extends { name: string }>(
  defs: T[],
  codeIndexEnabled: boolean
): T[] {
  if (codeIndexEnabled) return defs
  return defs.filter((t) => t.name !== 'codebase_search')
}

export type ModeDenyResult = { ok: true } | { ok: false; error: string }

/**
 * Hard gate before executing a tool. Plan edit/str_replace must target plan artifacts.
 */
export function assertToolAllowedInMode(
  mode: AgentInteractionMode,
  name: string,
  args: Record<string, unknown>,
  opts?: ModePolicyOptions
): ModeDenyResult {
  const auto = autoModeSwitchEnabled(opts)
  const switchToAgentHint = auto
    ? 'Call `switch_mode` with mode "agent" first.'
    : 'Switch to Agent mode to make changes.'
  if (name === 'switch_mode' && !auto) {
    return {
      ok: false,
      error:
        'Automatic mode switching is off. Only the user can change Ask / Plan / Agent (composer or slash).'
    }
  }

  if (opts?.inlineInstance && AGENT_ONLY_BUILTIN.has(name)) {
    return {
      ok: false,
      error: `Tool "${name}" is only available on the root orchestrator (inline instances cannot nest).`
    }
  }

  if (AGENT_ONLY_BUILTIN.has(name) && mode !== 'agent') {
    return {
      ok: false,
      error: `Tool "${name}" requires Agent mode. ${switchToAgentHint}`
    }
  }

  if (mode === 'agent') return { ok: true }

  const mcp = parseMcpToolName(name)
  if (mcp) {
    if (!isMcpAllowedInMode(mode, name)) {
      return {
        ok: false,
        error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow MCP tools. "${name}" requires Agent mode. ${switchToAgentHint}`
      }
    }
    return { ok: true }
  }

  if (!isBuiltinAllowedInMode(mode, name, opts)) {
    return {
      ok: false,
      error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow tool "${name}". ${switchToAgentHint}`
    }
  }

  if (mode === 'plan' && (name === 'edit' || name === 'str_replace')) {
    const path = typeof args.path === 'string' ? args.path : ''
    if (!isPlanArtifactPath(path)) {
      return {
        ok: false,
        error: auto
          ? 'Plan mode may only edit plan.md or contract.md (run plan artifacts). Call `switch_mode` with mode "agent" to edit product code.'
          : 'Plan mode may only edit plan.md or contract.md (run plan artifacts). Switch to Agent mode to edit product code.'
      }
    }
  }

  if (mode === 'plan' && name === 'multi_edit') {
    const edits = Array.isArray(args.edits) ? args.edits : []
    for (const entry of edits) {
      const path =
        entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string'
          ? (entry as { path: string }).path
          : ''
      if (!isPlanArtifactPath(path)) {
        return {
          ok: false,
          error: auto
            ? 'Plan mode multi_edit may only target plan.md or contract.md. Call `switch_mode` with mode "agent" to edit product code.'
            : 'Plan mode multi_edit may only target plan.md or contract.md. Switch to Agent mode to edit product code.'
        }
      }
    }
  }

  return { ok: true }
}
