import { describe, expect, it } from 'vitest'
import { rewriteHarnessProposalBody } from '@main/agent/harnessRewrite'
import type { WeaknessSummary } from '@main/agent/harnessReview'
import type { LlmProvider, StreamChunk } from '@main/agent/providers/types'

const summary: WeaknessSummary = {
  receiptCount: 1,
  bullets: ['Mined 1 run receipt(s).'],
  suggestions: ['- Keep small'],
  evidenceBuckets: [{ component: 'loop_notices', evidence: ['Unread paths'] }]
}

describe('harnessRewrite', () => {
  it('returns usedLlm body from stream text', async () => {
    let system = ''
    let user = ''
    const provider: LlmProvider = {
      id: 'ollama',
      async *streamChat(req): AsyncGenerator<StreamChunk> {
        system = req.system ?? ''
        user = String(req.messages[0]?.content ?? '')
        yield { type: 'text', text: '# Agent V\n\n## Work style\n\nread first\n' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const result = await rewriteHarnessProposalBody({
      currentHarness: '# Agent V\n',
      summary,
      provider,
      model: 'test'
    })
    expect(result.usedLlm).toBe(true)
    expect(result.body).toMatch(/read first/)
    expect(system).toMatch(/one owner per instruction/i)
    expect(system).toMatch(/only system_prompt evidence/i)
    expect(system).toMatch(/do not add tool names, arguments, mode capabilities/i)
    expect(user).toMatch(/Only the system_prompt bucket is owned by this harness/i)
  })

  it('strips markdown fences and falls back on empty', async () => {
    const emptyProvider: LlmProvider = {
      id: 'ollama',
      async *streamChat(): AsyncGenerator<StreamChunk> {
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const empty = await rewriteHarnessProposalBody({
      currentHarness: '# Agent V\n',
      summary,
      provider: emptyProvider,
      model: 'test'
    })
    expect(empty.usedLlm).toBe(false)

    const fenced: LlmProvider = {
      id: 'ollama',
      async *streamChat(): AsyncGenerator<StreamChunk> {
        yield { type: 'text', text: '```markdown\n# Agent V\nok\n```' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const result = await rewriteHarnessProposalBody({
      currentHarness: '# Agent V\n',
      summary,
      provider: fenced,
      model: 'test'
    })
    expect(result.usedLlm).toBe(true)
    expect(result.body).toBe('# Agent V\nok')
  })
})
