import { useCallback, useSyncExternalStore } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import type { ProviderId, ServiceTier } from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { knownContextWindow } from '@shared/domain/modelContextWindows'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import { MAX_IMAGES } from './useComposerImages'
import { MAX_FILES } from './useComposerFiles'
import { ContextMeter, type ContextUsageState } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import { ModePicker } from './ModePicker'
import { ThinkingControls } from './ThinkingControls'
import { chromeLabelText } from './composerChrome'
import type { ModelPickerOption } from './composerModelUtils'
import type { ModelInfo } from '@shared/ipc'
import type { AgentInteractionMode } from '@shared/ipc'
import type { ChatMetaStore } from '../../chatStores'

function ThinkingControlsWithSteps({
  metaStore,
  usage,
  provider,
  model,
  modelMeta,
  chatSettings,
  onChatSettingsChange,
  disabled,
  running,
  className
}: {
  metaStore?: ChatMetaStore
  usage?: ContextUsageState | null
  provider: ProviderId
  model: string
  modelMeta?: ModelInfo | null
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  disabled?: boolean
  running?: boolean
  className?: string
}) {
  const resolved = useResolvedContextUsage(metaStore, usage)
  const runSteps = resolved?.stepUsage?.steps ?? 0
  return (
    <ThinkingControls
      provider={provider}
      model={model}
      modelMeta={modelMeta}
      chatSettings={chatSettings}
      onChatSettingsChange={onChatSettingsChange}
      disabled={disabled}
      running={running}
      runSteps={runSteps}
      className={className}
    />
  )
}

function useResolvedContextUsage(
  metaStore: ChatMetaStore | undefined,
  usage: ContextUsageState | null | undefined
): ContextUsageState | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => metaStore?.subscribeMeta(onStoreChange) ?? (() => {}),
    [metaStore]
  )
  const getRevision = useCallback(() => metaStore?.getMetaRevision() ?? 0, [metaStore])
  useSyncExternalStore(subscribe, getRevision, getRevision)
  return metaStore ? metaStore.getContextUsage() : (usage ?? null)
}

function ContextMeterLeaf({
  metaStore,
  usage,
  modelWindow,
  compactionTriggerRatio,
  onCompact,
  compactDisabled
}: {
  metaStore?: ChatMetaStore
  usage?: ContextUsageState | null
  modelWindow?: number | null
  compactionTriggerRatio?: number
  onCompact?: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  compactDisabled?: boolean
}) {
  const resolved = useResolvedContextUsage(metaStore, usage)
  return (
    <ContextMeter
      usage={resolved}
      modelWindow={modelWindow}
      compactionTriggerRatio={compactionTriggerRatio}
      onCompact={onCompact}
      compactDisabled={compactDisabled}
    />
  )
}

/** Shared compact control height for the toolbar row. */
const iconCtl =
  'inline-grid size-7 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted vy-transition hover:bg-surface hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)] disabled:hover:bg-transparent disabled:hover:text-muted'

/** Size to content; truncate only when the middle zone is constrained. */
const modelPillTrigger = cn(
  'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1',
  chromeLabelText,
  'text-fg hover:bg-surface active:bg-surface',
  'vy-transition disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
)

const sendCtl = cn(
  'inline-grid size-7 shrink-0 place-items-center rounded-xl vy-transition',
  'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
)

/** Shared control row — every pill/icon aligns to the same 28px baseline. */
const zone = 'flex h-7 min-w-0 items-center gap-1'

const toolbarDivider = 'mx-0.5 h-4 w-px shrink-0 bg-border/40'

export type ComposerVariant = 'hero' | 'dock' | 'inline'

