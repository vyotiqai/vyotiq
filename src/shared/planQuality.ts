import {
  DEFAULT_PLAN_STUB,
  isPlanSectionPromptLine,
  isPlanStubHintLine,
  planSectionKey
} from './planStub'

/** Minimum cleaned body line length to count as drafted content. */
export const PLAN_BODY_MIN_CHARS = 8

const DONE_WHEN_KEYS = new Set([
  'done when',
  'success criteria',
  'verification',
  'acceptance criteria'
])

function isHorizontalRule(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())
}

function isFenceOnly(line: string): boolean {
  return /^`{3,}/.test(line.trim())
}

function stripMarkdownChrome(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^_{1,2}|_{1,2}$/g, '')
    .replace(/^[-*+]\s*\[[ xX]\]\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim()
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}(\s|$)/.test(line.trim())
}

/** Substantive plan body lines for readiness checks. */
export function planDraftBodyLines(content: string): string[] {
  const out: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (isHeadingLine(line)) continue
    if (isHorizontalRule(line)) continue
    if (isFenceOnly(line)) continue
    if (isPlanStubHintLine(line) || isPlanSectionPromptLine(line)) continue
    const cleaned = stripMarkdownChrome(line)
    if (cleaned.length < PLAN_BODY_MIN_CHARS) continue
    out.push(cleaned)
  }
  return out
}

function parseH2Bodies(markdown: string): Map<string, string> {
  const buckets = new Map<string, string[]>()
  let current: string | null = null
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^#{2,3}\s+(.+?)\s*$/)
    if (heading?.[1]) {
      current = planSectionKey(heading[1])
      if (!buckets.has(current)) buckets.set(current, [])
      continue
    }
    if (current) buckets.get(current)!.push(raw)
  }
  const out = new Map<string, string>()
  for (const [key, lines] of buckets) out.set(key, lines.join('\n'))
  return out
}

/** Body of Done when / Success criteria, if drafted. */
export function extractDoneWhenBody(markdown: string): string {
  const bodies = parseH2Bodies(markdown)
  for (const key of DONE_WHEN_KEYS) {
    const body = bodies.get(key)
    if (body && planDraftBodyLines(body).length > 0) return body.trim()
  }
  return ''
}

const LEGACY_PLAN_STUB = [
  '# Plan',
  '',
  '_Draft the plan here. Update as you learn. Do not edit product source in Plan mode._',
  ''
].join('\n')

/**
 * Ready for Continue-in-Agent: real drafted body, not the empty stub.
 */
export function isPlanDraftReady(content: string | null | undefined): boolean {
  if (!content) return false
  const trimmed = content.trim()
  if (!trimmed) return false
  if (trimmed === LEGACY_PLAN_STUB.trim()) return false
  if (trimmed === DEFAULT_PLAN_STUB.trim()) return false
  return planDraftBodyLines(trimmed).length > 0
}

/** Minimal `plan.md` that satisfies Continue-in-Agent readiness. */
export function minimalReadyPlanMarkdown(): string {
  return [
    '# Ship the planner',
    '',
    '## Goal',
    '',
    'Publish a clear run plan through create_plan.',
    '',
    '## Steps',
    '',
    '1. Explore the workspace, then write plan.md.',
    '',
    '## Done when',
    '',
    'plan.md has a goal, steps, and a check for finished work.'
  ].join('\n')
}
