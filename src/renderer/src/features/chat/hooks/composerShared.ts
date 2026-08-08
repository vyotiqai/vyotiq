import { useCallback, useEffect, useState } from 'react'
import type { UiItem } from '@shared/transcript'
import type {
  AgentInteractionMode,
  AttachedAudio,
  AttachedFile,
  AttachedNativeFile,
  ChatMessage,
  ComposerSendExtras,
  ProviderId,
  ServiceTier
} from '@shared/ipc'
import {
  contentAudios,
  contentDisplayText,
  contentFiles,
  contentImages,
  contentNativeFiles
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { userMessageEditDraft } from '../utils/slashEditDraft'
import type { ChatMetaStore } from '../chatStores'
import type { IncompleteTurnState, PendingFollowUpState } from '@renderer/lib/hooks/createChatStreamController'
import type { ContextUsageState } from '../components/composer/ContextMeter'
import type { SlashClientHandlers } from '../components/composer/slashCommandExecute'

/** Suppress composer banner when transcript already shows a run_error row. */
export function useSuppressedChatError(
  items: readonly UiItem[],
  error: string | null
): string | null {
  const hasTranscriptRunError = items.some((item) => item.kind === 'run_error')
  return hasTranscriptRunError ? null : error
}

export type ComposerEditSeeds = {
  images?: string[]
  files?: AttachedFile[]
  audio?: AttachedAudio[]
  nativeFiles?: AttachedNativeFile[]
}

type SendFn = (
  text: string,
  images?: string[],
  files?: AttachedFile[],
  extras?: ComposerSendExtras
) => boolean | void | Promise<boolean | void>

/** Shared prompt-edit draft state for ChatView and SessionChatColumn. */
export function useComposerEditState(args: {
  surfaceKey: string
  messages: ChatMessage[]
  onSend: SendFn
  onEditAndResend?: (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onRevertToUserMessage?: (userMessageIndex: number) => boolean | Promise<boolean>
  onAfterRevert?: () => void
}) {
  const {
    surfaceKey,
    messages,
    onSend,
    onEditAndResend,
    onRevertToUserMessage,
    onAfterRevert
  } = args
  const [editingUserMessageIndex, setEditingUserMessageIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSeeds, setEditSeeds] = useState<ComposerEditSeeds>({})

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
      extras?: ComposerSendExtras
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
      if (ok !== false) onAfterRevert?.()
    },
    [onRevertToUserMessage, onAfterRevert]
  )

  const sendFromDock = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: ComposerSendExtras
    ) => {
      // Dock stays usable while editing; sending a new turn exits edit mode.
      if (editingUserMessageIndex != null) cancelPromptEdit()
      return onSend(text, images, files, extras)
    },
    [editingUserMessageIndex, cancelPromptEdit, onSend]
  )

  return {
    editingUserMessageIndex,
    editDraft,
    setEditDraft,
    editSeeds,
    editing: editingUserMessageIndex != null,
    cancelPromptEdit,
    beginPromptEdit,
    submitPromptEdit,
    beginPromptRevert,
    sendFromDock
  }
}

export type BuildComposerSendPropsInput = {
  provider: ProviderId
  model: string
  running: boolean
  hasWorkspace: boolean
  hasTranscript: boolean
  workspacePath: string | null
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  draft?: string
  onDraftChange?: (draft: string) => void
  onProviderModel: (provider: ProviderId, model: string) => void
  favoriteModels?: string[]
  recentModels?: string[]
  serviceTier?: ServiceTier
  onToggleFavorite?: (provider: ProviderId, model: string) => void
  onServiceTierChange?: (tier: ServiceTier) => void
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  agentMode?: AgentInteractionMode
  onAgentModeChange?: (mode: AgentInteractionMode) => void
  onSend: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void
  pendingFollowUps?: PendingFollowUpState[]
  onRemoveFollowUp?: (id: string) => void
  onEditFollowUp?: (id: string, text: string) => boolean | Promise<boolean>
  onSendFollowUpNow?: (id: string) => void
  runNotice?: string | null
  incomplete?: IncompleteTurnState | null
  onContinue?: () => void
  onContinueInAgent?: () => void
  errorCode?: string | null
  bannerError: string | null
  secondaryBannerError: string | null
  offlineHint?: string | null
  onClearOfflineQueue?: () => void
  networkWait?: {
    attempt: number
    maxAttempts: number
    retryInMs: number
    code?: string
  } | null
  activeRunId: string | null
  onDismissError?: () => void
  contextUsage?: ContextUsageState | null
  metaStore?: ChatMetaStore
  onCompactContext?: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  slashHandlers?: SlashClientHandlers
  sideRailPad?: boolean
  imageReadyHint?: string | null
  onFocus?: () => void
}

/** Shared dock/hero composer prop bag for ChatView and SessionChatColumn. */
export function buildComposerSendProps(input: BuildComposerSendPropsInput) {
  return {
    provider: input.provider,
    model: input.model,
    running: input.running,
    disabled: !input.hasWorkspace,
    hasTranscript: input.hasTranscript,
    hasWorkspace: input.hasWorkspace,
    ollamaBaseUrl: input.ollamaBaseUrl,
    customOpenAiBaseUrl: input.customOpenAiBaseUrl,
    modelsRefreshKey: input.modelsRefreshKey,
    draft: input.draft,
    onDraftChange: input.onDraftChange,
    workspacePath: input.workspacePath,
    onProviderModel: input.onProviderModel,
    favoriteModels: input.favoriteModels,
    recentModels: input.recentModels,
    serviceTier: input.serviceTier,
    onToggleFavorite: input.onToggleFavorite,
    onServiceTierChange: input.onServiceTierChange,
    chatSettings: input.chatSettings,
    onChatSettingsChange: input.onChatSettingsChange,
    agentMode: input.agentMode,
    onAgentModeChange: input.onAgentModeChange,
    onSend: input.onSend,
    onStop: input.onStop,
    pendingFollowUps: input.pendingFollowUps,
    onRemoveFollowUp: input.onRemoveFollowUp,
    onEditFollowUp: input.onEditFollowUp,
    onSendFollowUpNow: input.onSendFollowUpNow,
    runNotice: input.runNotice,
    incomplete: input.incomplete,
    onContinue: input.onContinue,
    onContinueInAgent: input.onContinueInAgent,
    onRetryNetwork: input.onContinue,
    errorCode: input.errorCode,
    bannerError: input.bannerError,
    secondaryBannerError: input.secondaryBannerError,
    offlineHint: input.offlineHint,
    onClearOfflineQueue: input.onClearOfflineQueue,
    networkWait: input.networkWait,
    activeRunId: input.activeRunId,
    onDismissError: input.onDismissError,
    contextUsage: input.metaStore ? undefined : input.contextUsage,
    metaStore: input.metaStore,
    onCompactContext: input.onCompactContext,
    slashHandlers: input.slashHandlers,
    sideRailPad: input.sideRailPad,
    imageReadyHint: input.imageReadyHint,
    ...(input.onFocus ? { onFocus: input.onFocus } : {})
  }
}
