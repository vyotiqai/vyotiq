import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import type { AgentQuestionAnswer } from '@shared/ipc'

const getSettings = vi.hoisted(() =>
  vi.fn(() => ({ ...DEFAULT_SETTINGS, autoModeSwitch: true }))
)

vi.mock('@main/settings/settings', () => ({
  getSettings: () => getSettings()
}))

import { executeTool } from '@main/agent/tools'

describe('ask_question tool', () => {
  beforeEach(() => {
    getSettings.mockReset()
    getSettings.mockReturnValue({ ...DEFAULT_SETTINGS, autoModeSwitch: true })
  })

  it('fails without a question sender', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Continue?' }),
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/none is listening/i)
  })

  it('returns summarized answers from a mock ask (legacy args)', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Pick one', options: ['A', 'B'] }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async () => [{ questionId: 'q1', values: ['A'] }]
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe('User answered: A')
  })

  it('formats multi-question answers with prompts', async () => {
    const captured: AgentQuestionAnswer[] = []
    const result = await executeTool(
      'ask_question',
      JSON.stringify({
        title: 'Setup',
        questions: [
          { id: 'mode', prompt: 'Mode?', type: 'single', options: ['Ask', 'Agent'] },
          { id: 'go', prompt: 'Continue?', type: 'boolean' }
        ]
      }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async (_req) => {
          const answers = [
            { questionId: 'mode', values: ['Ask'] },
            { questionId: 'go', values: ['Yes'] }
          ]
          captured.push(...answers)
          return answers
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('Setup')
    expect(result.content).toBe('User answered:\n- Mode?: Ask\n- Continue?: Yes')
    expect(captured).toHaveLength(2)
  })

  it('rejects single/multi without enough options', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({
        questions: [{ id: 'q1', prompt: 'Only one?', type: 'single', options: ['A'] }]
      }),
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/at least 2/i)
  })
})
