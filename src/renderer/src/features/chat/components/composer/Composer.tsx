import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent
} from 'react'
import type {
  AgentInteractionMode,
  AttachedAudio,
  AttachedFile,
  AttachedNativeFile,
  ComposerSendExtras,
  ProviderId,
  SecretProvider,
  ServiceTier,
  SlashCommandDescriptor
} from '@shared/ipc'
import { buildUserContent } from '@shared/ipc'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { resolveSlashCommandForSubmit } from '@shared/slashCommands'
import { isRetryableTurnFailure } from '@shared/errors'
import { Alert, cn } from '@renderer/lib/ui'
import { isSessionDragEvent } from '@renderer/lib/chat/chatPaneLayout'
import {
  CHAT_COLUMN,
  CHAT_GUTTER,
  CHAT_STAGE_INSET,
  FLOATING_CHROME,
  FLOATING_CHROME_SHADOW_BOTTOM
} from '@renderer/lib/utils/layout'
import { ComposerMentionInput, type ComposerMentionInputHandle } from './ComposerMentionInput'
import { ComposerToolbar, type ComposerVariant } from './ComposerToolbar'
import { ComposerPlusButton } from './ComposerPlusButton'
import { ComposerAttachments } from './ComposerAttachments'
import {
  DictationErrorBanner,
  type DictationSettingsSection,
  type DictationStripState
} from './DictationSessionStrip'
import { useComposerDraft } from './useComposerDraft'
import { hasComposerContent } from './mentionModel'
import { useComposerImages, MAX_IMAGES } from './useComposerImages'
import { useComposerFiles, ATTACHMENT_ACCEPT, MAX_FILES, isImageFile } from './useComposerFiles'
import { useComposerAudio, isAudioFile } from './useComposerAudio'
import { useComposerDictation, type DictationPhase } from './useComposerDictation'
import { useComposerModels } from './useComposerModels'
import { pickAudioFallback, pickVisionFallback } from './composerModelUtils'
import {
  getWorkspaceHotUi,
  resolveHotComposerDraft,
  setWorkspaceHotComposerDraft,
  useWorkspaceHotComposerDraft
} from '@renderer/lib/hooks/workspaceHotUiStore'
import { composerAttachmentKey } from '@renderer/lib/hooks/composerAttachmentStore'
import { SlashCommandMenu } from './SlashCommandMenu'
import { useSlashCommands } from './useSlashCommands'
import { MentionMenu } from './MentionMenu'
import { useComposerMentions } from './useComposerMentions'
import { resolveComposerMentions } from './resolveMentions'
import { mentionMarker, type MentionMenuItem } from './mentionModel'
import {
  executeSlashResolveResult,
  type SlashClientHandlers
} from './slashCommandExecute'
import { resolveComposerPlaceholder } from './composerPlaceholder'
import { filesFromDataTransfer } from './dataTransferFiles'
import { focusComposerMessage, isMainComposerTarget } from '@renderer/lib/shortcuts'

const COMPOSER_FORM_LAYOUT = '@container relative grid gap-1 px-2.5 py-1'

function composerLayoutKind(variant: ComposerVariant): ComposerVariant {
  switch (variant) {
    case 'hero':
    case 'dock':
    case 'inline':
      return variant
    default: {
      const _exhaustive: never = variant
      return _exhaustive
    }
  }
}

function resolveDictationStripState(d: {
  phase: DictationPhase
  error: string | null
  errorAction: DictationSettingsSection | null
  elapsedMs: number
  waveform: readonly number[]
}): DictationStripState | null {
  switch (d.phase) {
    case 'checking':
      return { kind: 'checking', elapsedMs: d.elapsedMs, waveform: d.waveform }
    case 'recording':
      return { kind: 'listening', elapsedMs: d.elapsedMs, waveform: d.waveform }
    case 'transcribing':
      return { kind: 'transcribing', elapsedMs: d.elapsedMs, waveform: d.waveform }
    case 'idle':
      return d.error
        ? { kind: 'error', message: d.error, settingsSection: d.errorAction }
        : null
    default: {
      const _exhaustive: never = d.phase
      return _exhaustive
    }
  }
}

function notifyMcpUnavailable(
  command: SlashCommandDescriptor,
  handlers?: SlashClientHandlers
): void {
  const notice = command.description?.includes(' — ')
    ? command.description.split(' — ').slice(1).join(' — ')
    : command.availability === 'needs_auth'
      ? 'MCP server needs authentication — open Marketplace to connect.'
      : 'MCP server not connected — open Marketplace to reconnect.'
  handlers?.onNotice?.(notice)
  handlers?.onOpenMarketplace?.(command.mcpServerId)
}

