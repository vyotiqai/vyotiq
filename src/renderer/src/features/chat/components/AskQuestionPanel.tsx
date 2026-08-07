import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { cn, MarkdownContent } from '@renderer/lib/ui'
import {
  QUESTION_GATE_BODY,
  QUESTION_GATE_FOOTER,
  QUESTION_GATE_HEADER,
  QUESTION_GATE_SURFACE
} from '@renderer/lib/utils/layout'
import { questionTypeHint } from '@shared/utils/agentQuestionForm'
import type { UiAgentQuestion, UiAgentQuestionAnswer } from '@shared/transcript'
import { QuestionField } from './askQuestion/QuestionFields'

type FieldState = { values: string[]; customText: string }

function emptyFields(question: UiAgentQuestion): Record<string, FieldState> {
  const out: Record<string, FieldState> = {}
  for (const item of question.questions) {
    out[item.id] = { values: [], customText: '' }
  }
  return out
}

function fieldIsAnswered(item: UiAgentQuestion['questions'][number], state: FieldState): boolean {
  const values = state.values.map((v) => v.trim()).filter(Boolean)
  if (item.type === 'multi') return values.length > 0
  if (item.type === 'text') return values.length === 1 && values[0]!.length > 0
  return values.length === 1
}

function collectAnswers(
  question: UiAgentQuestion,
  fields: Record<string, FieldState>
): UiAgentQuestionAnswer[] {
  return question.questions.map((item) => {
    const state = fields[item.id] ?? { values: [], customText: '' }
    const values = state.values.map((v) => v.trim()).filter(Boolean)
    return { questionId: item.id, values }
  })
}

/** Single-question forms with fixed choices submit on selection — no extra click. */
function isQuickSubmitForm(question: UiAgentQuestion): boolean {
  if (question.questions.length !== 1) return false
  const item = question.questions[0]!
  if (item.type === 'boolean') return true
  return item.type === 'single' && item.allowCustom !== true
}

