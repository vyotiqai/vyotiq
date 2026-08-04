import { describe, expect, it } from 'vitest'
import {
  formatQuestionAnswers,
  normalizeAskQuestionArgs
} from '@shared/utils/agentQuestionForm'

describe('normalizeAskQuestionArgs', () => {
  it('normalizes legacy question + options to single', () => {
    const result = normalizeAskQuestionArgs({
      question: 'Pick?',
      options: ['A', 'B'],
      allowCustom: false
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions).toEqual([
      {
        id: 'q1',
        prompt: 'Pick?',
        type: 'single',
        options: ['A', 'B'],
        allowCustom: false
      }
    ])
  })

  it('normalizes legacy allowMultiple to multi with allowCustom default true', () => {
    const result = normalizeAskQuestionArgs({
      question: 'Features?',
      options: ['A', 'B'],
      allowMultiple: true
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.type).toBe('multi')
    expect(result.form.questions[0]!.allowCustom).toBe(true)
  })

  it('accepts typed questions array', () => {
    const result = normalizeAskQuestionArgs({
      title: 'Setup',
      questions: [
        { id: 'a', prompt: 'Go?', type: 'boolean' },
        { id: 'b', prompt: 'Notes', type: 'text' }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.title).toBe('Setup')
    expect(result.form.questions).toHaveLength(2)
  })
})

describe('formatQuestionAnswers', () => {
  it('formats a single value', () => {
    expect(
      formatQuestionAnswers(
        { questions: [{ id: 'q1', prompt: 'Pick?', type: 'single', options: ['A', 'B'] }] },
        [{ questionId: 'q1', values: ['A'] }]
      )
    ).toBe('User answered: A')
  })

  it('formats multi-question answers with prompts', () => {
    expect(
      formatQuestionAnswers(
        {
          questions: [
            { id: 'a', prompt: 'Mode?', type: 'single', options: ['Ask', 'Agent'] },
            { id: 'b', prompt: 'Continue?', type: 'boolean' }
          ]
        },
        [
          { questionId: 'a', values: ['Ask'] },
          { questionId: 'b', values: ['Yes'] }
        ]
      )
    ).toBe('User answered:\n- Mode?: Ask\n- Continue?: Yes')
  })
})
