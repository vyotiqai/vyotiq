import { basename, normalize } from 'path'
import type { AgentInteractionMode } from '../../../shared/ipc'
import { parseMcpToolName } from '../mcp'

/** Options for mode policy gates (tool allowlists + mode section prompts). */
export type ModePolicyOptions = {
  /** When true, agent may call `switch_mode`. Default false. */
  autoModeSwitch?: boolean
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
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  'memory_list',
  'memory_read',
  'Skill',
  'git_status',
  'git_diff',
  // Describe-only in Ask/Plan (handler dry-runs); Agent writes the file.
  'generate_image',
  'edit_image'
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

/** Run contract file — remapped to the run directory in Plan and Agent modes. */
export function isRunContractPath(pathArg: string): boolean {
  const base = basename(normalize(pathArg.replace(/\\/g, '/')))
  return base === 'contract.md'
}

/** Run plan.md — remapped in Plan always; in Agent when a run plan artifact exists. */
export function isRunPlanPath(pathArg: string): boolean {
  const base = basename(normalize(pathArg.replace(/\\/g, '/')))
  return base === 'plan.md'
}

function autoModeSwitchEnabled(opts?: ModePolicyOptions): boolean {
  return opts?.autoModeSwitch === true
}

export function modeSectionMarkdown(
  mode: AgentInteractionMode,
  opts?: ModePolicyOptions
): string | null {
  const auto = autoModeSwitchEnabled(opts)
  switch (mode) {
    case 'agent':
      return [
        '## Mode: Agent',
        '',
        'You are in Agent mode. You may edit files, run the `terminal` tool, write memory,',
        'and use the full tools catalog (subject to user approval settings).',
        '`generate_image` / `edit_image` write image files under the workspace (checkpointed).',
        'Workspace writes are checkpointed for Keep/Discard; plan.md / contract.md run',
        'artifacts are not. Prefer non-destructive commands.',
        'Follow the run contract; if an approved `## Plan` is present, implement it unless',
        'the user redirects you. Use `ask_question` for ambiguous product decisions.',
        ...(auto
          ? [
              'When the task becomes pure Q&A with no edits, call `switch_mode` to `ask`.',
              'When you need a fresh multi-step plan before more edits, call `switch_mode` to `plan`.'
            ]
          : [])
      ].join('\n')
    case 'ask':
      return [
        '## Mode: Ask',
        '',
        'You are in Ask mode. Use read-only built-in tools liberally to investigate and answer.',
        'MCP tools are not available in Ask mode (server-reported readOnlyHint is untrusted).',
        'Only avoid mutating tools. Do not edit files, delete paths, run the `terminal` tool,',
        'run `diagnostics`, or write memory. `generate_image` / `edit_image` are dry-run only (describe',
        'path/provider; no API call or file write — switch to Agent to save).',
        ...(auto
          ? [
              'If the user wants a multi-step plan, call `switch_mode` to `plan` before writing plan artifacts.',
              'If the user wants code or other changes, call `switch_mode` to `agent` before editing.'
            ]
          : [
              'If the user needs changes, explain what you would do and suggest switching to Agent mode.'
            ])
      ].join('\n')
    case 'plan':
      return [
        '## Mode: Plan',
        '',
        'You are in Plan mode. Explore with read-only built-in tools',
        '(MCP tools are not available — readOnlyHint is untrusted as a security gate),',
        'and update `plan.md` and `contract.md` incrementally (run plan artifacts — not product source).',
        'Prefer updating the injected `## Plan` rather than re-deriving it from scratch each turn.',
        '`todo_write` and `diagnostics` are available. `generate_image` / `edit_image` are dry-run only',
        '(no API call or file write). Do not edit application code, delete files,',
        'or run the `terminal` tool.',
        ...(auto
          ? [
              'When a clear plan is ready to implement, call `switch_mode` to `agent`.',
              'If the user only wants Q&A with no plan, call `switch_mode` to `ask`.'
            ]
          : ['End with a clear plan the user can approve by switching to Agent mode.'])
      ].join('\n')
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
  if (mode === 'agent' && autoModeSwitchEnabled(opts)) return defs
  return defs.filter((t) => {
    if (parseMcpToolName(t.name)) return isMcpAllowedInMode(mode, t.name)
    return isBuiltinAllowedInMode(mode, t.name, opts)
  })
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
  if (name === 'switch_mode' && !autoModeSwitchEnabled(opts)) {
    return {
      ok: false,
      error:
        'Automatic mode switching is off. Only the user can change Ask / Plan / Agent (composer or slash).'
    }
  }

  if (mode === 'agent') return { ok: true }

  const mcp = parseMcpToolName(name)
  if (mcp) {
    if (!isMcpAllowedInMode(mode, name)) {
      return {
        ok: false,
        error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow MCP tools. "${name}" requires Agent mode.`
      }
    }
    return { ok: true }
  }

  if (!isBuiltinAllowedInMode(mode, name, opts)) {
    return {
      ok: false,
      error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow tool "${name}". Switch to Agent mode to make changes.`
    }
  }

  if (mode === 'plan' && (name === 'edit' || name === 'str_replace')) {
    const path = typeof args.path === 'string' ? args.path : ''
    if (!isPlanArtifactPath(path)) {
      return {
        ok: false,
        error:
          'Plan mode may only edit plan.md or contract.md (run plan artifacts). Switch to Agent mode to edit product code.'
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
          error:
            'Plan mode multi_edit may only target plan.md or contract.md. Switch to Agent mode to edit product code.'
        }
      }
    }
  }

  return { ok: true }
}
