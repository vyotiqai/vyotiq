import { readdir, readFile, stat } from 'fs/promises'
import { existsSync, statSync, type Dirent } from 'fs'
import { join, relative, sep } from 'path'

/**
 * Project instruction files, read in precedence order. A workspace that ships
 * conventions in AGENTS.md expects the agent to follow them without being told
 * in every prompt, so they belong in the system prompt rather than the history.
 */
const ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules']
const RULE_DIRS = [
  { dir: join('.cursor', 'rules'), extensions: ['.md', '.mdc'] },
  { dir: join('.vyotiq', 'rules'), extensions: ['.md'] }
]

const CACHE_TTL_MS = 30_000
/** A single runaway rules file should not evict the harness from the prompt. */
const MAX_FILE_BYTES = 64 * 1024
const MAX_RULE_FILES = 24
const MAX_DIR_DEPTH = 3

export type RuleFile = { path: string; content: string }

export type RuleFrontmatter = {
  alwaysApply?: boolean
  globs?: string[]
  description?: string
}

type CacheEntry = { fingerprint: string; files: RuleFile[]; builtAt: number }

const cache = new Map<string, CacheEntry>()

export function clearRulesCache(workspacePath?: string): void {
  if (workspacePath) cache.delete(workspacePath)
  else cache.clear()
}

function fingerprintFor(workspacePath: string): string {
  const parts: string[] = []
  for (const name of ROOT_FILES) {
    const p = join(workspacePath, name)
    try {
      parts.push(existsSync(p) ? `${name}:${statSync(p).mtimeMs}` : `${name}:-`)
    } catch {
      parts.push(`${name}:?`)
    }
  }
  for (const { dir } of RULE_DIRS) {
    const p = join(workspacePath, dir)
    try {
      parts.push(existsSync(p) ? `${dir}:${statSync(p).mtimeMs}` : `${dir}:-`)
    } catch {
      parts.push(`${dir}:?`)
    }
  }
  return parts.join('|')
}

/**
 * Parse Cursor-style YAML frontmatter from a rule file.
 * Supports `alwaysApply`, `globs` (comma or YAML-list style), and `description`.
 */
export function parseRuleFrontmatter(raw: string): {
  meta: RuleFrontmatter
  body: string
} {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) {
    return { meta: {}, body: trimmed }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: trimmed }
  const fmBlock = trimmed.slice(3, end).trim()
  let body = trimmed.slice(end + 4).replace(/^\r?\n/, '')
  const meta: RuleFrontmatter = {}
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    const value = m[2]!.trim()
    if (key === 'alwaysApply') {
      // Empty / missing value ⇒ leave unset (auto-inject). Only explicit false skips.
      if (!value) {
        /* absent */
      } else if (/^(true|yes|1)$/i.test(value)) {
        meta.alwaysApply = true
      } else if (/^(false|no|0)$/i.test(value)) {
        meta.alwaysApply = false
      }
    } else if (key === 'description') {
      meta.description = value.replace(/^["']|["']$/g, '')
    } else if (key === 'globs') {
      const inner = value.replace(/^\[|\]$/g, '')
      meta.globs = inner
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }
  }
  return { meta, body: body.trim() }
}

/**
 * Auto-inject when alwaysApply is true/absent.
 * `alwaysApply: false` rules are requestable (slash /create-rule open) — skip auto-inject.
 * Without active-file context, globs alone do not auto-inject when alwaysApply is false.
 */
export function shouldAutoInjectRule(meta: RuleFrontmatter): boolean {
  if (meta.alwaysApply === false) return false
  return true
}

async function readCapped(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) return null
    const text = await readFile(filePath, 'utf8')
    if (text.length <= MAX_FILE_BYTES) return text.trim() || null
    return `${text.slice(0, MAX_FILE_BYTES).trim()}\n… (truncated)`
  } catch {
    return null
  }
}

function normalizeRuleContent(raw: string): string | null {
  const { meta, body } = parseRuleFrontmatter(raw)
  if (!shouldAutoInjectRule(meta)) return null
  const content = body.trim()
  return content || null
}

