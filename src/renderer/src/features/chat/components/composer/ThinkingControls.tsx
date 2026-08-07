import { useCallback, useMemo, useState } from 'react'
import { cn } from '@renderer/lib/ui/cn'
import type { ModelInfo, ProviderId, ThinkingEffort, ThinkingMode } from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import {
  catalogThinkingAllowed,
  modelSupportsThinking,
  ollamaThinkingHeuristicFields
} from '@shared/reasoning'
import {
  nextLowerThinkingEffort,
  shouldSuggestLowerThinkingEffort,
  HIGH_THINKING_LONG_RUN_STEP_THRESHOLD
} from '@shared/utils/tokenCost'
import { chromePillButton } from './composerChrome'

const ALL_EFFORT_OPTIONS: { value: ThinkingEffort; label: string; short: string }[] = [
  { value: 'minimal', label: 'Minimal', short: 'Min' },
  { value: 'low', label: 'Low', short: 'Low' },
  { value: 'medium', label: 'Medium', short: 'Med' },
  { value: 'high', label: 'High', short: 'High' },
  { value: 'xhigh', label: 'Extra high', short: 'XHigh' },
  { value: 'max', label: 'Max', short: 'Max' }
]

type ThinkingModeOption =
  | { enabled: false; effort: ThinkingEffort | null; label: string; short: string }
  | { enabled: true; effort: ThinkingEffort; label: string; short: string }

function buildModes(
  allowed: readonly ThinkingEffort[] | undefined,
  canDisable: boolean,
  thinkingMode: ThinkingMode | undefined,
  defaultEffort: ThinkingEffort = 'medium'
): ThinkingModeOption[] {
  if (thinkingMode === 'boolean') {
    const on: ThinkingModeOption = {
      enabled: true,
      effort: defaultEffort,
      label: 'On',
      short: 'On'
    }
    if (!canDisable) return [on]
    return [{ enabled: false, effort: null, label: 'Off', short: 'Off' }, on]
  }

  const options =
    allowed && allowed.length > 0
      ? ALL_EFFORT_OPTIONS.filter((o) => allowed.includes(o.value))
      : ALL_EFFORT_OPTIONS
  const effortModes: ThinkingModeOption[] = options.map((o) => ({
    enabled: true as const,
    effort: o.value,
    label: o.label,
    short: o.short
  }))
  if (!canDisable) return effortModes
  return [{ enabled: false, effort: null, label: 'Off', short: 'Off' }, ...effortModes]
}

function modeIndex(
  modes: ThinkingModeOption[],
  enabled: boolean,
  effort: ThinkingEffort
): number {
  if (!enabled) {
    const off = modes.findIndex((m) => !m.enabled)
    return off >= 0 ? off : 0
  }
  const i = modes.findIndex((m) => m.enabled && m.effort === effort)
  if (i >= 0) return i
  const firstOn = modes.findIndex((m) => m.enabled)
  return firstOn >= 0 ? firstOn : 0
}

function nextMode(
  modes: ThinkingModeOption[],
  index: number,
  reverse: boolean
): ThinkingModeOption {
  const len = modes.length
  const next = reverse ? (index - 1 + len) % len : (index + 1) % len
  return modes[next]!
}

/** Resolve catalog fields with Ollama heuristic fallback when API omits thinking mode. */
function resolveThinkingUiMeta(
  provider: ProviderId,
  model: string,
  modelMeta?: ModelInfo | null
): {
  thinkingMode?: ThinkingMode
  supportedThinkingEfforts?: ThinkingEffort[]
  thinkingCanDisable: boolean
  thinkingDefaultEffort: ThinkingEffort
} {
  const ollamaFallback =
    (provider === 'ollama' || provider === 'custom') &&
    (modelMeta?.supportsThinking === true ||
      (catalogThinkingAllowed(model, modelMeta?.supportsThinking) &&
        modelSupportsThinking(model, provider)))
      ? ollamaThinkingHeuristicFields(model)
      : undefined

  return {
    thinkingMode:
      modelMeta?.thinkingMode ??
      (provider === 'custom' && ollamaFallback?.thinkingMode === 'boolean'
        ? 'effort'
        : ollamaFallback?.thinkingMode),
    supportedThinkingEfforts:
      modelMeta?.supportedThinkingEfforts ?? ollamaFallback?.supportedThinkingEfforts,
    thinkingCanDisable:
      modelMeta?.thinkingCanDisable ?? ollamaFallback?.thinkingCanDisable ?? true,
    thinkingDefaultEffort:
      modelMeta?.thinkingDefaultEffort ?? ollamaFallback?.thinkingDefaultEffort ?? 'medium'
  }
}

/**
 * Catalog true wins; catalog false only hides unknown ids (known reasoner families still show).
 * Missing meta/field falls back to ID heuristic.
 */
export function modelShowsThinkingControls(
  provider: ProviderId,
  model: string,
  modelMeta?: ModelInfo | null
): boolean {
  if (modelMeta?.supportsThinking === true) return true
  if (modelMeta?.supportsThinking === false) {
    return catalogThinkingAllowed(model, false)
  }
  return modelSupportsThinking(model, provider)
}

