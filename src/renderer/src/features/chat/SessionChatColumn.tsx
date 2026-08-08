import type { Ref } from 'react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type {
  AgentInteractionMode,
  AttachedFile,
  ChatMessage,
  ProviderId,
  ToolApprovalDecision
} from '@shared/ipc'
import {
  contentAudios,
  contentDisplayText,
  contentFiles,
  contentImages,
  contentNativeFiles
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { Composer } from './components/composer'
import { ChatGitLeading, useChatLiveItems, useHasChatItems } from './components/ChatStreamLeaves'
import { useGitChrome } from './components/GitChrome'
import { useGitRevision } from './components/ChatStreamLeaves'
import { RunSessionProvider } from './RunSessionContext'
import { MessageList } from './components/MessageList'
import { userMessageEditDraft } from './utils/slashEditDraft'
import { Alert } from '@renderer/lib/ui'
import { CHAT_COLUMN, CHAT_GUTTER } from '@renderer/lib/utils/layout'
import { cn } from '@renderer/lib/ui/cn'
import { useNetworkStatus } from '@renderer/lib/hooks/useNetworkStatus'
import type { ChatItemsStore, ChatMetaStore } from './chatStores'

const MemoComposer = memo(Composer)

export function SessionChatColumn({
  items,
  itemsStore,
  metaStore,
  running,
  invokeId = null,
  pendingRun = false,
  error,
  errorCode = null,
  networkWait = null,
  runNotice,
  incomplete,
  onContinue,
  contextUsage,
  onCompactContext,
  operationalError,
  hasWorkspace,
  workspacePath,
  provider,
  model,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  modelsRefreshKey,
  activeRunId,
  transcriptLoading,
  headingRef,
  onProviderModel,
  favoriteModels = [],
  recentModels = [],
  serviceTier = 'default',
  onToggleFavorite = () => {},
  onServiceTierChange = () => {},
  chatSettings,
  onChatSettingsChange,
  agentMode = 'agent',
  onAgentModeChange = () => {},
  onContinueInAgent,
  onSend,
  onStop,
  onEditAndResend,
  onRevertToUserMessage,
  messages = [],
  pendingFollowUps = [],
  onRemoveFollowUp,
  onEditFollowUp,
  onSendFollowUpNow,
  onDismissError,
  composerDraft,
  onComposerDraftChange,
  restoreScrollTop,
  scrollRestoreToken,
  onScrollTopChange,
  onLoadToolContent,
  onThinkingToggle,
  onToolToggle,
  onGroupToggle,
  onTurnToggle,
  onApprovalDecision,
  onQuestionSubmit,
  collapsedTurns,
  showThinking = true,
  chatSurfaceEpoch = 0,
  mcpServerNames,
  slashHandlers,
  sideRailPad = false,
  imageReadyHint = null,
  onOpenChanges,
  onOpenUncommittedChanges
}: {
  items: UiItem[]
  itemsStore?: ChatItemsStore
  metaStore?: ChatMetaStore
  running: boolean
  invokeId?: number | null
  pendingRun?: boolean
  error: string | null
  errorCode?: string | null
  networkWait?: {
    attempt: number
    maxAttempts: number
    retryInMs: number
    code?: string
  } | null
  runNotice?: string | null
  incomplete?: import('@renderer/lib/hooks/createChatStreamController').IncompleteTurnState | null
  onContinue?: () => void
  contextUsage?: import('./components/composer/ContextMeter').ContextUsageState | null
  onCompactContext?: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  operationalError?: string | null
  hasWorkspace: boolean
  workspacePath: string | null
  provider: ProviderId
  model: string
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  activeRunId: string | null
  transcriptLoading?: boolean
  headingRef?: Ref<HTMLHeadingElement>
  onProviderModel: (provider: ProviderId, model: string) => void
  favoriteModels?: string[]
  recentModels?: string[]
  serviceTier?: import('@shared/ipc').ServiceTier
  onToggleFavorite?: (provider: ProviderId, model: string) => void
  onServiceTierChange?: (tier: import('@shared/ipc').ServiceTier) => void
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  agentMode?: AgentInteractionMode
  onAgentModeChange?: (mode: AgentInteractionMode) => void
  onContinueInAgent?: () => void
  onSend: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void
  onEditAndResend?: (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onRevertToUserMessage?: (userMessageIndex: number) => boolean | Promise<boolean>
  messages?: ChatMessage[]
  pendingFollowUps?: import('@renderer/lib/hooks/createChatStreamController').PendingFollowUpState[]
  onRemoveFollowUp?: (id: string) => void
  onEditFollowUp?: (id: string, text: string) => boolean | Promise<boolean>
  onSendFollowUpNow?: (id: string) => void
  onDismissError?: () => void
  composerDraft?: string
  onComposerDraftChange?: (draft: string) => void
  restoreScrollTop?: number
  scrollRestoreToken?: number
  onScrollTopChange?: (scrollTop: number) => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  onThinkingToggle?: (messageId: string, expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onGroupToggle?: (anchorToolCallId: string, expanded: boolean) => void
  onTurnToggle?: (turnIndex: number) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  collapsedTurns?: ReadonlySet<number>
  showThinking?: boolean
  chatSurfaceEpoch?: number
  mcpServerNames?: ReadonlyMap<string, string>
  slashHandlers?: import('./components/composer/slashCommandExecute').SlashClientHandlers
  sideRailPad?: boolean
  imageReadyHint?: string | null
  onOpenChanges?: () => void
  onOpenUncommittedChanges?: () => void
}) {
  const hasItems = useHasChatItems(itemsStore, items)
  const liveItems = useChatLiveItems(itemsStore, items)
  const { offlineHint } = useNetworkStatus()
  const hasTranscriptRunError = liveItems.some((item) => item.kind === 'run_error')
  const chatBannerError = hasTranscriptRunError ? null : error
  const operationalBannerError = operationalError ?? null
  const turnFailed =
    incomplete?.reason === 'network_interrupted' ||
    errorCode === 'PROVIDER_NETWORK' ||
    errorCode === 'PROVIDER_STREAM'
  const turnFailureLabel =
    incomplete?.message ?? (turnFailed ? (error ?? 'Connection lost') : null)
  const showHero = !hasItems && !activeRunId && !transcriptLoading
  const surfaceKey = `${workspacePath ?? 'none'}:${chatSurfaceEpoch}:${activeRunId ?? 'draft'}`
  const [gitRevision, bumpGitRevision] = useGitRevision(workspacePath, running, liveItems)
  const gitChrome = useGitChrome(workspacePath, gitRevision, Boolean(workspacePath))
  const notifyGitMutated = useCallback(() => {
    gitChrome.refresh()
    bumpGitRevision()
  }, [gitChrome, bumpGitRevision])

  const [editingUserMessageIndex, setEditingUserMessageIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSeeds, setEditSeeds] = useState<{
    images?: string[]
    files?: AttachedFile[]
    audio?: import('@shared/ipc').AttachedAudio[]
    nativeFiles?: import('@shared/ipc').AttachedNativeFile[]
  }>({})

  useEffect(() => {
    setEditingUserMessageIndex(null)
    setEditDraft('')
    setEditSeeds({})
  }, [surfaceKey])

  const cancelPromptEdit = useCallback(() => {
    setEditingUserMessageIndex(null)
    setEditDraft('')
    setEditSeeds({})
  }, [])

  const beginPromptEdit = useCallback(
    (messageIndex: number) => {
      const msg = messages[messageIndex]
      if (!msg || msg.role !== 'user') return
      const images = contentImages(msg.content)
      const files = contentFiles(msg.content)
      const audio = contentAudios(msg.content)
      const nativeFiles = contentNativeFiles(msg.content)
      const rawText = contentDisplayText(msg.content)
      setEditDraft(userMessageEditDraft(rawText))
      setEditSeeds({
        images: images.length ? images : undefined,
        files: files.length ? files : undefined,
        audio: audio.length ? audio : undefined,
        nativeFiles: nativeFiles.length ? nativeFiles : undefined
      })
      setEditingUserMessageIndex(messageIndex)
    },
    [messages]
  )

  const submitPromptEdit = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: import('@shared/ipc').ComposerSendExtras
    ) => {
      if (editingUserMessageIndex == null || !onEditAndResend) return false
      const index = editingUserMessageIndex
      cancelPromptEdit()
      return onEditAndResend(index, text, images, files, extras)
    },
    [editingUserMessageIndex, onEditAndResend, cancelPromptEdit]
  )

  const beginPromptRevert = useCallback(
    async (messageIndex: number) => {
      if (!onRevertToUserMessage) return
      const confirmed = window.confirm(
        'Revert to this prompt? File changes and messages after it will be removed.'
      )
      if (!confirmed) return
      const ok = await onRevertToUserMessage(messageIndex)
      if (ok !== false) notifyGitMutated()
    },
    [onRevertToUserMessage, notifyGitMutated]
  )

  const editing = editingUserMessageIndex != null

  const editComposer =
    editing && onEditAndResend ? (
      <MemoComposer
        key={`edit-composer:${surfaceKey}:${editingUserMessageIndex}`}
        provider={provider}
        model={model}
        running={running}
        disabled={!hasWorkspace}
        hasTranscript
        hasWorkspace={hasWorkspace}
        workspacePath={workspacePath}
        ollamaBaseUrl={ollamaBaseUrl}
        customOpenAiBaseUrl={customOpenAiBaseUrl}
        modelsRefreshKey={modelsRefreshKey}
        draft={editDraft}
        onDraftChange={setEditDraft}
        onProviderModel={onProviderModel}
        favoriteModels={favoriteModels}
        recentModels={recentModels}
        serviceTier={serviceTier}
        onToggleFavorite={onToggleFavorite}
        onServiceTierChange={onServiceTierChange}
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
        agentMode={agentMode}
        onAgentModeChange={onAgentModeChange}
        onSend={submitPromptEdit}
        onStop={onStop}
        activeRunId={activeRunId}
        contextUsage={metaStore ? undefined : contextUsage}
        metaStore={metaStore}
        onCompactContext={onCompactContext}
        slashHandlers={slashHandlers}
        variant="inline"
        bannerError={chatBannerError}
        secondaryBannerError={operationalBannerError}
        errorCode={errorCode}
        onRetryNetwork={onContinue}
        offlineHint={offlineHint}
        onDismissError={onDismissError}
        className="w-full"
        seedImages={editSeeds.images}
        seedFiles={editSeeds.files}
        seedAudio={editSeeds.audio}
        seedNativeFiles={editSeeds.nativeFiles}
        onCancelEdit={cancelPromptEdit}
        composerPlaceholder="Edit message…"
      />
    ) : null

  const sendFromDock = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: import('@shared/ipc').ComposerSendExtras
    ) => {
      if (editingUserMessageIndex != null) cancelPromptEdit()
      return onSend(text, images, files, extras)
    },
    [editingUserMessageIndex, cancelPromptEdit, onSend]
  )

  const composerProps = {
    provider,
    model,
    running,
    disabled: !hasWorkspace,
    hasTranscript: hasItems,
    hasWorkspace,
    ollamaBaseUrl,
    customOpenAiBaseUrl,
    modelsRefreshKey,
    draft: composerDraft,
    onDraftChange: onComposerDraftChange,
    workspacePath,
    onProviderModel,
    favoriteModels,
    recentModels,
    serviceTier,
    onToggleFavorite,
    onServiceTierChange,
    chatSettings,
    onChatSettingsChange,
    agentMode,
    onAgentModeChange,
    onSend: sendFromDock,
    onStop,
    pendingFollowUps,
    onRemoveFollowUp,
    onEditFollowUp,
    onSendFollowUpNow,
    runNotice,
    incomplete,
    onContinue,
    onContinueInAgent,
    onRetryNetwork: onContinue,
    errorCode,
    bannerError: chatBannerError,
    secondaryBannerError: operationalBannerError,
    offlineHint,
    networkWait,
    activeRunId,
    onDismissError,
    contextUsage: metaStore ? undefined : contextUsage,
    metaStore,
    onCompactContext,
    slashHandlers,
    sideRailPad,
    imageReadyHint
  }

  const runSession = useMemo(
    () => ({
      workspacePath: workspacePath ?? null,
      runId: activeRunId ?? null,
      agentMode
    }),
    [workspacePath, activeRunId, agentMode]
  )

  return (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="sr-only">
        Vyotiq chat
      </h1>
      {showHero ? (
        <div
          className={cn('flex min-h-0 flex-1 flex-col items-center justify-center', CHAT_GUTTER)}
          role="status"
        >
          {chatBannerError || operationalBannerError ? (
            <div className={cn('mb-4 flex w-full flex-col gap-2', CHAT_COLUMN)}>
              {operationalBannerError ? (
                <Alert className="w-full">{operationalBannerError}</Alert>
              ) : null}
              {chatBannerError ? (
                <Alert className="w-full" onDismiss={onDismissError}>
                  {chatBannerError}
                </Alert>
              ) : null}
            </div>
          ) : null}
          <div className={cn('w-full animate-fade-in', CHAT_COLUMN)} data-composer-hero>
            <MemoComposer
              key={`composer:${surfaceKey}`}
              {...composerProps}
              variant="hero"
              className="w-full"
            />
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col" data-chat-stage>
          <RunSessionProvider value={runSession}>
            <MessageList
              key={`transcript:${surfaceKey}`}
              items={liveItems}
              pendingRun={pendingRun}
              running={running}
              networkWait={networkWait}
              turnFailed={turnFailed}
              turnFailureLabel={turnFailureLabel}
              transcriptLoading={transcriptLoading}
              restoreScrollTop={restoreScrollTop}
              scrollRestoreToken={scrollRestoreToken}
              onScrollTopChange={onScrollTopChange}
              onLoadToolContent={onLoadToolContent}
              onThinkingToggle={onThinkingToggle}
              onToolToggle={onToolToggle}
              onGroupToggle={onGroupToggle}
              onTurnToggle={onTurnToggle}
              onApprovalDecision={onApprovalDecision}
              onQuestionSubmit={onQuestionSubmit}
              collapsedTurns={collapsedTurns}
              showThinking={showThinking}
              mcpServerNames={mcpServerNames}
              onOpenChanges={onOpenChanges}
              sideRailPad={sideRailPad}
              editingUserMessageIndex={editingUserMessageIndex}
              editComposer={editComposer}
              onBeginEditUserMessage={onEditAndResend ? beginPromptEdit : undefined}
              onRevertUserMessage={onRevertToUserMessage ? beginPromptRevert : undefined}
              messageCount={messages.length}
            />
          </RunSessionProvider>
          {!editing ? (
            <MemoComposer
              key={`composer:${surfaceKey}`}
              {...composerProps}
              variant="dock"
              onDismissError={onDismissError}
              leading={
                onOpenUncommittedChanges ? (
                  <ChatGitLeading chrome={gitChrome} onOpenChanges={onOpenUncommittedChanges} />
                ) : undefined
              }
            />
          ) : null}
        </div>
      )}
    </>
  )
}
