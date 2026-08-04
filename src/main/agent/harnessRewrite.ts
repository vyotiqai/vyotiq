import type { LlmProvider } from './providers/types'
import { logger } from '../../shared/logger'
import type { WeaknessSummary } from './harnessReview'

const REWRITE_SYSTEM = `You rewrite Agent V's system harness markdown (resources/harness/default.md).

Rules:
- Output ONLY the full rewritten markdown body (no fences, no preamble).
- Keep the harness small and behavior-centric.
- Address the receipt weaknesses / evidence buckets in Work style, Tool policy, or similar sections.
- Do not remove human-gated apply / vitest gate language if present.
- Do not instruct disabling HARNESS_EVAL_TESTS, vitest, or harness-apply validation.
- Prefer narrow edits over rewriting unrelated sections.`

/** One-shot LLM rewrite of proposed harness body. Falls back to empty on error. */
export async function rewriteHarnessProposalBody(input: {
  currentHarness: string
  summary: WeaknessSummary
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal?: AbortSignal
}): Promise<{ body: string; usedLlm: boolean; error?: string }> {
  const signal = input.signal ?? new AbortController().signal
  const bucketLines = input.summary.evidenceBuckets.flatMap((b) => [
    `### ${b.component}`,
    ...b.evidence.map((e) => `- ${e}`)
  ])
  const user = [
    '## Current harness',
    '',
    input.currentHarness.trim(),
    '',
    '## Weakness bullets',
    '',
    ...input.summary.bullets.map((b) => `- ${b}`),
    '',
    '## Evidence buckets',
    '',
    ...(bucketLines.length ? bucketLines : ['- (none)']),
    '',
    '## Suggested focus',
    '',
    ...input.summary.suggestions,
    '',
    'Rewrite the full harness markdown now.'
  ].join('\n')

  try {
    let body = ''
    for await (const chunk of input.provider.streamChat({
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal,
      tools: [],
      system: REWRITE_SYSTEM,
      messages: [{ role: 'user', content: user }],
      thinking: { enabled: false }
    })) {
      if (signal.aborted) {
        return { body: '', usedLlm: false, error: 'aborted' }
      }
      if (chunk.type === 'text' && chunk.text) body += chunk.text
      if (chunk.type === 'error') {
        logger.warn('Harness proposal rewriter stream error', {
          scope: 'harness',
          code: 'HARNESS_REWRITE'
        })
        return { body: '', usedLlm: false, error: 'stream_error' }
      }
    }
    let trimmed = body.trim()
    if (trimmed.startsWith('```')) {
      trimmed = trimmed.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim()
    }
    if (!trimmed) return { body: '', usedLlm: false, error: 'empty' }
    return { body: trimmed, usedLlm: true }
  } catch (err) {
    logger.warn('Harness proposal rewriter failed', {
      scope: 'harness',
      code: 'HARNESS_REWRITE',
      err
    })
    return {
      body: '',
      usedLlm: false,
      error: err instanceof Error ? err.message : 'rewrite_failed'
    }
  }
}