async function collectFromDir(
  workspacePath: string,
  dirPath: string,
  extensions: string[],
  depth: number,
  out: RuleFile[]
): Promise<void> {
  if (depth > MAX_DIR_DEPTH || out.length >= MAX_RULE_FILES) return
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  // Stable order so the prompt does not churn between runs on the same workspace.
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    if (out.length >= MAX_RULE_FILES) return
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await collectFromDir(workspacePath, full, extensions, depth + 1, out)
      continue
    }
    if (!extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) continue
    const raw = await readCapped(full)
    if (!raw) continue
    const content = normalizeRuleContent(raw)
    if (content) {
      out.push({ path: relative(workspacePath, full).split(sep).join('/'), content })
    }
  }
}

/** Read every workspace instruction file, in precedence order. */
export async function readWorkspaceRules(workspacePath: string | null): Promise<RuleFile[]> {
  if (!workspacePath) return []

  const fingerprint = fingerprintFor(workspacePath)
  const cached = cache.get(workspacePath)
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached.files
  }

  const files: RuleFile[] = []
  for (const name of ROOT_FILES) {
    const raw = await readCapped(join(workspacePath, name))
    if (!raw) continue
    // Root files have no Cursor frontmatter contract — inject as-is.
    files.push({ path: name, content: raw })
  }
  for (const { dir, extensions } of RULE_DIRS) {
    await collectFromDir(workspacePath, join(workspacePath, dir), extensions, 0, files)
  }

  cache.set(workspacePath, { fingerprint, files, builtAt: Date.now() })
  return files
}

/**
 * Render the rules as a system-prompt section. Each file keeps its path as a
 * header so the model can cite where an instruction came from.
 */
export function formatWorkspaceRules(files: RuleFile[]): string {
  if (!files.length) return ''
  const body = files
    .map((file) => `### ${file.path}\n${file.content}`)
    .join('\n\n')
  return [
    '## Workspace rules',
    'Project-authored instructions. Follow them unless the user overrides them in this conversation.',
    '',
    body
  ].join('\n')
}

export async function buildWorkspaceRulesSection(
  workspacePath: string | null
): Promise<string> {
  return formatWorkspaceRules(await readWorkspaceRules(workspacePath))
}

export type WorkspaceRuleListItem = {
  path: string
  description?: string
  /** False when frontmatter sets alwaysApply: false (requestable). */
  alwaysApply: boolean
}

/**
 * List all workspace rules for @-mentions — includes `alwaysApply: false` rules
 * that are skipped from auto-injection.
 */
export async function listWorkspaceRulesForMention(
  workspacePath: string | null
): Promise<WorkspaceRuleListItem[]> {
  if (!workspacePath) return []

  const out: WorkspaceRuleListItem[] = []
  const seen = new Set<string>()

  const push = (rel: string, raw: string): void => {
    const path = rel.split(sep).join('/')
    if (seen.has(path) || out.length >= MAX_RULE_FILES) return
    seen.add(path)
    const { meta } = parseRuleFrontmatter(raw)
    out.push({
      path,
      description: meta.description,
      alwaysApply: meta.alwaysApply !== false
    })
  }

  for (const name of ROOT_FILES) {
    const raw = await readCapped(join(workspacePath, name))
    if (!raw) continue
    // Root instruction files have no alwaysApply:false contract — treat as always.
    push(name, raw)
  }

  for (const { dir, extensions } of RULE_DIRS) {
    const dirPath = join(workspacePath, dir)
    const collected: RuleFile[] = []
    await collectFromDirAll(workspacePath, dirPath, extensions, 0, collected)
    for (const file of collected) {
      push(file.path, file.content)
    }
  }

  return out
}

/** Like collectFromDir but keeps alwaysApply:false bodies (raw, not normalized). */
async function collectFromDirAll(
  workspacePath: string,
  dirPath: string,
  extensions: string[],
  depth: number,
  out: RuleFile[]
): Promise<void> {
  if (depth > MAX_DIR_DEPTH || out.length >= MAX_RULE_FILES) return
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    if (out.length >= MAX_RULE_FILES) return
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await collectFromDirAll(workspacePath, full, extensions, depth + 1, out)
      continue
    }
    if (!extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) continue
    const raw = await readCapped(full)
    if (!raw) continue
    out.push({ path: relative(workspacePath, full).split(sep).join('/'), content: raw })
  }
}