export function ComposerToolbar({
  variant,
  disabled,
  locked,
  attachDisabled,
  imageCount,
  fileCount,
  onAttachClick,
  providers,
  optionsByProvider,
  seedsByProvider,
  modelMetaByValue,
  provider,
  model,
  favoriteModels,
  recentModels,
  modelsWarning,
  serviceTier,
  onModelChange,
  onToggleFavorite,
  onServiceTierChange,
  onRefreshCatalog,
  onBrowseProvider,
  catalogLoading,
  chatSettings,
  onChatSettingsChange,
  agentMode,
  onAgentModeChange,
  running,
  canSend,
  onStop,
  contextUsage,
  metaStore,
  onCompactContext,
  onCancelEdit,
  focusInput,
  imageReadyHint = null
}: {
  variant: ComposerVariant
  disabled?: boolean
  locked: boolean
  /** When set, only blocks attach (input may stay open while settings stay locked). */
  attachDisabled?: boolean
  imageCount: number
  fileCount: number
  onAttachClick: () => void
  providers: ProviderId[]
  optionsByProvider: Record<ProviderId, ModelPickerOption[]>
  seedsByProvider: Record<ProviderId, ModelPickerOption[]>
  modelMetaByValue: Record<string, ModelInfo>
  provider: ProviderId
  model: string
  favoriteModels: string[]
  recentModels: string[]
  modelsWarning: string | null
  serviceTier: ServiceTier
  onModelChange: (provider: ProviderId, model: string) => void
  onToggleFavorite: (provider: ProviderId, model: string) => void
  onServiceTierChange: (tier: ServiceTier) => void
  onRefreshCatalog: () => void
  onBrowseProvider?: (provider: ProviderId) => void
  catalogLoading?: boolean
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  agentMode: AgentInteractionMode
  onAgentModeChange: (mode: AgentInteractionMode) => void
  running: boolean
  canSend: boolean
  onStop: () => void
  contextUsage?: ContextUsageState | null
  metaStore?: ChatMetaStore
  onCompactContext?: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  onCancelEdit?: () => void
  focusInput?: () => void
  imageReadyHint?: string | null
}) {
  const isInline = variant === 'inline'

  const imagesFull = imageCount >= MAX_IMAGES
  const filesFull = fileCount >= MAX_FILES
  const attachFull = imagesFull && filesFull
  const attachBlocked = Boolean(attachDisabled ?? locked)
  const attachLabel = attachFull
    ? `Attach files (limits reached: ${MAX_IMAGES} images, ${MAX_FILES} files)`
    : imagesFull
      ? `Attach files (image limit ${MAX_IMAGES}; documents still available)`
      : filesFull
        ? `Attach files (file limit ${MAX_FILES}; images still available)`
        : 'Attach files'

  const modelMeta =
    modelMetaByValue[modelSelectionKey(provider, model)] ?? modelMetaByValue[model]
  const modelWindow =
    knownContextWindow(model, provider) ??
    (modelMeta?.contextWindow && modelMeta.contextWindow > 0 ? modelMeta.contextWindow : null)

  const sendOrStop = (
    <div className="flex items-center gap-0.5">
      {isInline && onCancelEdit ? (
        <Tooltip content="Cancel edit (Esc)">
          <button
            type="button"
            className={iconCtl}
            aria-label="Cancel edit"
            onClick={onCancelEdit}
          >
            <Icon name="close" size={14} />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip
        content={
          running
            ? `Stop (${shortcutLabel('stop')})`
            : isInline
              ? 'Resend edited message'
              : 'Send'
        }
      >
        {running ? (
          <button
            type="button"
            className={cn(sendCtl, 'bg-accent text-accent-fg hover:bg-fg-strong')}
            aria-label="Stop"
            onClick={onStop}
          >
            <Icon name="stop" size={14} weight="fill" />
          </button>
        ) : (
          <button
            type="submit"
            className={cn(
              sendCtl,
              canSend ? 'bg-accent text-accent-fg hover:bg-fg-strong' : 'bg-surface-2 text-muted'
            )}
            aria-label={isInline ? 'Resend' : 'Send'}
            disabled={!canSend}
          >
            <Icon name="send" size={14} weight="fill" />
          </button>
        )}
      </Tooltip>
    </div>
  )

  return (
    <div
      className="col-span-full flex items-center gap-2 border-t border-border/25 pt-1.5"
      data-composer-toolbar
    >
      {/* Left: attach + mode + model */}
      <div className={cn(zone, 'min-w-0 flex-1 overflow-hidden')}>
        {attachBlocked || attachFull ? (
          <Tooltip content={attachLabel}>
            <span className="inline-grid cursor-not-allowed" tabIndex={0}>
              <button
                type="button"
                className={iconCtl}
                aria-label={attachLabel}
                disabled
                onClick={onAttachClick}
              >
                <Icon name="paperclip" size={15} />
              </button>
            </span>
          </Tooltip>
        ) : (
          <Tooltip content={attachLabel}>
            <button
              type="button"
              className={iconCtl}
              aria-label={attachLabel}
              onClick={onAttachClick}
            >
              <Icon name="paperclip" size={15} />
            </button>
          </Tooltip>
        )}
        <span className={toolbarDivider} aria-hidden />
        <ModePicker
          mode={agentMode}
          onModeChange={onAgentModeChange}
          disabled={locked}
          running={running}
          className="shrink-0"
        />
        <ModelPicker
          className="min-w-0 max-w-[14rem] flex-1 shrink"
          triggerClassName={modelPillTrigger}
          providers={providers}
          optionsByProvider={optionsByProvider}
          seedsByProvider={seedsByProvider}
          modelMetaByValue={modelMetaByValue}
          provider={provider}
          model={model}
          favoriteModels={favoriteModels}
          recentModels={recentModels}
          modelsWarning={modelsWarning}
          serviceTier={serviceTier}
          onModelChange={onModelChange}
          onToggleFavorite={onToggleFavorite}
          onServiceTierChange={onServiceTierChange}
          onRefreshCatalog={onRefreshCatalog}
          onBrowseProvider={onBrowseProvider}
          catalogLoading={catalogLoading}
          disabled={locked}
          focusInput={focusInput}
        />
        {imageReadyHint ? (
          <span
            className="hidden max-w-[9rem] shrink-0 truncate px-1 text-2xs text-tertiary @min-[560px]:inline"
            title={imageReadyHint}
          >
            {imageReadyHint}
          </span>
        ) : null}
      </div>

      {/* Right: thinking + context + send */}
      <div className={cn(zone, 'shrink-0 justify-end')}>
        <ThinkingControlsWithSteps
          metaStore={metaStore}
          usage={contextUsage}
          provider={provider}
          model={model}
          modelMeta={modelMeta}
          chatSettings={chatSettings}
          onChatSettingsChange={onChatSettingsChange}
          disabled={disabled}
          running={running}
          className="shrink-0"
        />
        <ContextMeterLeaf
          metaStore={metaStore}
          usage={contextUsage}
          modelWindow={modelWindow}
          compactionTriggerRatio={chatSettings.compactionTriggerRatio}
          onCompact={onCompactContext}
          compactDisabled={running}
        />
        {sendOrStop}
      </div>
    </div>
  )
}
