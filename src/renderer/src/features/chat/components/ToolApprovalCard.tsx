import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { QUESTION_GATE_BODY, QUESTION_GATE_FOOTER, QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE } from '@renderer/lib/utils/layout'
import type { UiToolApproval } from '@shared/transcript'
import type { ToolApprovalDecision } from '@shared/ipc'
import { toolLabel } from '../toolUi/meta'

const CHOICES: { decision: ToolApprovalDecision; label: string; primary?: boolean }[] = [
  { decision: 'once', label: 'Allow once', primary: true },
  { decision: 'session', label: 'Allow for session' },
  { decision: 'always', label: 'Always allow' }
]

export const ToolApprovalCard = memo(function ToolApprovalCard({
  approval,
  onDecide
}: {
  approval: UiToolApproval
  onDecide?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
}) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'done'>('idle')
  const [pendingDecision, setPendingDecision] = useState<ToolApprovalDecision | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const decide = (decision: ToolApprovalDecision): void => {
    if (phase !== 'idle' || !onDecide) return
    setPhase('pending')
    setPendingDecision(decision)
    setLocalError(null)
    void Promise.resolve(onDecide(approval.requestId, decision))
      .then(() => {
        if (!mountedRef.current) return
        // Stay locked; parent usually removes the card on success.
        setPhase('done')
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setPhase('idle')
        setPendingDecision(null)
        setLocalError(err instanceof Error ? err.message : 'Could not send decision')
      })
  }

  const busy = phase !== 'idle'
  const canDecide = Boolean(onDecide) && !busy
  const label = toolLabel(approval.toolName, 'running')

  return (
    <div
      className={cn(QUESTION_GATE_SURFACE, 'w-full')}
      role="group"
      aria-busy={phase === 'pending' ? true : undefined}
    >
      <div className={cn(QUESTION_GATE_HEADER, 'text-fg')}>
        <Icon name="warning" size={14} className="shrink-0 text-danger" />
        <span className="font-medium">
          Allow tool:{' '}
          <span title={approval.toolName}>{label}</span>?
        </span>
        <span className="min-w-0 truncate text-tertiary" title={approval.summary}>
          {approval.summary}
        </span>
        <span className="ml-auto shrink-0 text-tertiary">
          {approval.mutating ? 'mutating / network' : 'read-only'}
        </span>
      </div>
      {approval.argsPreview ? (
        <pre className={cn(QUESTION_GATE_BODY, 'max-h-40 overflow-auto text-xs text-secondary')}>
          {approval.argsPreview}
        </pre>
      ) : null}
      {localError ? (
        <p className="border-t border-border/40 px-3 py-2 text-xs text-danger" role="alert">
          {localError}
        </p>
      ) : null}
      <div className={cn(QUESTION_GATE_FOOTER, 'flex-wrap border-t border-border/40')}>
        {CHOICES.map((choice) => (
          <button
            key={choice.decision}
            type="button"
            disabled={!canDecide}
            className={cn(
              'rounded-md border px-2 py-1 text-xs vy-transition disabled:opacity-[var(--vy-disabled-opacity)]',
              choice.primary
                ? 'border-accent bg-accent text-accent-fg hover:opacity-90'
                : 'border-border text-fg hover:bg-surface'
            )}
            onClick={() => decide(choice.decision)}
          >
            {pendingDecision === choice.decision && phase === 'pending' ? 'Sending…' : choice.label}
          </button>
        ))}
        <button
          type="button"
          disabled={!canDecide}
          className="ml-auto rounded-md border border-border px-2 py-1 text-xs text-danger vy-transition hover:bg-surface disabled:opacity-[var(--vy-disabled-opacity)]"
          onClick={() => decide('deny')}
        >
          {pendingDecision === 'deny' && phase === 'pending' ? 'Sending…' : 'Deny'}
        </button>
      </div>
    </div>
  )
})
