import { useCallback } from 'react'
import { cn } from '@renderer/lib/ui/cn'
import type { AgentInteractionMode } from '@shared/ipc'
import { chromePillButton } from './composerChrome'

const MODES: { value: AgentInteractionMode; label: string; short: string }[] = [
  { value: 'ask', label: 'Ask', short: 'Ask' },
  { value: 'plan', label: 'Plan', short: 'Plan' },
  { value: 'agent', label: 'Agent', short: 'Agent' }
]

function nextMode(current: AgentInteractionMode, reverse: boolean): AgentInteractionMode {
  const i = MODES.findIndex((m) => m.value === current)
  const idx = i >= 0 ? i : 2
  const len = MODES.length
  const next = reverse ? (idx - 1 + len) % len : (idx + 1) % len
  return MODES[next]!.value
}

export function ModePicker({
  mode,
  onModeChange,
  disabled,
  running = false,
  className
}: {
  mode: AgentInteractionMode
  onModeChange: (mode: AgentInteractionMode) => void
  disabled?: boolean
  running?: boolean
  className?: string
}) {
  const advance = useCallback(
    (reverse: boolean) => {
      onModeChange(nextMode(mode, reverse))
    },
    [mode, onModeChange]
  )

  const locked = Boolean(disabled || running)
  const current = MODES.find((m) => m.value === mode) ?? MODES[2]!
  const upcoming = MODES.find((m) => m.value === nextMode(mode, false))!

  const ariaLabel = running
    ? `${current.label} mode (locked while running)`
    : `${current.label} mode. Click for ${upcoming.label}.`

  return (
    <div className={cn('relative flex h-7 shrink-0 items-center', className)}>
      <button
        type="button"
        disabled={locked}
        aria-label={ariaLabel}
        title={running ? ariaLabel : `${ariaLabel} Shift-click for previous.`}
        className={cn(chromePillButton, 'text-fg')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault()
          if (locked) return
          advance(e.shiftKey)
        }}
      >
        <span className="leading-tight">{current.short}</span>
      </button>
    </div>
  )
}
