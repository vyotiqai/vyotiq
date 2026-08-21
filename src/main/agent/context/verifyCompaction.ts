import {
  isPlausibleWorkspaceFilePath,
  normalizeWorkspaceRelPath,
  type FoldFacts
} from './foldFacts'

export type CompactionVerifyFailureKind =
  | 'invented_path'
  | 'missing_decision'
  | 'missing_wrote_file'
  | 'missing_contract_goal'
  | 'low_file_coverage'

export type CompactionVerifyFailure = {
  kind: CompactionVerifyFailureKind
  detail: string
}

export type CompactionVerifyResult = {
  ok: boolean
  /** Share of extracted files mentioned in the summary (0 when none extracted). */
  coverage: number
  failures: CompactionVerifyFailure[]
  mentionedFiles: string[]
}

/** Mention at least half of extracted files when two or more exist. */
export const FILE_COVERAGE_RATIO = 0.5

/**
 * Cap on coverage citations. A 77-file audit fold (d7dcdfbf) would otherwise
 * demand 39 names in a compact summary (`29/77 need 39`).
 */
export const FILE_COVERAGE_MAX_NEEDED = 8

function coverageNeeded(fileCount: number): number {
  return Math.min(
    Math.max(1, Math.ceil(fileCount * FILE_COVERAGE_RATIO)),
    FILE_COVERAGE_MAX_NEEDED
  )
}

/** IPC / CompactionRecord cap — preload drops events that exceed this. */
export const MAX_VERIFY_FAILURES = 16

/** Clip verify failure lines so AgentEvent + compaction.json stay schema-valid. */
export function clipVerifyFailures(lines: readonly string[]): string[] {
  return lines.slice(0, MAX_VERIFY_FAILURES)
}

const PATH_TOKEN_RE =
  /(?:^|[\s`"'([<])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w.-]*|[\w.-]+\.[A-Za-z][\w.-]{1,12})/g
const BACKTICK_RE = /`([^`]+)`/g
/** `src/core/llm/{provider,openai,fakellm}.ts` from the d7dcdfbf Files Touched card. */
const BRACE_PATH_RE = /(?:[\w.-]+\/)*[\w.-]*\{[^{}]+\}[\w./\\-]*\.[A-Za-z][\w.-]*/g

function normalizePath(value: string): string {
  return normalizeWorkspaceRelPath(value).replace(/^\.\//, '').toLowerCase()
}

function basename(path: string): string {
  const norm = normalizeWorkspaceRelPath(path)
  const slash = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return slash >= 0 ? norm.slice(slash + 1) : norm
}

/** Expand one `{a,b}` segment (nested braces recurse). */
export function expandBraceGlobs(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  const start = trimmed.indexOf('{')
  const end = start >= 0 ? trimmed.indexOf('}', start + 1) : -1
  if (start < 0 || end < 0) return [trimmed]
  const pre = trimmed.slice(0, start)
  const inner = trimmed.slice(start + 1, end)
  const post = trimmed.slice(end + 1)
  const alts = inner.split(',').map((part) => part.trim()).filter(Boolean)
  if (alts.length === 0) return expandBraceGlobs(`${pre}${post}`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const alt of alts) {
    for (const expanded of expandBraceGlobs(`${pre}${alt}${post}`)) {
      if (seen.has(expanded)) continue
      seen.add(expanded)
      out.push(expanded)
    }
  }
  return out
}

function bracePathsInText(text: string): string[] {
  const out: string[] = []
  BRACE_PATH_RE.lastIndex = 0
  for (const match of text.matchAll(BRACE_PATH_RE)) {
    out.push(...expandBraceGlobs(match[0] ?? ''))
  }
  return out
}

/** True when `text` cites `path` (full, suffix, distinctive basename, or brace glob). */
export function pathMentionedInText(path: string, text: string): boolean {
  const hay = text.toLowerCase().replace(/\\/g, '/')
  const needle = normalizePath(path)
  if (!needle) return false
  if (hay.includes(needle)) return true
  const base = basename(path).toLowerCase()
  if (base.length >= 5 && base.includes('.')) {
    const bounded = new RegExp(
      `(^|[^\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w.-]|$)`,
      'i'
    )
    if (bounded.test(text)) return true
  }
  for (const expanded of bracePathsInText(text)) {
    if (normalizePath(expanded) === needle) return true
  }
  return false
}

/** Every `## Heading` block — rolling merges concatenate prior + new Files Touched. */
function collectSectionBullets(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, 'i')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i]!.trim())) continue
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!.trim()
      if (/^##\s+/.test(line)) break
      const bullet = line.match(/^[-*]\s+(.+)$/)
      if (bullet?.[1] && bullet[1] !== '(none)') out.push(bullet[1].trim())
    }
  }
  return out
}

