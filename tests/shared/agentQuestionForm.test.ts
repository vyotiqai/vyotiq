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

  it('accepts question as alias for prompt on typed items', () => {
    const result = normalizeAskQuestionArgs({
      questions: [
        {
          id: 'scope',
          question: 'Should I only review, revise, or prepare for /harness?',
          type: 'single',
          options: ['Review only', 'Revise proposal', 'Prepare for /harness']
        }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe(
      'Should I only review, revise, or prepare for /harness?'
    )
  })

  it('prefers prompt when both question and prompt are set', () => {
    const result = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Canonical', question: 'Alias', type: 'boolean' }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe('Canonical')
  })

  it('parses stringified questions JSON array', () => {
    const result = normalizeAskQuestionArgs({
      questions: JSON.stringify([{ id: 'q1', prompt: 'Ready?', type: 'boolean' }])
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.type).toBe('boolean')
  })

  it('salvages an unclosed stringified questions array (live 0898dc11)', () => {
    const items = [
      {
        id: 'purpose',
        prompt: 'What task or workflow should this skill handle?',
        type: 'text'
      },
      {
        id: 'placement',
        prompt: 'Where should the skill live?',
        type: 'single',
        options: [
          'Personal (~/.vyotiq/skills/<name> — reusable across your projects)',
          'Project (./.vyotiq/skills/<name> — this deamon project only)',
          'Marketplace (bundled in Vyotiq source — ships to all users)',
          'Recommend the best fit'
        ]
      }
    ]
    const result = normalizeAskQuestionArgs({
      title: 'New skill — what should it do?',
      questions: JSON.stringify(items).slice(0, -1)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.title).toBe('New skill — what should it do?')
    expect(result.form.questions.map((q) => q.id)).toEqual(['purpose', 'placement'])
    expect(result.form.questions[1]!.options).toHaveLength(4)
  })

  it('wraps a single question object and parses stringified options', () => {
    const asObject = normalizeAskQuestionArgs({
      questions: { id: 'q1', prompt: 'Ready?', type: 'boolean' }
    })
    expect(asObject.ok).toBe(true)
    if (!asObject.ok) return
    expect(asObject.form.questions).toHaveLength(1)
    expect(asObject.form.questions[0]!.prompt).toBe('Ready?')

    const stringOptions = normalizeAskQuestionArgs({
      questions: [
        {
          id: 'placement',
          prompt: 'Where?',
          type: 'single',
          options: JSON.stringify(['Personal', 'Project', 'Marketplace', 'Recommend'])
        }
      ]
    })
    expect(stringOptions.ok).toBe(true)
    if (!stringOptions.ok) return
    expect(stringOptions.form.questions[0]!.options).toEqual([
      'Personal',
      'Project',
      'Marketplace',
      'Recommend'
    ])
  })

  it('unwraps a double-encoded questions array', () => {
    const items = [{ id: 'q1', prompt: 'Ready?', type: 'text' }]
    const result = normalizeAskQuestionArgs({
      questions: JSON.stringify(JSON.stringify(items))
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe('Ready?')
  })

  it('rejects malformed stringified questions array', () => {
    const malformed =
      '[{"id": "how_open", "prompt": "How?", "type": "single", "options": ["A VS Code "Live Server" or similar", "Other"]}]'
    const result = normalizeAskQuestionArgs({ questions: malformed })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/JSON array/i)
  })

  it('accepts top-level prompt as alias for legacy question', () => {
    const result = normalizeAskQuestionArgs({ prompt: 'Ship it?' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe('Ship it?')
    expect(result.form.questions[0]!.type).toBe('text')
  })

  it('enriches missing question/questions with an example payload', () => {
    const result = normalizeAskQuestionArgs({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/question or questions is required/i)
    expect(result.error).toMatch(/type: "boolean"/i)
  })

  it('rejects empty questions array with a distinct error', () => {
    const result = normalizeAskQuestionArgs({ questions: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/at least 1 item/i)
    expect(result.error).toMatch(/Pass questions:/i)
  })

  it('rejects missing type and missing prompt on typed items', () => {
    const noType = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Go?' }]
    })
    expect(noType.ok).toBe(false)
    if (noType.ok) return
    expect(noType.error).toMatch(/type must be single, multi, boolean, or text/i)

    const noPrompt = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', type: 'boolean' }]
    })
    expect(noPrompt.ok).toBe(false)
    if (noPrompt.ok) return
    expect(noPrompt.error).toMatch(/prompt is required/i)
  })

  it('rejects duplicate ids', () => {
    const result = normalizeAskQuestionArgs({
      questions: [
        { id: 'same', prompt: 'A?', type: 'boolean' },
        { id: 'same', prompt: 'B?', type: 'text' }
      ]
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/duplicate question id/i)
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
