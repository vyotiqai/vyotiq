import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@renderer/lib/ui/cn'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import {
  alignContextUsageToModelWindow,
  type ContextUsageState
} from '@shared/utils/contextUsage'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { shouldShowTaskBoundaryTip } from '@shared/utils/tokenCost'
import {
  clampComposerDropdownPanel,
  composerDropdownSectionHeader
} from './composerDropdownLayout'

export type { ContextUsageState }

const CONTEXT_METER_MAX_PX = 320

function formatPct(n: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.round((n / total) * 100)}%`
}

function usageTone(ratio: number): string {
  if (ratio >= 0.9) return 'text-danger'
  if (ratio >= 0.7) return 'text-warning'
  return 'text-fg'
}

function usageFill(ratio: number): string {
  if (ratio >= 0.9) return 'bg-danger'
  if (ratio >= 0.7) return 'bg-warning'
  return 'bg-fg'
}

/** Telemetry only when estimate-only, or when estimate and provider disagree. */
export function shouldShowContextTelemetry(usage: ContextUsageState): boolean {
  if (usage.inputTokens == null) return usage.source === 'estimate'
  return usage.inputTokens !== usage.estimatedTokens
}

function PanelSection({
  title,
  children,
  className
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('px-3 py-2.5', className)}>
      {title ? <h3 className={cn(composerDropdownSectionHeader, 'mb-2 px-0')}>{title}</h3> : null}
      {children}
    </section>
  )
}

function StatCard({
  label,
  value,
  detail,
  tone
}: {
  label: string
  value: string
  detail?: string
  tone?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-surface/50 px-2.5 py-2">
      <span className="text-3xs text-secondary">{label}</span>
      <span className={cn('truncate text-sm font-semibold tabular-nums leading-tight', tone ?? 'text-fg')}>
        {value}
      </span>
      {detail ? <span className="truncate text-3xs text-secondary">{detail}</span> : null}
    </div>
  )
}

function MetricRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-2xs">
      <span className="shrink-0 text-secondary">{label}</span>
      <span className={cn('min-w-0 truncate text-right tabular-nums', tone ?? 'text-fg')}>{value}</span>
    </div>
  )
}

function LayerRow({
  label,
  tokens,
  total,
  hint
}: {
  label: string
  tokens: number
  total: number
  hint?: string
}) {
  const ratio = total > 0 ? Math.min(1, tokens / total) : 0
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_5.5rem] items-center gap-x-2">
      <span className="truncate text-2xs text-secondary">
        {label}
        {hint ? <span className="sr-only"> {hint}</span> : null}
      </span>
      <div className="h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-fg/50 vy-transition"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <span className="shrink-0 text-right text-2xs tabular-nums text-fg">
        {formatTokens(tokens)}
        <span className="text-secondary"> · {formatPct(tokens, total)}</span>
      </span>
    </div>
  )
}

/** Latest-step cache hit share of provider input, or null when unknown. */
export function cacheHitPct(totals: StepUsageTotals): number | null {
  if (totals.cachedInputTokens <= 0 || totals.inputTokens <= 0) return null
  return Math.round((totals.cachedInputTokens / totals.inputTokens) * 100)
}

/** Run-level cache hit share from summed step cache / billed input. */
export function billedCacheHitPct(totals: StepUsageTotals): number | null {
  if (totals.billedCachedInputTokens <= 0 || totals.billedInputTokens <= 0) return null
  return Math.round((totals.billedCachedInputTokens / totals.billedInputTokens) * 100)
}

function PromptCacheSection({ totals }: { totals: StepUsageTotals }) {
  const hitPct = cacheHitPct(totals)
  const hasHit = totals.cachedInputTokens > 0
  const hasWrite = totals.cacheCreationInputTokens > 0
  if (!hasHit && !hasWrite) return null

  const input = Math.max(1, totals.inputTokens)
  const hitRatio = Math.min(1, totals.cachedInputTokens / input)
  const freshTokens = Math.max(0, totals.inputTokens - totals.cachedInputTokens)

  return (
    <PanelSection title="Prompt cache" className="border-t border-border">
      {hasHit ? (
        <>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-success/70 vy-transition"
              style={{ width: `${hitRatio * 100}%` }}
              title={`Cached ${formatTokens(totals.cachedInputTokens)}`}
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <StatCard
              label="Cache hit"
              value={hitPct != null ? `${hitPct}%` : formatTokens(totals.cachedInputTokens)}
              detail={`${formatTokens(totals.cachedInputTokens)} cached`}
              tone="text-success"
            />
            <StatCard
              label="Uncached input"
              value={formatTokens(freshTokens)}
              detail={`${formatTokens(totals.inputTokens)} total input`}
            />
          </div>
        </>
      ) : null}
      <div className={cn('flex flex-col gap-1.5', hasHit ? 'mt-2' : undefined)}>
        {hasWrite ? (
          <MetricRow
            label="Cache write"
            value={formatTokens(totals.cacheCreationInputTokens)}
            tone="text-warning"
          />
        ) : null}
        {hasHit ? (
          <p className="m-0 text-3xs leading-snug text-secondary">
            Hit rate is for the latest step’s input window
          </p>
        ) : (
          <p className="m-0 text-3xs leading-snug text-secondary">
            Cache write tokens accumulate across steps this run
          </p>
        )}
      </div>
    </PanelSection>
  )
}

function StepUsageSection({ totals }: { totals: StepUsageTotals }) {
  if (
    totals.steps <= 0 &&
    totals.outputTokens <= 0 &&
    totals.reasoningTokens <= 0 &&
    totals.billedInputTokens <= 0
  ) {
    return null
  }
  const reasoningPct =
    totals.reasoningTokens > 0 && totals.outputTokens > 0
      ? Math.round((totals.reasoningTokens / totals.outputTokens) * 100)
      : null
  const runHit = billedCacheHitPct(totals)
  const taskBoundary = shouldShowTaskBoundaryTip({
    steps: totals.steps,
    billedInputTokens: totals.billedInputTokens
  })

  return (
    <PanelSection title="Step usage" className="border-t border-border">
      <div className="flex flex-col gap-1.5">
        {totals.steps > 0 ? <MetricRow label="Steps" value={String(totals.steps)} /> : null}
        {totals.billedInputTokens > 0 ? (
          <MetricRow label="Billed input" value={formatTokens(totals.billedInputTokens)} />
        ) : null}
        {totals.peakInputTokens > 0 ? (
          <MetricRow label="Peak input" value={formatTokens(totals.peakInputTokens)} />
        ) : null}
        {totals.outputTokens > 0 ? (
          <MetricRow label="Output" value={formatTokens(totals.outputTokens)} />
        ) : null}
        {totals.reasoningTokens > 0 ? (
          <MetricRow
            label="Reasoning"
            value={`${formatTokens(totals.reasoningTokens)}${reasoningPct != null ? ` · ${reasoningPct}%` : ''}`}
            tone={reasoningPct != null && reasoningPct >= 40 ? 'text-warning' : undefined}
          />
        ) : null}
        {reasoningPct != null && reasoningPct >= 40 ? (
          <p className="m-0 text-3xs leading-snug text-secondary">
            Reasoning is a large share of output — lower Think effort for simpler work (settings are
            never changed automatically).
          </p>
        ) : null}
        {runHit != null ? (
          <MetricRow label="Run cache hit" value={`${runHit}%`} tone="text-success" />
        ) : null}
        {taskBoundary ? (
          <p className="m-0 text-3xs leading-snug text-warning" role="status">
            Long run — /clear (new chat) zeros history for an unrelated task; /compact keeps
            continuity on this one.
          </p>
        ) : null}
      </div>
    </PanelSection>
  )
}

function TelemetrySection({ usage }: { usage: ContextUsageState }) {
  if (!shouldShowContextTelemetry(usage)) return null

  const estimateDelta =
    usage.inputTokens != null && usage.inputTokens !== usage.estimatedTokens
      ? usage.inputTokens - usage.estimatedTokens
      : null

  return (
    <PanelSection title="Telemetry" className="border-t border-border">
      <div className="flex flex-col gap-1.5">
        <MetricRow label="Estimate" value={formatTokens(usage.estimatedTokens)} />
        {usage.inputTokens != null ? (
          <MetricRow label="Provider input" value={formatTokens(usage.inputTokens)} />
        ) : null}
        {estimateDelta != null ? (
          <MetricRow
            label="Delta"
            value={`${estimateDelta > 0 ? '+' : ''}${formatTokens(estimateDelta, true)}`}
            tone={estimateDelta > 0 ? 'text-warning' : 'text-success'}
          />
        ) : null}
      </div>
    </PanelSection>
  )
}

function ContextMeterPanel({
  usage,
  onCompact,
  compacting,
  compactDisabled,
  compactMessage,
  compactFailed
}: {
  usage: ContextUsageState
  onCompact?: () => void
  compacting?: boolean
  compactDisabled?: boolean
  compactMessage?: string | null
  compactFailed?: boolean
}) {
  const denominator = Math.max(1, usage.contentWindow > 0 ? usage.contentWindow : usage.window)
  const ratio = Math.min(1, usage.used / denominator)
  const pct = Math.round(ratio * 100)
  const compactionPct = Math.min(
    100,
    Math.round((usage.compactionTrigger / denominator) * 100)
  )
  const hasLayers =
    usage.layers.system + usage.layers.history + usage.layers.tools > 0 || usage.layers.buffer > 0
  const fill = usageFill(ratio)
  const tone = usageTone(ratio)

  return (
    <>
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="m-0 text-xs font-medium text-fg">Context window</p>
            <p className="m-0 mt-0.5 text-3xs text-secondary">
              Step {usage.step} · {formatTokens(usage.window)} window
            </p>
          </div>
          <span
            className={cn(
              'shrink-0 rounded-lg px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wide',
              usage.source === 'provider'
                ? 'bg-success/15 text-success'
                : 'bg-warning/15 text-warning'
            )}
          >
            {usage.source === 'provider' ? 'Provider' : 'Estimated'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 @max-[17rem]/panel:grid-cols-1">
          <StatCard
            label="Used"
            value={`${pct}%`}
            detail={`${formatTokens(usage.used)} of ${formatTokens(denominator)}`}
            tone={tone}
          />
          <StatCard
            label="Content budget"
            value={formatTokens(denominator)}
            detail={`${formatTokens(usage.window)} total window`}
          />
        </div>
      </header>

      <div className="sidebar-scroll @container/panel min-h-0 flex-1 overflow-y-auto">
        <PanelSection>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className={cn('absolute inset-y-0 left-0 rounded-full vy-transition', fill)}
              style={{ width: `${pct}%` }}
            />
            {compactionPct > 0 ? (
              <div
                className="absolute inset-y-0 w-px bg-fg/35"
                style={{ left: `${compactionPct}%` }}
                title={`Compaction at ${formatTokens(usage.compactionTrigger)}`}
              />
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
            <p className="m-0 min-w-0 flex-1 text-3xs leading-snug text-secondary">
              Compaction at {formatTokens(usage.compactionTrigger)} ·{' '}
              {formatPct(usage.compactionTrigger, denominator)} of budget
            </p>
            {onCompact ? (
              <button
                type="button"
                onClick={onCompact}
                disabled={compacting || compactDisabled}
                title={
                  compactDisabled
                    ? 'Unavailable while the agent is running'
                    : compacting
                      ? 'Compacting…'
                      : 'Compact older history now'
                }
                className="shrink-0 rounded-xl border border-border px-2 py-1 text-3xs font-medium text-fg vy-transition hover:bg-surface disabled:opacity-[var(--vy-disabled-opacity)]"
              >
                {compacting ? 'Compacting…' : 'Compact now'}
              </button>
            ) : null}
          </div>
          {compactMessage ? (
            <p
              className={cn(
                'm-0 mt-2 text-3xs leading-snug',
                compactFailed ? 'text-danger' : 'text-secondary'
              )}
              role={compactFailed ? 'alert' : 'status'}
            >
              {compactMessage}
            </p>
          ) : null}
          {usage.overflow ? (
            <p className="m-0 mt-2 text-3xs leading-snug text-danger" role="alert">
              Context still exceeds the model window after compaction. Run /compact with a focus, or
              /clear (new chat) when starting an unrelated task.
            </p>
          ) : usage.used >= usage.compactionTrigger ? (
            <p className="m-0 mt-2 text-3xs leading-snug text-warning" role="status">
              Past the compaction line — /compact keeps continuity; /clear is free when switching
              tasks.
            </p>
          ) : null}
        </PanelSection>

        {hasLayers ? (
          <PanelSection title="Layers" className="border-t border-border pt-2.5">
            <div className="flex flex-col gap-2">
              <LayerRow label="System" tokens={usage.layers.system} total={denominator} />
              <LayerRow label="History" tokens={usage.layers.history} total={denominator} />
              <LayerRow label="Tools" tokens={usage.layers.tools} total={denominator} />
              <LayerRow
                label="Buffer"
                tokens={usage.layers.buffer}
                total={usage.window}
                hint="reserved allocation, not counted in usage bar"
              />
            </div>
            <p className="m-0 mt-2 text-3xs leading-snug text-secondary">
              Buffer is reserved, not counted in usage
            </p>
          </PanelSection>
        ) : null}

        <TelemetrySection usage={usage} />
        <PromptCacheSection totals={usage.stepUsage} />
        <StepUsageSection totals={usage.stepUsage} />
      </div>

      <footer className="shrink-0 border-t border-border px-3 py-1.5">
        <p className="m-0 text-3xs text-secondary">
          Updated {new Date(usage.updatedAt).toLocaleTimeString()}
        </p>
      </footer>
    </>
  )
}

export function ContextMeter({
  usage,
  modelWindow,
  compactionTriggerRatio,
  onCompact,
  compactDisabled = false,
  className
}: {
  usage: ContextUsageState | null
  /** Current model context window — realigns stale hydrated events (e.g. 128k fallback). */
  modelWindow?: number | null
  /** Compaction threshold used when realigning usage against the model window. */
  compactionTriggerRatio?: number
  /** Summarize the run's older history on demand; omitted when no run exists. */
  onCompact?: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  /** When true, Compact stays visible but disabled (e.g. agent is running). */
  compactDisabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [compactMessage, setCompactMessage] = useState<string | null>(null)
  const [compactFailed, setCompactFailed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const alignedUsage =
    usage && modelWindow && modelWindow > 0
      ? alignContextUsageToModelWindow(usage, modelWindow, compactionTriggerRatio)
      : usage
  const { position } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'end',
    disabled: !alignedUsage
  })

  const runCompaction = async (): Promise<void> => {
    if (!onCompact || compacting || compactDisabled) return
    setCompacting(true)
    setCompactMessage(null)
    setCompactFailed(false)
    try {
      const result = await onCompact()
      setCompactMessage(result.message)
      setCompactFailed(!result.ok)
    } finally {
      setCompacting(false)
    }
  }

  if (!alignedUsage || alignedUsage.window <= 0) return null

  const denominator = Math.max(
    1,
    alignedUsage.contentWindow > 0 ? alignedUsage.contentWindow : alignedUsage.window
  )
  const ratio = Math.min(1, alignedUsage.used / denominator)
  const pct = Math.round(ratio * 100)
  const estimate = alignedUsage.source === 'estimate'
  const usedLabel = formatTokens(alignedUsage.used)
  const windowLabel = formatTokens(denominator)
  const fillTone = usageFill(ratio)
  const usedTone = usageTone(ratio)
  const tipCue =
    shouldShowTaskBoundaryTip({
      steps: alignedUsage.stepUsage.steps,
      billedInputTokens: alignedUsage.stepUsage.billedInputTokens
    }) || alignedUsage.used >= alignedUsage.compactionTrigger
  const triggerUsedTone = tipCue && ratio < 0.9 ? 'text-warning' : usedTone
  const hitPct = cacheHitPct(alignedUsage.stepUsage)
  const cacheHint =
    hitPct != null
      ? ` · ${hitPct}% cached`
      : alignedUsage.stepUsage.cacheCreationInputTokens > 0
        ? ` · ${formatTokens(alignedUsage.stepUsage.cacheCreationInputTokens)} cache write`
        : ''

  const panelLayout =
    open && position
      ? (() => {
          const desired = Math.min(
            CONTEXT_METER_MAX_PX,
            Math.max(0, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 16)
          )
          // align:end → position.left is the trigger's right edge
          const unclampedLeft = position.left - desired
          return clampComposerDropdownPanel({
            position: {
              left: unclampedLeft,
              top: position.top,
              placement: position.placement
            },
            maxWidthPx: CONTEXT_METER_MAX_PX
          })
        })()
      : null

  return (
    <div className={cn('relative flex h-7 shrink-0 items-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'group relative inline-flex h-7 max-w-[8.5rem] min-w-0 items-center overflow-hidden rounded-xl px-1.5 text-2xs leading-none tracking-[var(--vy-tracking)] @min-[480px]:max-w-[9.5rem]',
          'vy-transition',
          tipCue
            ? 'bg-warning/10 text-warning hover:bg-warning/15 active:bg-warning/15'
            : 'hover:bg-surface active:bg-surface',
          open && (tipCue ? 'bg-warning/15' : 'bg-surface')
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={`Context window ${pct}% full${estimate ? ' (estimated)' : ''}: ${usedLabel} of ${windowLabel}${cacheHint}. Open breakdown.`}
        title={`Context ${usedLabel} · ${windowLabel}${estimate ? ' (estimated)' : ''}${cacheHint}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 opacity-[0.08] vy-transition group-hover:opacity-[0.12]',
            tipCue && ratio < 0.7 ? 'bg-warning' : fillTone
          )}
          style={{ width: `${ratio * 100}%` }}
          aria-hidden
        />
        <span className="relative flex min-w-0 items-center gap-0.5 tabular-nums">
          <span className={cn('shrink-0', triggerUsedTone)}>
            {estimate ? '~' : ''}
            {usedLabel}
          </span>
          <span className="shrink-0 text-tertiary">·</span>
          <span className="min-w-0 truncate text-muted">{windowLabel}</span>
          {hitPct != null ? (
            <>
              <span className="shrink-0 text-tertiary @max-[480px]:hidden">·</span>
              <span className="shrink-0 text-success @max-[480px]:hidden">{hitPct}%</span>
            </>
          ) : null}
        </span>
      </button>

      {open && position && panelLayout
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Context window breakdown"
              className="fixed z-dropdown flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-menu animate-fade-in"
              style={{
                top: position.placement === 'up' ? undefined : position.top,
                bottom:
                  position.placement === 'up'
                    ? window.innerHeight - position.top
                    : undefined,
                left: panelLayout.left,
                width: panelLayout.width,
                maxWidth: panelLayout.width,
                maxHeight: panelLayout.maxHeight
              }}
            >
              <ContextMeterPanel
                usage={alignedUsage}
                onCompact={onCompact ? () => void runCompaction() : undefined}
                compacting={compacting}
                compactDisabled={compactDisabled}
                compactMessage={compactMessage}
                compactFailed={compactFailed}
              />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