function pushUniquePath(into: string[], raw: string): void {
  const cleaned = raw.replace(/^[*_`]+|[*_`]+$/g, '').trim()
  for (const piece of expandBraceGlobs(cleaned)) {
    const path = normalizeWorkspaceRelPath(piece)
    if (!isPlausibleWorkspaceFilePath(path)) continue
    const key = normalizePath(path)
    if (into.some((existing) => normalizePath(existing) === key)) continue
    into.push(path)
  }
}

/** Path tokens inside one Files Touched bullet — never the whole annotated line. */
function extractPathsFromFilesTouchedBullet(bullet: string, into: string[]): void {
  const before = into.length
  for (const match of bullet.matchAll(BACKTICK_RE)) {
    pushUniquePath(into, match[1] ?? '')
  }
  PATH_TOKEN_RE.lastIndex = 0
  let token: RegExpExecArray | null
  while ((token = PATH_TOKEN_RE.exec(bullet))) {
    pushUniquePath(into, token[1] ?? '')
  }
  if (into.length === before) {
    const stripped = bullet.replace(/^[*_`]+|[*_`]+$/g, '').trim()
    if (stripped && !/\s/.test(stripped)) pushUniquePath(into, stripped)
  }
}

/**
 * Path-like claims for invented_path. Only Files Touched is the claim list —
 * Next Steps / Open Bugs backticks (e.g. `src/core/llm/`) are guidance, not claims.
 */
export function extractClaimedPaths(summary: string): string[] {
  const claimed: string[] = []
  for (const bullet of collectSectionBullets(summary, 'Files Touched')) {
    extractPathsFromFilesTouchedBullet(bullet, claimed)
  }
  return claimed
}