export function ThinkingControls({
  provider,
  model,
  modelMeta,
  chatSettings,
  onChatSettingsChange,
  disabled,
  running = false,
  runSteps = 0,
  className
}: {
  provider: ProviderId
  model: string
  /** Catalog ModelInfo when available; drives visibility and allowed efforts. */
  modelMeta?: ModelInfo | null
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  disabled?: boolean
  running?: boolean
  /** Cumulative agent steps this run — gates the optional “Lower” suggestion chip. */
  runSteps?: number
  className?: string
}) {
  const ui = useMemo(
    () => resolveThinkingUiMeta(provider, model, modelMeta),
    [provider, model, modelMeta]
  )
  const modes = useMemo(
    () =>
      buildModes(
        ui.supportedThinkingEfforts,
        ui.thinkingCanDisable,
        ui.thinkingMode,
        ui.thinkingDefaultEffort
      ),
    [ui.supportedThinkingEfforts, ui.thinkingCanDisable, ui.thinkingMode, ui.thinkingDefaultEffort]
  )

  const [dismissedSuggestKey, setDismissedSuggestKey] = useState<string | null>(null)

  const advance = useCallback(
    (reverse: boolean) => {
      const i = modeIndex(modes, chatSettings.thinkingEnabled, chatSettings.thinkingEffort)
      const next = nextMode(modes, i, reverse)
      if (!next.enabled) {
        onChatSettingsChange({ thinkingEnabled: false })
        return
      }
      onChatSettingsChange({
        thinkingEnabled: true,
        thinkingEffort: next.effort
      })
    },
    [modes, chatSettings.thinkingEnabled, chatSettings.thinkingEffort, onChatSettingsChange]
  )

  if (!modelShowsThinkingControls(provider, model, modelMeta)) return null

  const locked = Boolean(disabled || running)
  const index = modeIndex(modes, chatSettings.thinkingEnabled, chatSettings.thinkingEffort)
  const current = modes[index]!
  const upcoming = nextMode(modes, index, false)
  const on = current.enabled

  const ariaLabel = running
    ? on
      ? `Thinking ${current.label} (locked while running)`
      : 'Thinking off (locked while running)'
    : on
      ? `Thinking ${current.label}. Click for ${upcoming.label}.`
      : `Thinking off. Click for ${upcoming.label}.`

  const costHint =
    on &&
    (current.effort === 'high' || current.effort === 'xhigh' || current.effort === 'max')
      ? ' Higher effort bills more reasoning tokens on every step.'
      : ''

  const suggestKey =
    on && current.effort
      ? `${provider}:${model}:${current.effort}:${runSteps >= HIGH_THINKING_LONG_RUN_STEP_THRESHOLD ? 'long' : 'short'}`
      : null
  const lowerTarget =
    on && current.effort
      ? (nextLowerThinkingEffort(current.effort, ui.supportedThinkingEfforts) as ThinkingEffort | null)
      : null
  const showSuggestLower =
    Boolean(lowerTarget) &&
    suggestKey != null &&
    dismissedSuggestKey !== suggestKey &&
    shouldSuggestLowerThinkingEffort({
      thinkingEnabled: on,
      thinkingEffort: current.effort,
      steps: runSteps,
      thinkingMode: ui.thinkingMode
    })

  const applyLower = (): void => {
    if (!lowerTarget || disabled) return
    onChatSettingsChange({
      thinkingEnabled: true,
      thinkingEffort: lowerTarget
    })
  }

  const dismissSuggest = (): void => {
    if (suggestKey) setDismissedSuggestKey(suggestKey)
  }

  const lowerLabel =
    lowerTarget != null
      ? ALL_EFFORT_OPTIONS.find((o) => o.value === lowerTarget)?.short ?? lowerTarget
      : ''

  // Deliberately allowed while running: settings apply per invoke, so this
  // queues for the next message — the live run keeps its effort.
  const lowerLocked = Boolean(disabled)
  const lowerTitle = running
    ? `Queue ${lowerLabel} for the next message — this run keeps its current effort (never auto-changed).`
    : `Lower thinking to ${lowerLabel}. Applies only when you click — never automatic.`

  return (
    <div className={cn('relative flex h-7 shrink-0 items-center gap-0.5', className)}>
      <button
        type="button"
        disabled={locked}
        aria-label={ariaLabel}
        title={
          running
            ? ariaLabel
            : `${ariaLabel} Shift-click for previous.${costHint}`
        }
        className={cn(chromePillButton, 'gap-0', on ? 'text-fg' : 'text-muted')}
        onClick={(e) => {
          e.preventDefault()
          if (locked) return
          advance(e.shiftKey)
        }}
      >
        <span className="inline-flex min-w-0 items-center leading-tight">
          Think
          <span className={cn('text-tertiary', on && 'text-muted')}> · </span>
          <span className={on ? 'text-fg' : 'text-tertiary'}>{current.short}</span>
        </span>
      </button>
      {showSuggestLower ? (
        <span
          className="inline-flex h-7 max-w-[9rem] shrink-0 items-center gap-0.5 overflow-hidden rounded-md border border-warning/40 bg-warning/10 px-1 text-2xs leading-tight text-warning"
          role="status"
        >
          <button
            type="button"
            disabled={lowerLocked}
            className={cn(
              'min-w-0 truncate rounded px-1 font-medium vy-transition hover:bg-warning/20',
              'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
            )}
            title={lowerTitle}
            aria-label={`Lower thinking effort to ${lowerLabel}`}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              applyLower()
            }}
          >
            <span className="@max-[560px]:hidden">Lower · </span>
            {lowerLabel}
          </button>
          <button
            type="button"
            className="rounded px-0.5 text-warning/80 vy-transition hover:bg-warning/20 hover:text-warning"
            aria-label="Dismiss lower-thinking suggestion"
            title="Dismiss"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              dismissSuggest()
            }}
          >
            ×
          </button>
        </span>
      ) : null}
    </div>
  )
}