export function Composer({
  provider,
  model,
  running,
  disabled,
  hasWorkspace,
  hasTranscript,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  modelsRefreshKey,
  secrets,
  draft,
  onDraftChange,
  workspacePath,
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
  onSend,
  onStop,
  pendingFollowUps = [],
  onRemoveFollowUp,
  onEditFollowUp,
  onSendFollowUpNow,
  composerPlaceholder,
  bannerError,
  secondaryBannerError,
  errorCode,
  onRetryNetwork,
  incomplete,
  activeRunId,
  contextUsage,
  metaStore,
  onCompactContext,
  onDismissError,
  trailing,
  variant = 'dock',
  sideRailPad = false,
  className,
  slashHandlers,
  seedImages,
  seedFiles,
  seedAudio,
  seedNativeFiles,
  onCancelEdit,
  onFocus,
  onEditLastUserMessage
}: {
  provider: ProviderId
  model: string
  running: boolean
  disabled?: boolean
  hasWorkspace?: boolean
  hasTranscript?: boolean
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  secrets: Record<SecretProvider, boolean>
  draft?: string
  onDraftChange?: (draft: string) => void
  /** When set, draft is read from the hot UI store (avoids App re-renders on keystrokes). */
  workspacePath?: string | null
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
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void
  pendingFollowUps?: import('@renderer/lib/hooks/createChatStreamController').PendingFollowUpState[]
  onRemoveFollowUp?: (id: string) => void
  onEditFollowUp?: (id: string, text: string) => boolean | Promise<boolean>
  onSendFollowUpNow?: (id: string) => void
  composerPlaceholder?: string
  bannerError?: string | null
  secondaryBannerError?: string | null
  errorCode?: string | null
  onRetryNetwork?: () => void
  incomplete?: import('@renderer/lib/hooks/createChatStreamController').IncompleteTurnState | null
  activeRunId?: string | null
  contextUsage?: import('./ContextMeter').ContextUsageState | null
  /** Prefer over contextUsage prop so meter patches do not re-render Composer. */
  metaStore?: import('../../chatStores').ChatMetaStore
  onCompactContext?: (
    focus?: string
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  onDismissError?: () => void
  /** Optional docked chrome below the shell. */
  trailing?: React.ReactNode
  variant?: ComposerVariant
  /** When false, use symmetric gutter (immersive Agent — no floating side rail). */
  sideRailPad?: boolean
  className?: string
  slashHandlers?: SlashClientHandlers
  /** One-shot attachment seed when mounting an inline edit composer. */
  seedImages?: string[]
  seedFiles?: AttachedFile[]
  seedAudio?: AttachedAudio[]
  seedNativeFiles?: AttachedNativeFile[]
  /** Escape / cancel while editing a prompt bubble. */
  onCancelEdit?: () => void
  onFocus?: () => void
  /** Dock only: ArrowUp on empty draft or caret at start edits the last user prompt. */
  onEditLastUserMessage?: () => boolean
}) {
  const taRef = useRef<ComposerMentionInputHandle>(null)
  const focusInput = useCallback(() => taRef.current?.focus(), [])
  const mentionAnchorRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const workspacePathRef = useRef(workspacePath)
  workspacePathRef.current = workspacePath
  const inputLocked = Boolean(disabled)
  const settingsLocked = Boolean(disabled || running)
  const runIdForDraft = activeRunId ?? null
  const hotDraft = useWorkspaceHotComposerDraft(workspacePath, runIdForDraft)
  // Inline edit keeps its own draft. Dock uses per-run hot UI when a workspace is bound.
  const useHotComposerDraft =
    variant !== 'inline' && Boolean(workspacePath)
  const resolvedDraft = useHotComposerDraft ? hotDraft : (draft ?? '')

  // On workspace/run switch, seed hot draft from the controlled prop so remounts and
  // pane focus never show a stale sibling-run draft (or empty hot while prop has text).
  const seedKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (variant === 'inline' || !workspacePath || draft === undefined) {
      return
    }
    const seedKey = `${workspacePath}::${runIdForDraft ?? ''}`
    if (seedKeyRef.current === seedKey) return
    seedKeyRef.current = seedKey
    const hot = getWorkspaceHotUi(workspacePath)
    const current = resolveHotComposerDraft(hot, runIdForDraft)
    if (current === draft) return
    // Prop may lag setContexts; never wipe a newer non-empty hot draft with ''.
    if (draft === '' && current !== '') return
    setWorkspaceHotComposerDraft(workspacePath, runIdForDraft, draft)
  }, [variant, workspacePath, runIdForDraft, draft])

  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(0)
  cursorRef.current = cursor
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null)
  const [editingFollowUpText, setEditingFollowUpText] = useState('')

  const syncCursor = useCallback((): void => {
    const handle = taRef.current
    if (handle) setCursor(handle.getSelectionStart())
  }, [])

  // Dock attachments survive remounts per workspace+run (same keying as hot drafts).
  const attachmentKey =
    variant === 'inline' ? null : composerAttachmentKey(workspacePath, runIdForDraft)

  const {
    images,
    setImages,
    imageError,
    setImageError,
    onPickImages,
    removeImage
  } = useComposerImages(attachmentKey)

  const preferNativePdfRef = useRef(false)

  const {
    files,
    setFiles,
    nativeFiles,
    setNativeFiles,
    fileError,
    setFileError,
    extracting,
    addFiles,
    removeFile,
    removeNativeFile
  } = useComposerFiles({
    getPreferNativePdf: () => preferNativePdfRef.current,
    persistKey: attachmentKey
  })

  const { audio, setAudio, audioError, addAudio, removeAudio } = useComposerAudio(attachmentKey)

  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    if (seedImages?.length) setImages(seedImages.slice(0, MAX_IMAGES))
    if (seedFiles?.length) setFiles(seedFiles.slice(0, MAX_FILES))
    if (seedAudio?.length) setAudio(seedAudio)
    if (seedNativeFiles?.length) setNativeFiles(seedNativeFiles)
  }, [seedImages, seedFiles, seedAudio, seedNativeFiles, setImages, setFiles, setAudio, setNativeFiles])

  const slash = useSlashCommands({
    workspacePath,
    text: resolvedDraft,
    cursor,
    enabled: !inputLocked && Boolean(hasWorkspace),
    onListError: slashHandlers?.onNotice
  })

  const mentions = useComposerMentions({
    workspacePath,
    text: resolvedDraft,
    cursor,
    enabled: !inputLocked && Boolean(hasWorkspace) && !slash.open
  })

  const onMentionAccept = useCallback(
    (item: MentionMenuItem) => {
      const result = mentions.acceptItem(item)
      if (!result) return
      if (result.action === 'navigate') {
        mentions.setView(result.view)
        return
      }
      if (result.action === 'show-more') {
        mentions.showMore()
        return
      }
      onDraftChange?.(result.nextText)
      setCursor(result.nextCursor)
      requestAnimationFrame(() => {
        taRef.current?.setSelectionStart(result.nextCursor)
        taRef.current?.focus()
      })
      mentions.dismiss()
    },
    [mentions, onDraftChange]
  )

  const sendWithMentions = useCallback(
    async (
      rawText: string,
      sendImages?: string[],
      sendFiles?: AttachedFile[],
      extras?: ComposerSendExtras
    ): Promise<boolean | void> => {
      try {
        const boundWorkspace = workspacePath
        const resolved = await resolveComposerMentions({
          workspacePath: boundWorkspace,
          draft: rawText,
          existingFiles: sendFiles ?? [],
          isCurrent: () => workspacePathRef.current === boundWorkspace
        })
        if (resolved.stale || workspacePathRef.current !== boundWorkspace) {
          return false
        }
        if (resolved.error) {
          setFileError(resolved.error)
          return false
        }
        const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
        if (
          !resolved.text.trim() &&
          !resolved.files.length &&
          !(sendImages?.length) &&
          !hasExtras
        ) {
          return false
        }
        return await onSend(
          resolved.text,
          sendImages?.length ? sendImages : undefined,
          resolved.files.length ? resolved.files : undefined,
          extras
        )
      } catch (err) {
        setFileError(err instanceof Error ? err.message : 'Send failed')
        return false
      }
    },
    [workspacePath, onSend, setFileError]
  )

  const resolveSlashSubmitCommand = useCallback(
    async (triggerOrId: string): Promise<SlashCommandDescriptor | null> => {
      const commands = await slash.ensureCommands()
      const byId = commands.find((c) => c.id === triggerOrId)
      if (byId) return byId
      return resolveSlashCommandForSubmit(triggerOrId, commands, slash.activeCommand)
    },
    [slash]
  )

  const resolveAndExecute = useCallback(
    async (
      command: SlashCommandDescriptor,
      trailingText: string,
      sendImages: string[],
      sendFiles: AttachedFile[],
      extras?: ComposerSendExtras
    ): Promise<boolean> => {
      if (!window.vyotiq?.slashCommandsResolve) return false

      if (command.availability === 'not_installed' && command.packageId) {
        await slashHandlers?.onMarketplaceAction?.(command.packageId, 'install')
        await slash.reload()
        return false
      }
      if (command.availability === 'disabled' && command.packageId) {
        await slashHandlers?.onMarketplaceAction?.(command.packageId, 'enable')
        await slash.reload()
        return false
      }
      if (
        command.availability === 'disconnected' ||
        command.availability === 'needs_auth'
      ) {
        notifyMcpUnavailable(command, slashHandlers)
        return false
      }

      // Trailing text may include @mention markers (skill chip submit / typed after /cmd).
      const boundWorkspace = workspacePath
      const resolvedTrailing = await resolveComposerMentions({
        workspacePath: boundWorkspace,
        draft: trailingText,
        existingFiles: sendFiles,
        isCurrent: () => workspacePathRef.current === boundWorkspace
      })
      if (resolvedTrailing.stale || workspacePathRef.current !== boundWorkspace) {
        return false
      }
      if (resolvedTrailing.error) {
        setFileError(resolvedTrailing.error)
        return false
      }

      const res = await window.vyotiq.slashCommandsResolve({
        id: command.id,
        workspacePath: workspacePath ?? null,
        trailingText: resolvedTrailing.text
      })
      if (!res.ok) {
        slashHandlers?.onNotice?.(res.error)
        return false
      }

      const outcome = await executeSlashResolveResult(res.data, {
        ...slashHandlers,
        onCompact: async (focus?: string) => {
          if (slashHandlers?.onCompact) {
            const r = await slashHandlers.onCompact(focus)
            return r !== false
          }
          if (onCompactContext) {
            const r = await onCompactContext(focus)
            return typeof r === 'object' && r && 'ok' in r ? r.ok !== false : r !== false
          }
          return false
        }
      })

      if (outcome === 'sent' && res.data.action === 'send') {
        const ok = await Promise.resolve(
          sendWithMentions(
            res.data.message,
            sendImages.length ? sendImages : undefined,
            resolvedTrailing.files.length ? resolvedTrailing.files : undefined,
            extras
          )
        )
        return ok !== false
      }
      if (outcome === 'pending') {
        await slash.reload()
        return false
      }
      if (outcome === 'failed') return false
      return true
    },
    [workspacePath, slashHandlers, onCompactContext, sendWithMentions, slash, setFileError]
  )

  const onSlashAccept = useCallback(
    (command: SlashCommandDescriptor): void => {
      // Marketplace / connectivity CTAs — do not insert or send.
      if (command.availability === 'not_installed' && command.packageId) {
        void Promise.resolve(
          slashHandlers?.onMarketplaceAction?.(command.packageId, 'install')
        ).then(() => {
          void slash.reload()
        })
        return
      }
      if (command.availability === 'disabled' && command.packageId) {
        void Promise.resolve(
          slashHandlers?.onMarketplaceAction?.(command.packageId, 'enable')
        ).then(() => {
          void slash.reload()
        })
        return
      }
      if (
        command.availability === 'disconnected' ||
        command.availability === 'needs_auth'
      ) {
        notifyMcpUnavailable(command, slashHandlers)
        return
      }

      // All slash kinds → chip; user adds trailing text then sends.
      const token = slash.token
      const before = token ? resolvedDraft.slice(0, token.start) : resolvedDraft
      const after = token
        ? resolvedDraft.slice(token.end).replace(/^\s+/, '')
        : ''
      const insertion = `${mentionMarker({
        kind: 'slash',
        slashKind: command.kind,
        trigger: command.trigger,
        commandId: command.id
      })} `
      const nextText = `${before}${insertion}${after}`
      const nextCursor = before.length + insertion.length
      onDraftChange?.(nextText)
      setCursor(nextCursor)
      requestAnimationFrame(() => {
        taRef.current?.setSelectionStart(nextCursor)
        taRef.current?.focus()
      })
      slash.dismiss()
    },
    [slash, resolvedDraft, onDraftChange, slashHandlers]
  )

  const onSlashSubmit = useCallback(
    async (
      command: SlashCommandDescriptor,
      trailingText: string,
      sendImages: string[],
      sendFiles: AttachedFile[],
      extras?: ComposerSendExtras
    ): Promise<boolean> => {
      return resolveAndExecute(command, trailingText, sendImages, sendFiles, extras)
    },
    [resolveAndExecute]
  )

  // Restore composer focus after a send. Runs for every submit path (Enter,
  // send button, slash) because the contentEditable never fires form submit.
  // The double rAF recovers focus after a hero → dock remount.
  const keepComposerFocus = useCallback((): void => {
    const active = document.activeElement
    const hadComposerFocus =
      (taRef.current?.el != null && active === taRef.current.el) ||
      isMainComposerTarget(active)
    if (!hadComposerFocus) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (focusComposerMessage()) return
        taRef.current?.focus()
      })
    })
  }, [])

  const { text, setText, canSend, submit, onKeyDown } = useComposerDraft({
    draft: resolvedDraft,
    onDraftChange,
    images,
    setImages,
    setImageError,
    files,
    setFiles,
    nativeFiles,
    setNativeFiles,
    audio,
    setAudio,
    setFileError,
    running,
    disabled,
    sendBlocked: extracting,
    onSend: sendWithMentions,
    slashMenuOpen: slash.open,
    slashActiveCommand: slash.activeCommand,
    onSlashMove: slash.moveActive,
    onSlashDismiss: slash.dismiss,
    onSlashAccept,
    onSlashSubmit,
    resolveSlashSubmitCommand,
    onSlashResolveError: setFileError,
    mentionMenuOpen: mentions.open,
    mentionActiveItem: mentions.activeItem,
    onMentionMove: (delta: number) => {
      const len = mentions.items.length
      if (!len) return
      mentions.setActiveIndex((i) => Math.max(0, Math.min(len - 1, i + delta)))
    },
    onMentionDismiss: mentions.dismiss,
    onMentionAccept,
    onMentionBack: mentions.goBack,
    onEditLastUserMessage: variant === 'dock' ? onEditLastUserMessage : undefined,
    onCancelEdit: variant === 'inline' ? onCancelEdit : undefined,
    getCaretStart: () => taRef.current?.getSelectionStart() ?? 0,
    onSubmitted: keepComposerFocus
  })

  const getDictationCaret = useCallback((): number => {
    const handle = taRef.current
    if (!handle) return cursorRef.current
    if (document.activeElement === handle.el) return handle.getSelectionStart()
    return cursorRef.current
  }, [])

  const setDictationCaret = useCallback((offset: number): void => {
    setCursor(offset)
    // Listening unmounts the editor; wait until it remounts after transcribe.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        taRef.current?.setSelectionStart(offset)
        taRef.current?.focus()
      })
    })
  }, [])

  const dictation = useComposerDictation({
    text,
    setText,
    secrets,
    disabled: Boolean(disabled),
    shortcutActive: true,
    isShortcutTarget: () => {
      const el = taRef.current?.el ?? null
      if (!el) return false
      const active = document.activeElement
      return active === el || el.contains(active)
    },
    focusComposer: () => taRef.current?.focus(),
    getCaret: getDictationCaret,
    setCaret: setDictationCaret
  })

  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [browsedProvider, setBrowsedProvider] = useState<ProviderId>(provider)

  useEffect(() => {
    setBrowsedProvider(provider)
  }, [provider])

  const {
    providers,
    optionsByProvider,
    seedsByProvider,
    modelMetaByValue,
    warningsByProvider,
    catalog,
    filterOpts,
    refreshCatalog,
    catalogLoading: catalogFetchLoading
  } = useComposerModels({
    provider,
    model,
    ollamaBaseUrl,
    customOpenAiBaseUrl,
    modelsRefreshKey,
    hasWorkspace,
    hasImages: images.length > 0,
    hasAudio: audio.length > 0,
    browsedProvider,
    secrets
  })

  preferNativePdfRef.current = Boolean(
    (
      modelMetaByValue?.[modelSelectionKey(provider, model)] ?? modelMetaByValue?.[model]
    )?.inputModalities?.includes('file')
  )

  const catalogLoading = catalogFetchLoading || refreshingCatalog

  const ensureVisionModel = useCallback((): void => {
    if (running) return
    const fallback = pickVisionFallback(catalog, model, {
      ...filterOpts,
      hasImages: true
    })
    if (fallback && fallback !== model) {
      onProviderModel(provider, fallback)
    }
  }, [running, catalog, model, filterOpts, onProviderModel, provider])

  const ensureAudioModel = useCallback((): void => {
    if (running) return
    const fallback = pickAudioFallback(catalog, model, {
      ...filterOpts,
      hasAudio: true
    })
    if (fallback && fallback !== model) {
      onProviderModel(provider, fallback)
    }
  }, [running, catalog, model, filterOpts, onProviderModel, provider])

  // Cover picker, draft restore, and any setImages path — not only onPickAttachments.
  useEffect(() => {
    if (images.length > 0) ensureVisionModel()
  }, [images.length, ensureVisionModel])

  useEffect(() => {
    if (audio.length > 0) ensureAudioModel()
  }, [audio.length, ensureAudioModel])

  const onPickAttachments = async (list: FileList | File[] | null): Promise<void> => {
    if (!list?.length) return
    const picked = Array.from(list)
    const imageFiles = picked.filter(isImageFile)
    const audioFiles = picked.filter((file) => !isImageFile(file) && isAudioFile(file))
    const documents = picked.filter((file) => !isImageFile(file) && !isAudioFile(file))
    if (imageFiles.length) await onPickImages(imageFiles)
    if (audioFiles.length) await addAudio(audioFiles)
    if (documents.length) await addFiles(documents)
  }

  const onAttachmentDragOver = (e: DragEvent<HTMLElement>): void => {
    if (inputLocked || !e.dataTransfer) return
    if (isSessionDragEvent(e.dataTransfer)) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onAttachmentDrop = (e: DragEvent<HTMLElement>): void => {
    if (inputLocked || !e.dataTransfer) return
    if (isSessionDragEvent(e.dataTransfer)) return
    const dropped = filesFromDataTransfer(e.dataTransfer)
    if (!dropped.length) return
    e.preventDefault()
    void onPickAttachments(dropped)
  }

  const layout = composerLayoutKind(variant)
  const isDock = layout === 'dock'
  const isInline = layout === 'inline'

  useLayoutEffect(() => {
    if (isInline) taRef.current?.focus()
  }, [isInline])

  const sendDisabledReason = !canSend
    ? disabled
      ? hasWorkspace
        ? 'Sending is unavailable right now.'
        : 'Open a workspace to send a message.'
      : extracting
        ? 'Finish processing the attachment before sending.'
        : fileError || imageError || audioError
          ? 'Resolve the attachment issue before sending.'
          : isInline
            ? 'Enter a replacement message to resend.'
            : 'Type a message or attach a file to send.'
    : null

  const hasContent =
    hasComposerContent(text) ||
    images.length > 0 ||
    files.length > 0 ||
    nativeFiles.length > 0 ||
    audio.length > 0

  const slashListId = `slash-command-menu-${variant}`
  const mentionListId = `composer-mention-menu-${variant}`

  const dictationStripState = resolveDictationStripState({
    phase: dictation.phase,
    error: dictation.error,
    errorAction: dictation.errorAction,
    elapsedMs: dictation.elapsedMs,
    waveform: dictation.waveform
  })

  const dictationActive =
    dictationStripState?.kind === 'checking' ||
    dictationStripState?.kind === 'listening' ||
    dictationStripState?.kind === 'transcribing'

  const openAttach = (): void => {
    slash.dismiss()
    mentions.dismiss()
    if (images.length >= MAX_IMAGES && files.length >= MAX_FILES) {
      setImageError(`You can attach up to ${MAX_IMAGES} images and ${MAX_FILES} files.`)
      return
    }
    fileRef.current?.click()
  }

  const plusButton = (
    <ComposerPlusButton
      disabled={inputLocked}
      attachFull={images.length >= MAX_IMAGES && files.length >= MAX_FILES}
      onAttach={openAttach}
    />
  )

  const composerShellChrome = cn(
    FLOATING_CHROME,
    FLOATING_CHROME_SHADOW_BOTTOM,
    isDock && 'pointer-events-auto'
  )

  const showRetry =
    Boolean(onRetryNetwork) &&
    isRetryableTurnFailure({ errorCode, incompleteReason: incomplete?.reason })

  const composerFields = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          void onPickAttachments(e.target.files)
          e.target.value = ''
        }}
      />

      {pendingFollowUps.length > 0 ? (
        <div
          className="col-span-full flex flex-col gap-1.5"
          data-follow-up-queue
          aria-label="Queued follow-ups"
        >
          {pendingFollowUps.map((entry) => {
            const isEditing = editingFollowUpId === entry.id
            const queueAction =
              'shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium text-muted vy-transition hover:bg-surface hover:text-fg'
            return (
              <div
                key={entry.id}
                className="flex flex-wrap items-start gap-2 rounded-lg border border-border/60 bg-surface-2 px-2 py-1.5 text-caption"
              >
                {isEditing ? (
                  <>
                    <textarea
                      className="min-h-[32px] min-w-[12rem] flex-1 resize-y rounded-md border border-border bg-bg px-2 py-1 text-md leading-snug text-fg"
                      value={editingFollowUpText}
                      onChange={(e) => setEditingFollowUpText(e.target.value)}
                      aria-label="Edit queued follow-up"
                      rows={2}
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className={queueAction}
                        aria-label="Save queued follow-up edit"
                        disabled={!editingFollowUpText.trim()}
                        onClick={async () => {
                          const trimmed = editingFollowUpText.trim()
                          if (!trimmed) return
                          const ok = onEditFollowUp ? await onEditFollowUp(entry.id, trimmed) : true
                          if (ok) setEditingFollowUpId(null)
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className={queueAction}
                        aria-label="Cancel queued follow-up edit"
                        onClick={() => setEditingFollowUpId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 text-fg" title={entry.text}>
                      {entry.preview}
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {onEditFollowUp ? (
                        <button
                          type="button"
                          className={queueAction}
                          aria-label="Edit queued follow-up"
                          onClick={() => {
                            setEditingFollowUpId(entry.id)
                            setEditingFollowUpText(entry.text)
                          }}
                        >
                          Edit
                        </button>
                      ) : null}
                      {onSendFollowUpNow ? (
                        <button
                          type="button"
                          className={queueAction}
                          aria-label="Send queued follow-up now"
                          onClick={() => onSendFollowUpNow(entry.id)}
                        >
                          Send now
                        </button>
                      ) : null}
                      {onRemoveFollowUp ? (
                        <button
                          type="button"
                          className={cn(queueAction, 'hover:text-danger')}
                          aria-label="Remove queued follow-up"
                          onClick={() => onRemoveFollowUp(entry.id)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      <ComposerAttachments
        images={images}
        imageError={imageError}
        files={files}
        nativeFiles={nativeFiles}
        audio={audio}
        fileError={fileError}
        audioError={audioError}
        extracting={extracting}
        attachLocked={inputLocked}
        onRemove={removeImage}
        onRemoveFile={removeFile}
        onRemoveNativeFile={removeNativeFile}
        onRemoveAudio={removeAudio}
      />

      {dictationStripState?.kind === 'error' ? (
        <DictationErrorBanner
          message={dictationStripState.message}
          settingsSection={dictationStripState.settingsSection}
          onDismiss={() => dictation.setError(null)}
          onOpenSettings={slashHandlers?.onOpenSettings}
        />
      ) : null}

      {!dictationActive && (
        <div ref={mentionAnchorRef} className="col-span-full min-w-0 w-full">
          <ComposerMentionInput
            ref={taRef}
            className="min-h-7 w-full min-w-0 border-0 bg-transparent p-0 text-md leading-snug shadow-none focus-visible:ring-0"
            value={text}
            onChange={(next) => {
              setText(next)
              requestAnimationFrame(syncCursor)
            }}
            onKeyDown={(e) => {
              onKeyDown(e)
              requestAnimationFrame(syncCursor)
            }}
            onCaretChange={(offset) => setCursor(offset)}
            onPasteFiles={(files) => {
              void onPickAttachments(files)
            }}
            placeholder={resolveComposerPlaceholder({
              hasWorkspace: Boolean(hasWorkspace),
              running,
              agentMode,
              hasTranscript: Boolean(hasTranscript),
              override: composerPlaceholder
            })}
            disabled={inputLocked}
            onFocus={onFocus}
            aria-expanded={slash.open || mentions.open}
            aria-controls={
              slash.open
                ? slashListId
                : mentions.open
                  ? mentionListId
                  : undefined
            }
            aria-autocomplete={slash.open || mentions.open ? 'list' : undefined}
            aria-activedescendant={
              slash.open && slash.activeCommand
                ? `${slashListId}-opt-${slash.activeCommand.id}`
                : mentions.open && mentions.activeItem
                  ? `${mentionListId}-opt-${mentions.activeItem.id}`
                  : undefined
            }
          />
        </div>
      )}
      <ComposerToolbar
        variant={variant}
        disabled={disabled}
        locked={settingsLocked}
        plus={plusButton}
        providers={providers}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={modelMetaByValue}
        provider={provider}
        model={model}
        favoriteModels={favoriteModels}
        recentModels={recentModels}
        warningsByProvider={warningsByProvider}
        serviceTier={serviceTier}
        onModelChange={onProviderModel}
        onToggleFavorite={onToggleFavorite}
        onServiceTierChange={onServiceTierChange}
        onRefreshCatalog={() => {
          setRefreshingCatalog(true)
          void refreshCatalog({ forceRefresh: true, provider: browsedProvider }).finally(() =>
            setRefreshingCatalog(false)
          )
        }}
        onBrowseProvider={setBrowsedProvider}
        catalogLoading={catalogLoading}
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
        agentMode={agentMode}
        onAgentModeChange={onAgentModeChange}
        running={running}
        canSend={canSend}
        hasContent={hasContent}
        sendDisabledReason={sendDisabledReason}
        onStop={onStop}
        contextUsage={contextUsage}
        metaStore={metaStore}
        onCompactContext={onCompactContext}
        onCancelEdit={isInline ? onCancelEdit : undefined}
        focusInput={focusInput}
        dictationPhase={dictation.phase}
        dictationEngineHint={dictation.engineHint}
        onDictationToggle={dictation.toggle}
        dictationWaveform={dictation.waveform}
        dictationElapsedMs={dictation.elapsedMs}
        dictationWaveformStyle={dictation.waveformStyle}
        onDictationCancel={dictation.cancel}
      />

          {!dictationActive ? (
            <>
              <SlashCommandMenu
                open={slash.open}
                commands={slash.filtered}
                activeIndex={slash.activeIndex}
                onActiveIndexChange={slash.setActiveIndex}
                onPick={onSlashAccept}
                onDismiss={slash.dismiss}
                anchorRef={mentionAnchorRef}
                listId={slashListId}
                loading={slash.loading}
                listError={slash.listError}
              />

              <MentionMenu
                open={mentions.open}
                view={mentions.view}
                items={mentions.items}
                activeIndex={mentions.activeIndex}
                onActiveIndexChange={mentions.setActiveIndex}
                onPick={onMentionAccept}
                onDismiss={mentions.dismiss}
                onBack={mentions.goBack}
                anchorRef={mentionAnchorRef}
                listId={mentionListId}
                loading={mentions.loading}
              />
            </>
          ) : null}
    </>
  )

  return (
    <div
      className={cn(
        isDock
          ? // In-flow dock under the transcript — never overlays plan/chat text.
            // Scrollbar-gutter matches the transcript; side-rail pad clears the rail.
            'shrink-0 overflow-x-hidden overflow-y-hidden pb-2 pt-1 [scrollbar-gutter:stable]'
          : 'shrink-0 w-full pb-0 pt-0',
        isDock ? (sideRailPad ? CHAT_STAGE_INSET : CHAT_GUTTER) : '',
        className
      )}
      data-composer-dock={isDock ? true : undefined}
      data-composer-side-rail-pad={isDock && sideRailPad ? '1' : '0'}
      data-composer-hero={variant === 'hero' ? true : undefined}
      data-composer-inline={isInline ? true : undefined}
    >
      <div
        className={cn(isDock && CHAT_COLUMN, 'flex flex-col gap-2')}
        data-composer-column={isDock ? true : undefined}
      >
        {(isDock || isInline) && (bannerError || secondaryBannerError) ? (
          <div className="pointer-events-auto flex shrink-0 flex-col gap-2">
            {secondaryBannerError ? (
              <Alert className="shrink-0">{secondaryBannerError}</Alert>
            ) : null}
            {bannerError ? (
              <Alert className="shrink-0" onDismiss={onDismissError}>
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{bannerError}</span>
                  {showRetry ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-xl border border-border px-2 py-0.5 text-caption font-medium text-fg transition-colors hover:bg-surface"
                      onClick={onRetryNetwork}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              </Alert>
            ) : null}
          </div>
        ) : null}

        {isDock ? (
          <div className="flex min-w-0 flex-col">
            <div
              className={composerShellChrome}
              data-composer-shell
              onDragOver={onAttachmentDragOver}
              onDrop={onAttachmentDrop}
            >
              <form
                onSubmit={submit}
                className={COMPOSER_FORM_LAYOUT}
              >
                {composerFields}
              </form>
            </div>
            {trailing}
          </div>
        ) : (
          <form
            onSubmit={submit}
            className={cn(COMPOSER_FORM_LAYOUT, composerShellChrome)}
            data-composer-shell
            onDragOver={onAttachmentDragOver}
            onDrop={onAttachmentDrop}
          >
            {composerFields}
          </form>
        )}
      </div>
    </div>
  )
}

export { buildUserContent }