/** Fold markdown/punctuation so `core?:` matches `core**:` and `-` matches U+2014. */
function foldDecisionText(value: string): string {
  return value
    .replace(/[*_`#]/g, '')
    .replace(/\?/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Prompt side of `formatQuestionAnswers` (`${prompt}: ${answer}`).
 * Summarizers often keep the prompt and restate a "Not sure — recommend one"
 * answer as the recommendation; requiring the original answer then false-fails.
 */
function askQuestionPromptNeedle(decision: string): string | null {
  const qIdx = decision.lastIndexOf('?:')
  const cIdx = decision.lastIndexOf(': ')
  const idx = qIdx >= 12 ? qIdx : cIdx
  if (idx < 12) return null
  const prompt = foldDecisionText(decision.slice(0, idx).replace(/^[-*]\s+/, ''))
  return prompt.length >= 12 ? prompt : null
}

function decisionMentioned(decision: string, summary: string): boolean {
  const needle = foldDecisionText(decision)
  if (!needle) return true
  const hay = foldDecisionText(summary)
  const hayLower = hay.toLowerCase()
  const needleLower = needle.toLowerCase()
  if (hayLower.includes(needleLower)) return true
  const clip = needle.length > 48 ? needle.slice(0, 48).trim() : needle
  if (hayLower.includes(clip.toLowerCase())) return true
  const stripped = needle.replace(/^[-*]\s+/, '')
  if (stripped !== needle && hayLower.includes(stripped.toLowerCase())) return true
  const prompt = askQuestionPromptNeedle(decision)
  return prompt != null && hayLower.includes(prompt.toLowerCase())
}

function factInFoldedText(path: string, foldedText: string): boolean {
  if (!foldedText) return false
  return pathMentionedInText(path, foldedText)
}

export function formatCompactionVerifyFailure(failure: CompactionVerifyFailure): string {
  switch (failure.kind) {
    case 'invented_path':
      return `Invented path: ${failure.detail}`
    case 'missing_decision':
      return `Missing decision: ${failure.detail}`
    case 'missing_wrote_file':
      return `Missing written file: ${failure.detail}`
    case 'missing_contract_goal':
      return `Missing contract goal: ${failure.detail}`
    case 'low_file_coverage':
      return `Low file coverage: ${failure.detail}`
    default: {
      const _exhaustive: never = failure.kind
      return _exhaustive
    }
  }
}

/**
 * Score a compaction summary against extractive fold facts.
 * `foldedText` is the raw folded prefix (for “claimed path appeared in source”).
 */
export function verifyCompactionSummary(
  summary: string,
  facts: FoldFacts,
  foldedText = ''
): CompactionVerifyResult {
  const failures: CompactionVerifyFailure[] = []
  const claimed = extractClaimedPaths(summary)
  const mentionedFiles: string[] = []

  for (const claim of claimed) {
    const known =
      facts.files.some((file) => normalizePath(file) === normalizePath(claim)) ||
      facts.wroteFiles.some((file) => normalizePath(file) === normalizePath(claim)) ||
      factInFoldedText(claim, foldedText)
    if (!known) {
      failures.push({ kind: 'invented_path', detail: claim })
    }
  }

  for (const decision of facts.decisions) {
    if (!decisionMentioned(decision, summary)) {
      failures.push({ kind: 'missing_decision', detail: decision })
    }
  }

  for (const path of facts.wroteFiles) {
    if (!pathMentionedInText(path, summary)) {
      failures.push({ kind: 'missing_wrote_file', detail: path })
    }
  }

  if (facts.contractGoal && !decisionMentioned(facts.contractGoal, summary)) {
    failures.push({ kind: 'missing_contract_goal', detail: facts.contractGoal })
  }

  for (const file of facts.files) {
    if (pathMentionedInText(file, summary)) mentionedFiles.push(file)
  }

  const coverage =
    facts.files.length === 0 ? 1 : mentionedFiles.length / facts.files.length

  // Writes are fail-closed at 100% via missing_wrote_file. Scoring 50% of every
  // inspect/prose path discards summaries that name the files that actually changed.
  if (facts.wroteFiles.length === 0 && facts.files.length >= 2) {
    const needed = coverageNeeded(facts.files.length)
    if (mentionedFiles.length < needed) {
      failures.push({
        kind: 'low_file_coverage',
        detail: `${mentionedFiles.length}/${facts.files.length} files cited (need ${needed})`
      })
    }
  }

  return {
    ok: failures.length === 0,
    coverage,
    failures,
    mentionedFiles
  }
}

/** First-pass facts the summarizer must preserve. Not capped by operator-focus. */
export function requiredFoldFactsFocus(facts: FoldFacts): string {
  const parts: string[] = []
  if (facts.contractGoal) {
    parts.push(`Preserve this contract goal in Session Intent:\n- ${facts.contractGoal}`)
  }
  if (facts.todos.length > 0) {
    parts.push(`Open todos to mention:\n${facts.todos.map((todo) => `- ${todo}`).join('\n')}`)
  }
  if (facts.doneWhen.length > 0) {
    parts.push(`Contract done-when:\n${facts.doneWhen.map((line) => `- ${line}`).join('\n')}`)
  }
  if (facts.wroteFiles.length > 0) {
    parts.push(
      `Written files that must appear in Files Touched:\n${facts.wroteFiles.map((path) => `- ${path}`).join('\n')}`
    )
  }
  if (facts.files.length > 0) {
    parts.push(
      `Files from this history (cite the ones you touched):\n${facts.files
        .slice(0, 24)
        .map((path) => `- ${path}`)
        .join('\n')}`
    )
  }
  return parts.join('\n\n')
}

/** Operator focus that tells the summarizer which facts to restore on retry. */
export function missingFactsFocus(result: CompactionVerifyResult, facts: FoldFacts): string {
  const lines: string[] = [
    'Previous summary failed verification. Include these facts verbatim; do not invent files or decisions:'
  ]
  for (const failure of result.failures) {
    lines.push(`- ${formatCompactionVerifyFailure(failure)}`)
  }
  if (facts.decisions.length > 0) {
    lines.push('Required decisions:')
    for (const decision of facts.decisions) lines.push(`- ${decision}`)
  }
  const required = requiredFoldFactsFocus(facts)
  if (required) lines.push(required)
  return lines.join('\n')
}
