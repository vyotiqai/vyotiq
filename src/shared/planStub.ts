/** Shared Plan-mode `plan.md` outline — headings, prompts, and stub chrome. */

export const PLAN_STUB_HINT =
  'Draft the plan here. Update as you learn. Do not edit product source in Plan mode.'

/** Substring used to detect an unfilled Plan-mode stub. */
export const PLAN_STUB_MARKER = 'Draft the plan here.'

export const PLAN_SECTIONS = [
  { heading: 'Goal', prompt: 'What result do you want?' },
  { heading: 'Success criteria', prompt: 'How will we know it worked?' },
  { heading: 'Scope', prompt: 'What is included and excluded?' },
  { heading: 'Open questions', prompt: 'What needs your decision?' },
  { heading: 'Approach', prompt: 'What direction will be taken and why?' },
  { heading: 'Ordered steps', prompt: 'Small, understandable phases.' },
  { heading: 'Verification', prompt: 'How the finished work will be checked.' },
  { heading: 'Risks or trade-offs', prompt: 'Anything that could affect the outcome.' }
] as const

const STUB_HINT_RE =
  /^\s*_{0,2}\s*Draft the plan here(?:\. Update as you learn(?:\. Do not edit product source in Plan mode)?)?\.?\s*_{0,2}\s*$/i

const PROMPT_NORMALIZED = new Set(
  PLAN_SECTIONS.map((section) => normalizePromptText(section.prompt))
)

export const DEFAULT_PLAN_STUB = [
  '# Plan',
  '',
  `_${PLAN_STUB_HINT}_`,
  '',
  ...PLAN_SECTIONS.flatMap(({ heading, prompt }) => [`## ${heading}`, '', `_${prompt}_`, ''])
].join('\n')

function unwrapEmphasis(line: string): string {
  return line
    .trim()
    .replace(/^_{1,2}/, '')
    .replace(/_{1,2}$/, '')
    .replace(/^\*{1,2}/, '')
    .replace(/\*{1,2}$/, '')
    .trim()
}

function normalizePromptText(text: string): string {
  return unwrapEmphasis(text)
    .toLowerCase()
    .replace(/[.?!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isPlanTitleLine(line: string): boolean {
  return /^#\s*Plan\s*$/i.test(line.trim())
}

export function isPlanStubHintLine(line: string): boolean {
  return STUB_HINT_RE.test(line.trim())
}

export function isPlanHeadingLine(line: string): boolean {
  return /^#{1,6}(\s|$)/.test(line.trim())
}

export function isPlanSectionPromptLine(line: string): boolean {
  const normalized = normalizePromptText(line)
  return normalized.length > 0 && PROMPT_NORMALIZED.has(normalized)
}

/** Heading key for readiness: `Goal — …` → `goal`; `Done when` stays distinct. */
export function planSectionKey(headingText: string): string {
  return headingText
    .replace(/\s*[—–]\s+.*$/, '')
    .replace(/\s+-\s+.*$/, '')
    .trim()
    .toLowerCase()
}

export function isPlanStubChromeLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  if (isPlanTitleLine(trimmed)) return true
  if (isPlanStubHintLine(trimmed)) return true
  if (isPlanHeadingLine(trimmed)) return true
  if (isPlanSectionPromptLine(trimmed)) return true
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return true
  if (/^`{3,}/.test(trimmed)) return true
  return false
}

/** Body remaining after stub headings, hints, and section prompts. */
export function stripPlanStubChrome(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isPlanStubChromeLine(line))
    .join('\n')
    .trim()
}
