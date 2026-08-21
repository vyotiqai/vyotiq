import {
  DEFAULT_PLAN_STUB,
  isPlanHeadingLine,
  isPlanSectionPromptLine,
  isPlanStubHintLine,
  isPlanTitleLine,
  planSectionKey
} from '@shared/planStub'

/**
 * Minimal legacy stub shape. Real Plan-mode stubs (`DEFAULT_PLAN_STUB`)
 * are richer — readiness requires drafted Goal, Success criteria (or Done when),
 * Approach, and Ordered steps, not any short body line.
 */

export const PLAN_STUB = [
  '# Plan',
  '',
  '_Draft the plan here. Update as you learn. Do not edit product source in Plan mode._',
  ''
].join('\n')

/** Minimum cleaned body line length to count as drafted content. */
export const PLAN_BODY_MIN_CHARS = 8

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

/** Substantive plan body lines for readiness checks. */
export function planDraftBodyLines(content: string): string[] {
  const out: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (isPlanTitleLine(line)) continue
    if (isPlanStubHintLine(line)) continue
    if (isPlanHeadingLine(line)) continue
    if (isPlanSectionPromptLine(line)) continue
    if (isHorizontalRule(line)) continue
    if (isFenceOnly(line)) continue
    const cleaned = stripMarkdownChrome(line)
    if (cleaned.length < PLAN_BODY_MIN_CHARS) continue
    out.push(cleaned)
  }
  return out
}

const GOAL_KEYS = new Set(['goal'])
const SUCCESS_KEYS = new Set(['success criteria', 'done when'])
const APPROACH_KEYS = new Set(['approach'])
const STEPS_KEYS = new Set(['ordered steps'])

function parseH2Bodies(markdown: string): Map<string, string> {
  const buckets = new Map<string, string[]>()
  let current: string | null = null
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^##\s+(.+?)\s*$/)
    if (heading?.[1]) {
      current = planSectionKey(heading[1])
      if (!buckets.has(current)) buckets.set(current, [])
      continue
    }
    if (current) buckets.get(current)!.push(raw)
  }
  const out = new Map<string, string>()
  for (const [key, lines] of buckets) {
    out.set(key, lines.join('\n'))
  }
  return out
}

function hasDraftedSection(bodies: Map<string, string>, keys: Set<string>): boolean {
  for (const key of keys) {
    const body = bodies.get(key)
    if (body && planDraftBodyLines(body).length > 0) return true
  }
  return false
}

/** Minimal `plan.md` that satisfies Continue-in-Agent readiness. */
export function minimalReadyPlanMarkdown(): string {
  return [
    '# Plan',
    '',
    '## Goal',
    '',
    'Ship the structured planner.',
    '',
    '## Success criteria',
    '',
    'Required sections are filled and Continue in Agent is enabled.',
    '',
    '## Approach',
    '',
    'Seed headings, prompt the model, and gate Continue on those sections.',
    '',
    '## Ordered steps',
    '',
    '1. Fill Goal, Success criteria, Approach, and Ordered steps.',
    ''
  ].join('\n')
}

export function isPlanDraftReady(content: string | null | undefined): boolean {
  if (!content) return false
  const trimmed = content.trim()
  if (!trimmed) return false
  if (trimmed === PLAN_STUB.trim()) return false
  if (trimmed === DEFAULT_PLAN_STUB.trim()) return false
  const bodies = parseH2Bodies(trimmed)
  return (
    hasDraftedSection(bodies, GOAL_KEYS) &&
    hasDraftedSection(bodies, SUCCESS_KEYS) &&
    hasDraftedSection(bodies, APPROACH_KEYS) &&
    hasDraftedSection(bodies, STEPS_KEYS)
  )
}
