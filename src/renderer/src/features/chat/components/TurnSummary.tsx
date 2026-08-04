import { memo, useEffect, useMemo, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { DISCLOSURE_ROW } from '@renderer/lib/utils/layout'
import { formatElapsed } from '@shared/utils/timeFormat'
import type { TurnSpan } from '../utils/transcriptRows'
import { turnSummaryActiveLabel } from '../utils/runActivity'
import { TextShimmer } from './TextShimmer'

/** Below this the duration is noise; the turn was effectively instant. */
const MIN_REPORTABLE_MS = 1000

export const TurnSummary = memo(function TurnSummary({
  span,
  collapsed,
  onToggle
}: {
  span: TurnSpan
  collapsed: boolean
  onToggle: () => void
}) {
  const { startedAt, endedAt, active, activity } = span
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active || startedAt == null) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [active, startedAt])

  const turnElapsedMs =
    startedAt == null ? null : active ? now - startedAt : endedAt == null ? null : endedAt - startedAt

  const turnDuration = useMemo(
    () =>
      turnElapsedMs != null && turnElapsedMs >= MIN_REPORTABLE_MS ? formatElapsed(turnElapsedMs) : '',
    [turnElapsedMs]
  )

  const phaseLabel = turnSummaryActiveLabel(activity, collapsed)
  const activeText = turnDuration ? `${phaseLabel} · ${turnDuration}` : phaseLabel

  const doneLabel = turnDuration ? `Worked for ${turnDuration}` : 'Worked'
  const accessibleName = active
    ? collapsed
      ? activeText
      : `Collapse turn work, ${activeText}`
    : doneLabel

  return (
    <button
      type="button"
      className={cn(DISCLOSURE_ROW, 'w-full text-left text-tertiary')}
      aria-expanded={!collapsed}
      aria-label={accessibleName}
      onClick={onToggle}
    >
      {active ? (
        <>
          <TextShimmer className="shrink-0">{phaseLabel}</TextShimmer>
          {turnDuration ? (
            <span className="shrink-0 tabular-nums">· {turnDuration}</span>
          ) : null}
        </>
      ) : (
        <span className="shrink-0 tabular-nums">{doneLabel}</span>
      )}
      <Icon
        name="chevronRight"
        size={14}
        className={cn('shrink-0 self-center vy-transition', !collapsed && 'rotate-90')}
      />
    </button>
  )
})