export const AskQuestionPanel = memo(function AskQuestionPanel({
  question,
  onSubmit
}: {
  question: UiAgentQuestion
  onSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
}) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'answered' | 'skipped'>('idle')
  const [localError, setLocalError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, FieldState>>(() => emptyFields(question))
  const rootRef = useRef<HTMLFormElement | null>(null)

  // Same requestId can be replaced in place with new prompts/options; remount does not run.
  const questionShapeKey = useMemo(
    () =>
      [
        question.requestId,
        question.title ?? '',
        ...question.questions.map(
          (item) =>
            `${item.id}\u0000${item.prompt}\u0000${item.type}\u0000${item.allowCustom ? 1 : 0}\u0000${(item.options ?? []).join('\u001f')}`
        )
      ].join('\n'),
    [question]
  )

  useEffect(() => {
    setFields(emptyFields(question))
    setPhase('idle')
    setLocalError(null)
    // Move focus into the form so keyboard and screen-reader users land on the
    // first control instead of wherever the transcript had it.
    const root = rootRef.current
    const first = root?.querySelector<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled])'
    )
    first?.focus()
    // Only when shape changes — same requestId with a new object must not wipe in-progress answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by questionShapeKey
  }, [questionShapeKey])

  const multi = question.questions.length > 1
  const headerTitle = question.title?.trim() || (multi ? 'Questions' : 'Question')
  const singleHint =
    !multi && question.questions[0] ? questionTypeHint(question.questions[0].type) : null

  const allAnswered = useMemo(
    () =>
      question.questions.every((item) =>
        fieldIsAnswered(item, fields[item.id] ?? { values: [], customText: '' })
      ),
    [fields, question.questions]
  )

  const submitAnswers = (
    answers: UiAgentQuestionAnswer[],
    outcome: 'answered' | 'skipped'
  ): void => {
    if (phase !== 'idle' || !onSubmit) return
    setPhase('pending')
    setLocalError(null)
    void Promise.resolve(onSubmit(question.requestId, answers))
      .then(() => {
        setPhase(outcome)
      })
      .catch((err: unknown) => {
        setPhase('idle')
        setLocalError(err instanceof Error ? err.message : 'Could not send answer')
      })
  }

  const setField = (id: string, values: string[], customText: string): void => {
    if (phase !== 'idle') return
    setFields((prev) => ({ ...prev, [id]: { values, customText } }))
    if (isQuickSubmitForm(question)) {
      const item = question.questions[0]!
      if (item.id === id && values.length === 1 && values[0]!.trim()) {
        submitAnswers([{ questionId: id, values: [values[0]!.trim()] }], 'answered')
      }
    }
  }

  const submit = (): void => {
    if (phase !== 'idle' || !allAnswered || !onSubmit) return
    submitAnswers(collectAnswers(question, fields), 'answered')
  }

  const skip = (): void => {
    if (phase !== 'idle' || !onSubmit) return
    // Empty answers is the skip/dismiss signal — the tool resumes with
    // "continue with a reasonable default" guidance.
    submitAnswers([], 'skipped')
  }

  const onFormSubmit = (e: FormEvent): void => {
    e.preventDefault()
    submit()
  }

  const busy = phase !== 'idle'
  const canSubmit = Boolean(onSubmit) && allAnswered && !busy
  const canSkip = Boolean(onSubmit) && !busy
  const submitLabel =
    phase === 'pending'
      ? 'Sending…'
      : phase === 'answered'
        ? 'Answered'
        : phase === 'skipped'
          ? 'Skipped'
          : 'Submit answer'

  return (
    <form
      ref={rootRef}
      className={cn(QUESTION_GATE_SURFACE, 'w-full')}
      role="group"
      aria-labelledby={`ask-q-title-${question.requestId}`}
      aria-busy={phase === 'pending' ? true : undefined}
      onSubmit={onFormSubmit}
    >
      <div className={QUESTION_GATE_HEADER}>
        <span
          id={`ask-q-title-${question.requestId}`}
          className="shrink-0 font-medium text-fg"
        >
          {headerTitle}
        </span>
        {singleHint ? (
          <span className="min-w-0 truncate text-tertiary">{singleHint}</span>
        ) : multi ? (
          <span className="min-w-0 truncate text-tertiary">
            {question.questions.length} questions
          </span>
        ) : null}
      </div>

      <div className={cn(QUESTION_GATE_BODY, 'flex flex-col gap-3')}>
        {question.questions.map((item) => {
          const promptId = `ask-q-prompt-${question.requestId}-${item.id}`
          const state = fields[item.id] ?? { values: [], customText: '' }
          return (
            <div key={item.id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <div id={promptId} className="text-sm font-medium text-fg">
                  <MarkdownContent content={item.prompt} />
                </div>
                {multi ? (
                  <span className="text-caption text-tertiary">{questionTypeHint(item.type)}</span>
                ) : null}
              </div>
              <QuestionField
                item={item}
                values={state.values}
                customText={state.customText}
                disabled={busy}
                promptId={promptId}
                selectOnArrow={!isQuickSubmitForm(question)}
                onChange={(values, customText) => setField(item.id, values, customText)}
              />
            </div>
          )
        })}

        {localError ? (
          <p className="text-xs text-danger" role="alert">
            {localError}
          </p>
        ) : null}
      </div>

      <div className={cn(QUESTION_GATE_FOOTER, 'flex items-center gap-2')}>
        <button
          type="submit"
          disabled={!canSubmit}
          aria-busy={phase === 'pending' ? true : undefined}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs vy-transition',
            'disabled:opacity-[var(--vy-disabled-opacity)]',
            canSubmit
              ? 'border-border bg-surface text-fg hover:bg-surface-2'
              : 'border-border text-tertiary'
          )}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          disabled={!canSkip}
          title="Skip — the agent continues with a reasonable default"
          className={cn(
            'rounded-md px-2.5 py-1 text-xs text-tertiary vy-transition',
            'hover:text-fg disabled:opacity-[var(--vy-disabled-opacity)]'
          )}
          onClick={skip}
        >
          Skip
        </button>
      </div>
    </form>
  )
})
