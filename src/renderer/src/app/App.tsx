import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './AppShell'
import { ChatView } from '../features/chat/ChatView'
import { SessionChatColumn } from '../features/chat/SessionChatColumn'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'
import { SettingsView, type SettingsSection } from '../features/settings'
import { MarketplaceView } from '../features/marketplace'
import { useTheme } from '@renderer/lib/hooks/useTheme'
import { useSettings } from '@renderer/lib/hooks/useSettings'
import { useWorkspaceManager, resolveComposerDraft } from '@renderer/lib/hooks/useWorkspaceManager'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { ToastHost, pushToast } from '@renderer/lib/ui'
import type { ProviderId, SecretProvider, ServiceTier, AttachedFile } from '@shared/ipc'
import { defaultModelFor } from '@shared/providers'
import {
  resolveEffectiveSettings,
  type ChatSettingsPatch
} from '@shared/effectiveSettings'
import {
  DEFAULT_THINKING_PREFS,
  modelSelectionKey,
  pushRecentModel,
  resolveServiceTier
} from '@shared/domain/modelSelection'
import { resolveImageReadyLabel } from '@shared/domain/imageCapability'
import { logger } from '@shared/logger'
import { workspacePathsEqual, findByWorkspacePath } from '@shared/workspacePathMatch'
import { normalizeRelPath } from '../features/chat/utils/turnFileDiffs'

/** Sent as a visible user turn when resuming a run that was cut short. */
const CONTINUE_PROMPT = 'Continue from where you stopped.'

export function App() {
  const {
    settings,
    secrets,
    encryptionAvailable,
    loading,
    refresh,
    update,
    saveSecret,
    removeSecret,
    pickWorkspace,
    error: settingsError,
    setError: setSettingsError
  } = useSettings()
  const { setTheme, hydrate } = useTheme(settings.theme)
  const workspace = useWorkspaceManager()
  const {
    registry,
    activeWorkspace,
    openWorkspaces,
    activeContext,
    contexts,
    activeRuns,
    chat,
    chatActions,
    onLoadToolContent,
    onThinkingToggle,
    onToolToggle,
    onGroupToggle,
    onTurnToggle,
    onApprovalDecision,
    onQuestionSubmit,
    collapsedTurns,
    openRunTab,
    openRunInWorkspace,
    closeRunTab,
    purgeDeletedRunUi,
    setSessionQuery,
    addWorkspace,
    switchWorkspace,
    removeWorkspace,
    getRunController,
    loadRunIntoTab: loadRunTranscriptIntoTab,
    refreshActiveRuns,
    refreshWorkspaceRuns,
    workspaceHasBackgroundRun,
    scrollRestoreToken,
    setComposerDraft,
    setComposerDraftForPane,
    setAgentMode,
    onMessageListScroll,
    onMessageListScrollForPane,
    setPaneCapacityContext,
    setSettingsOverride,
    workspaceError,
    clearWorkspaceError,
    clearRunsError,
    activeScrollTop,
    chatSurfaceEpoch,
    paneLayout,
    focusPaneById,
    closePaneById,
    setPaneSizesByIndex,
    dropSessionOnPane,
    isSessionOpenInPane,
    isSessionFocusedInPane,
    getPaneChatSnapshot,
    focusedWorkspacePath
  } = workspace

  const [view, setView] = useState<'chat' | 'settings' | 'marketplace'>('chat')
  const [marketplaceFocusServerId, setMarketplaceFocusServerId] = useState<string | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [modelsRefreshNonce, setModelsRefreshNonce] = useState(0)
  const chatHeadingRef = useRef<HTMLHeadingElement>(null)
  const settingsBackRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const focusWhenRendered = (el: HTMLElement | null): void => {
      if (!el) return
      requestAnimationFrame(() => requestAnimationFrame(() => el.focus()))
    }
    if (view === 'settings') {
      focusWhenRendered(settingsBackRef.current)
    } else if (view === 'marketplace') {
      // MarketplaceView focuses its Close control on mount.
    } else if (view === 'chat') {
      focusWhenRendered(chatHeadingRef.current)
    }
  }, [view])

  useLayoutEffect(() => {
    hydrate(settings.theme)
  }, [settings.theme, hydrate])

  const onProviderModel = (provider: ProviderId, model: string): void => {
    const resolvedModel = model || defaultModelFor(provider)
    const key = modelSelectionKey(provider, resolvedModel)
    const recentModels = pushRecentModel(settings.recentModels, key)
    const prefs = settings.thinkingPrefsByProvider[provider] ?? DEFAULT_THINKING_PREFS
    const serviceTier = settings.serviceTierByModel[key] ?? 'default'

    const globalPatch = {
      recentModels,
      thinkingEnabled: prefs.thinkingEnabled,
      thinkingEffort: prefs.thinkingEffort,
      serviceTier
    }

    const override = activeContext?.settingsOverride
    if (override?.useOverride && activeWorkspace) {
      void setSettingsOverride(activeWorkspace, {
        ...override,
        useOverride: true,
        provider,
        model: resolvedModel,
        thinkingEnabled: prefs.thinkingEnabled,
        thinkingEffort: prefs.thinkingEffort
      }).then((res) => {
        if (!res.ok) setSettingsError(res.error)
      })
      void update(globalPatch)
      return
    }
    void update({
      provider,
      model: resolvedModel,
      ...globalPatch
    })
  }

  const onToggleFavorite = (provider: ProviderId, model: string): void => {
    const key = modelSelectionKey(provider, model)
    const set = new Set(settings.favoriteModels)
    if (set.has(key)) set.delete(key)
    else set.add(key)
    void update({ favoriteModels: [...set] })
  }

  const onServiceTierChange = (tier: ServiceTier): void => {
    const key = modelSelectionKey(effectiveChatSettings.provider, effectiveChatSettings.model)
    void update({
      serviceTier: tier,
      serviceTierByModel: { ...settings.serviceTierByModel, [key]: tier }
    })
  }

  const onChatSettingsChange = (patch: ChatSettingsPatch): void => {
    const provider = effectiveChatSettings.provider
    const thinkingPrefsByProvider = { ...settings.thinkingPrefsByProvider }
    if (patch.thinkingEnabled !== undefined || patch.thinkingEffort !== undefined) {
      const current = thinkingPrefsByProvider[provider] ?? DEFAULT_THINKING_PREFS
      thinkingPrefsByProvider[provider] = {
        thinkingEnabled: patch.thinkingEnabled ?? current.thinkingEnabled,
        thinkingEffort: patch.thinkingEffort ?? current.thinkingEffort
      }
    }

    const override = activeContext?.settingsOverride
    if (override?.useOverride && activeWorkspace) {
      void setSettingsOverride(activeWorkspace, {
        ...override,
        useOverride: true,
        ...patch
      }).then((res) => {
        if (!res.ok) setSettingsError(res.error)
      })
      if (Object.keys(thinkingPrefsByProvider).length) {
        void update({ thinkingPrefsByProvider })
      }
      return
    }
    void update({ ...patch, thinkingPrefsByProvider })
  }

  const effectiveChatSettings = resolveEffectiveSettings(
    settings,
    activeContext?.settingsOverride
  )

  const modelsRefreshKey = `${
    effectiveChatSettings.provider === 'ollama'
      ? `ollama:${effectiveChatSettings.ollamaBaseUrl}:${secrets.ollama ? '1' : '0'}`
      : effectiveChatSettings.provider === 'custom'
        ? `custom:${effectiveChatSettings.customOpenAiBaseUrl}:${secrets.custom ? '1' : '0'}`
        : `${effectiveChatSettings.provider}:${secrets[effectiveChatSettings.provider as SecretProvider] ? '1' : '0'}`
  }:${modelsRefreshNonce}`

  const imageReadyHint = useMemo(
    () =>
      resolveImageReadyLabel({
        imageProvider: settings.imageProvider,
        secrets,
        customImageEnabled: settings.customImageEnabled,
        customOpenAiBaseUrl: effectiveChatSettings.customOpenAiBaseUrl
      }),
    [
      settings.imageProvider,
      settings.customImageEnabled,
      effectiveChatSettings.customOpenAiBaseUrl,
      secrets
    ]
  )

  const onSelectRunInWorkspace = async (path: string, runId: string): Promise<void> => {
    if (!chatActions) {
      setSettingsError('Session loading is unavailable.')
      setView('chat')
      return
    }
    await openRunInWorkspace(path, runId)
    const ctrl = getRunController(runId, path)
    if (!ctrl || ctrl.items.length === 0) {
      await loadRunTranscriptIntoTab(path, runId)
    }
    setView('chat')
  }

  const handleSessionDrop = useCallback(
    (
      anchorPaneId: string,
      zone: import('@renderer/lib/chat/chatPaneLayout').PaneDropZone,
      payload: { workspacePath: string; runId: string }
    ): boolean => {
      const ok = dropSessionOnPane(anchorPaneId, zone, payload)
      if (!ok) {
        pushToast('Not enough room for another chat pane.')
        return false
      }
      void (async () => {
        const ctrl = getRunController(payload.runId, payload.workspacePath)
        if (!ctrl || ctrl.items.length === 0) {
          await loadRunTranscriptIntoTab(payload.workspacePath, payload.runId)
        }
        setView('chat')
      })()
      return true
    },
    [dropSessionOnPane, getRunController, loadRunTranscriptIntoTab]
  )

  const getPaneTitle = useCallback(
    (pane: ChatPane): string => {
      if (!pane.runId) return 'New chat'
      const ctx = findByWorkspacePath(contexts, pane.workspacePath)
      const run = ctx?.runs.find((r) => r.runId === pane.runId)
      const goal = run?.goal?.trim()
      return goal || 'Chat'
    },
    [contexts]
  )

  const onNewChat = (): void => {
    openRunTab(null)
    setView('chat')
  }

  const onPickWorkspace = (): void => {
    void pickWorkspace().then(async (res) => {
      if (res.ok && res.data) {
        await addWorkspace(res.data)
      }
    })
  }

  const chatActionsRef = useRef(chatActions)
  chatActionsRef.current = chatActions

  const onChatSend = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: import('@shared/ipc').ComposerSendExtras
    ) => {
      return chatActionsRef.current?.send(text, images, files, extras) ?? false
    },
    []
  )

  const onChatEditAndResend = useCallback(
    async (
      editMessageIndex: number,
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: import('@shared/ipc').ComposerSendExtras
    ) => {
      return (
        chatActionsRef.current?.editAndResend?.(editMessageIndex, text, images, files, extras) ??
        false
      )
    },
    []
  )

  const onChatRevertToUserMessage = useCallback(async (userMessageIndex: number) => {
    return chatActionsRef.current?.revertToUserMessage?.(userMessageIndex) ?? false
  }, [])

  const onChatStop = useCallback(() => {
    void chatActionsRef.current?.stop()
  }, [])

  const onRemoveFollowUp = useCallback((id: string) => {
    void chatActionsRef.current?.removeFollowUp?.(id)
  }, [])

  const onEditFollowUp = useCallback((id: string, text: string) => {
    return chatActionsRef.current?.editFollowUp?.(id, text) ?? false
  }, [])

  const onSendFollowUpNow = useCallback((id: string) => {
    void chatActionsRef.current?.sendFollowUpNow?.(id)
  }, [])

  const onChatContinue = useCallback(() => {
    void chatActionsRef.current?.send(CONTINUE_PROMPT)
  }, [])

  const activeRunId = chat.runId
  const [undoBusy, setUndoBusy] = useState(false)
  const onCompactContext = useCallback(async () => {
    if (!activeWorkspace || !activeRunId) {
      return { ok: false as const, message: 'Compaction is unavailable.' }
    }
    const res = await window.vyotiq.chatCompact(activeWorkspace, activeRunId)
    if (!res.ok) return { ok: false as const, message: res.error }
    chatActionsRef.current?.applyManualCompaction?.(res.data)
    return {
      ok: true as const,
      message: `Summarized ${res.data.messagesBefore - res.data.keptMessages} messages; ${res.data.keptMessages} kept verbatim.`
    }
  }, [activeWorkspace, activeRunId])

  const resolveAgentWrites = useCallback(
    async (action: 'keep' | 'discard', paths?: string[]): Promise<boolean> => {
      if (!activeWorkspace || !activeRunId) {
        setSettingsError('Keep/Discard is unavailable.')
        return false
      }
      if (chat.running) {
        setSettingsError('Stop the run to Keep/Discard agent writes.')
        return false
      }
      const checkpointId = chat.writeCheckpoint?.undone
        ? undefined
        : chat.writeCheckpoint?.checkpointId
      setUndoBusy(true)
      try {
        const res = await window.vyotiq.resolveWrites({
          workspacePath: activeWorkspace,
          runId: activeRunId,
          ...(checkpointId ? { checkpointId } : {}),
          action,
          ...(paths?.length ? { paths } : {})
        })
        if (!res.ok) {
          setSettingsError(res.error)
          return false
        }
        chatActionsRef.current?.applyWriteCheckpointResolution?.(res.data)
        setSettingsError(null)
        return true
      } finally {
        setUndoBusy(false)
      }
    },
    [activeWorkspace, activeRunId, chat.running, chat.writeCheckpoint, setSettingsError]
  )

  const onUndoWrites = useCallback(async (): Promise<boolean> => {
    return resolveAgentWrites('discard')
  }, [resolveAgentWrites])

  const onKeepWriteFile = useCallback(
    (path: string) => resolveAgentWrites('keep', [path]),
    [resolveAgentWrites]
  )
  const onDiscardWriteFile = useCallback(
    (path: string) => resolveAgentWrites('discard', [path]),
    [resolveAgentWrites]
  )
  const onKeepAllWrites = useCallback(
    () => resolveAgentWrites('keep'),
    [resolveAgentWrites]
  )

  const writeFileResolutions = useMemo(() => {
    const files = chat.writeCheckpoint?.files
    if (!files?.length) return undefined
    const map = new Map<string, 'kept' | 'discarded' | undefined>()
    for (const f of files) {
      map.set(normalizeRelPath(f.path), f.resolved)
    }
    return map
  }, [chat.writeCheckpoint])

  const writeResolvablePaths = useMemo(() => {
    const files = chat.writeCheckpoint?.files
    if (!files?.length) return undefined
    return new Set(
      files.filter((f) => f.undoable !== false).map((f) => normalizeRelPath(f.path))
    )
  }, [chat.writeCheckpoint])

  const slashHandlersValue = useMemo(
    () => ({
      onClear: () => {
        onNewChat()
        setSettingsError(null)
        return true
      },
      onCompact: async () => {
        const result = await onCompactContext()
        if (!result.ok) {
          setSettingsError(result.message)
          return false
        }
        setSettingsError(null)
        return true
      },
      onUndoWrites: () => onUndoWrites(),
      onSetAgentMode: (mode: import('@shared/ipc').AgentInteractionMode) => {
        if (chat.running || chat.pendingRun) {
          setSettingsError('Mode is locked while a run is active.')
          return false
        }
        setAgentMode(mode)
        return true
      },
      onOpenMarketplace: (mcpServerId?: string) => {
        setMarketplaceFocusServerId(mcpServerId ?? null)
        setView('marketplace')
      },
      onOpenSettings: () => {
        setView('settings')
      },
      onCreateRule: async (title?: string) => {
        if (!activeWorkspace) {
          setSettingsError('Open a workspace to create a rule.')
          return false
        }
        const res = await window.vyotiq.slashCommandsCreateRule({
          workspacePath: activeWorkspace,
          title
        })
        if (!res.ok) {
          setSettingsError(res.error)
          return false
        }
        setSettingsError(null)
        logger.info('Created workspace rule', {
          scope: 'slash',
          path: res.data.relativePath
        })
        return true
      },
      onHarnessApply: async (proposalPath?: string) => {
        if (!activeWorkspace) {
          setSettingsError('Open a workspace to apply a harness proposal.')
          return false
        }
        const preview = await window.vyotiq.harnessPreviewApply({
          workspacePath: activeWorkspace,
          ...(proposalPath?.trim() ? { proposalPath: proposalPath.trim() } : {})
        })
        if (!preview.ok) {
          // Expected when the open project is not the Agent V repo — soft notice, not a crash.
          setSettingsError(preview.error)
          return false
        }
        if (!preview.data.changed) {
          setSettingsError('Harness already matches the proposal — nothing to apply.')
          return true
        }
        const confirmed = window.confirm(
          `Apply harness proposal?\n\n${preview.data.relativePath}\n→ resources/harness/default.md only\n\nRuns fixed harness vitest subset; reverts that file on failure.\nEvaluator / gate-test changes need a normal PR.`
        )
        if (!confirmed) return false
        const res = await window.vyotiq.harnessApply({
          workspacePath: activeWorkspace,
          ...(proposalPath?.trim() ? { proposalPath: proposalPath.trim() } : {}),
          confirm: true
        })
        if (!res.ok) {
          setSettingsError(res.error)
          return false
        }
        if (!res.data.applied) {
          setSettingsError(
            res.data.reverted
              ? `Harness apply reverted — tests failed.\n${res.data.validationOutput.slice(0, 800)}`
              : res.data.validationOutput
          )
          return false
        }
        setSettingsError(null)
        logger.info('Applied harness proposal', {
          scope: 'slash',
          path: res.data.relativePath
        })
        return true
      },
      onMarketplaceAction: async (packageId: string, intent: 'install' | 'enable') => {
        if (intent === 'enable') {
          const res = await window.vyotiq.marketplaceSetEnabled(packageId, true)
          if (!res.ok) setSettingsError(res.error)
          return
        }
        const browse = await window.vyotiq.marketplaceBrowse({})
        if (!browse.ok) {
          setSettingsError(browse.error)
          return
        }
        const entry = browse.data.packages.find((p) => p.id === packageId)
        if (!entry) {
          setSettingsError(`Package not found in catalog: ${packageId}`)
          return
        }
        if (entry.installable === false) {
          setSettingsError(`Package is not installable: ${packageId}`)
          return
        }
        const payload =
          entry.bundledPath != null && entry.bundledPath !== ''
            ? {
                source: 'bundled' as const,
                target: entry.bundledPath,
                kind: entry.kind,
                version: entry.version
              }
            : {
                source: 'registry' as const,
                target: entry.id,
                kind: entry.kind,
                version: entry.version
              }
        // Registry installs require ack; prompt here so slash/skills paths match Marketplace UI.
        if (payload.source === 'registry' && !settings.marketplace?.remoteInstallAcked) {
          const ack = await window.vyotiq.marketplaceAckRemoteInstall(true)
          if (!ack.ok) {
            setSettingsError(ack.error)
            return
          }
          if (!ack.data.marketplace?.remoteInstallAcked) return
          await refresh()
        }
        const res = await window.vyotiq.marketplaceInstall(payload)
        if (!res.ok) setSettingsError(res.error)
      },
      onOpenFile: async (path: string) => {
        if (!activeWorkspace) {
          setSettingsError('Open a workspace to open files.')
          return
        }
        const res = await window.vyotiq.slashCommandsOpenFile({
          workspacePath: activeWorkspace,
          path
        })
        if (!res.ok) setSettingsError(res.error)
      },
      onNotice: (message: string) => {
        pushToast(message)
      }
    }),
    [
      activeWorkspace,
      onCompactContext,
      onNewChat,
      onUndoWrites,
      refresh,
      setAgentMode,
      setSettingsError,
      chat.running,
      chat.pendingRun,
      settings.marketplace,
      update
    ]
  )

  const operationalError = settingsError ?? workspaceError

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!window.vyotiq?.consumeCrashRecovery) return
      const res = await window.vyotiq.consumeCrashRecovery()
      if (cancelled || !res.ok || !res.data) return
      const reason = res.data.reason
      const code = res.data.exitCodeHex ?? (res.data.exitCode != null ? String(res.data.exitCode) : '')
      setSettingsError(
        `UI recovered after a renderer crash (${reason}${code ? ` · ${code}` : ''}). Recent crash details are in Settings → General.`
      )
    })()
    return () => {
      cancelled = true
    }
  }, [setSettingsError])

  const [mcpServerNames, setMcpServerNames] = useState(() => new Map<string, string>())

  useEffect(() => {
    const map = new Map<string, string>()
    for (const server of settings.mcpServers) {
      map.set(server.id, server.name.trim() || server.id)
    }
    setMcpServerNames(map)
    let cancelled = false
    void (async () => {
      const res = await window.vyotiq?.mcpStatus?.({
        workspacePath: activeWorkspace
      })
      if (cancelled || !res?.ok) return
      setMcpServerNames((prev) => {
        const next = new Map(prev)
        for (const server of res.data.servers) {
          if (!next.has(server.id)) {
            next.set(server.id, server.name.trim() || server.id)
          }
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [settings.mcpServers, activeWorkspace])

  const onDismissChatBanner = (): void => {
    // Banner shows settingsError ?? workspaceError ?? chat.error — clear only that source.
    if (settingsError) {
      setSettingsError(null)
    } else if (workspaceError) {
      clearWorkspaceError()
    } else {
      chatActions?.clearError()
    }
  }

  const renderPaneSession = useCallback(
    (pane: ChatPane, focused: boolean) => {
      const snap = getPaneChatSnapshot(pane.workspacePath, pane.runId)
      const paneContext = findByWorkspacePath(contexts, pane.workspacePath)
      const paneScroll =
        paneContext?.ui.scrollTopByRunId[pane.runId ?? '__draft__'] ??
        paneContext?.ui.scrollTop ??
        0
      const paneCollapsed =
        snap.collapsedTurnIndices.length > 0
          ? new Set(snap.collapsedTurnIndices)
          : undefined
      const paneCtrl = getRunController(pane.runId, pane.workspacePath)
      const paneDraft = paneContext
        ? resolveComposerDraft(paneContext.ui, pane.runId)
        : undefined
      return (
        <SessionChatColumn
          items={snap.items}
          itemsStore={{
            subscribeItems: snap.subscribeItems,
            getItemsRevision: snap.getItemsRevision,
            getItems: snap.getItems
          }}
          metaStore={{
            subscribeMeta: snap.subscribeMeta,
            getMetaRevision: snap.getMetaRevision,
            getContextUsage: snap.getContextUsage
          }}
          running={snap.running}
          invokeId={snap.invokeId}
          pendingRun={snap.pendingRun}
          error={snap.error}
          errorCode={snap.errorCode}
          networkWait={snap.networkWait}
          runNotice={snap.runNotice}
          incomplete={snap.incomplete}
          onContinue={() => {
            void paneCtrl?.send(CONTINUE_PROMPT)
          }}
          contextUsage={snap.contextUsage}
          operationalError={focused ? operationalError : null}
          hasWorkspace={Boolean(pane.workspacePath)}
          workspacePath={pane.workspacePath}
          provider={effectiveChatSettings.provider}
          model={effectiveChatSettings.model}
          ollamaBaseUrl={effectiveChatSettings.ollamaBaseUrl}
          customOpenAiBaseUrl={effectiveChatSettings.customOpenAiBaseUrl}
          modelsRefreshKey={modelsRefreshKey}
          activeRunId={pane.runId}
          transcriptLoading={snap.transcriptLoading}
          showPageHeading={false}
          onActivate={() => focusPaneById(pane.paneId)}
          onProviderModel={onProviderModel}
          favoriteModels={settings.favoriteModels}
          recentModels={settings.recentModels}
          serviceTier={resolveServiceTier(
            settings,
            effectiveChatSettings.provider,
            effectiveChatSettings.model
          )}
          onToggleFavorite={onToggleFavorite}
          onServiceTierChange={onServiceTierChange}
          chatSettings={effectiveChatSettings}
          onChatSettingsChange={onChatSettingsChange}
          agentMode={paneContext?.ui.agentMode ?? 'agent'}
          onAgentModeChange={(mode) => {
            setAgentMode(mode, { syncOnly: true })
          }}
          onSend={(text, images, files, extras) =>
            paneCtrl?.send(text, images, files, extras) ?? false
          }
          onStop={() => {
            void paneCtrl?.stop()
          }}
          onEditAndResend={(editMessageIndex, text, images, files, extras) =>
            paneCtrl?.editAndResend(editMessageIndex, text, images, files, extras) ?? false
          }
          onRevertToUserMessage={(userMessageIndex) =>
            paneCtrl?.revertToUserMessage(userMessageIndex) ?? false
          }
          messages={snap.messages}
          pendingFollowUps={snap.pendingFollowUps}
          onRemoveFollowUp={(id) => {
            void paneCtrl?.removeFollowUp(id)
          }}
          onEditFollowUp={(id, text) => paneCtrl?.editFollowUp(id, text) ?? false}
          onSendFollowUpNow={(id) => {
            void paneCtrl?.sendFollowUpNow(id)
          }}
          onDismissError={onDismissChatBanner}
          composerDraft={paneDraft}
          onComposerDraftChange={(draft) =>
            setComposerDraftForPane(pane.workspacePath, pane.runId, draft)
          }
          restoreScrollTop={paneScroll}
          scrollRestoreToken={scrollRestoreToken}
          onScrollTopChange={(scrollTop) =>
            onMessageListScrollForPane(pane.workspacePath, pane.runId, scrollTop)
          }
          chatSurfaceEpoch={chatSurfaceEpoch}
          showThinking={effectiveChatSettings.showThinking}
          onLoadToolContent={
            paneCtrl ? (toolCallId) => paneCtrl.loadToolContent(toolCallId) : undefined
          }
          onThinkingToggle={
            paneCtrl
              ? (messageId, expanded) => paneCtrl.setThinkingExpanded(messageId, expanded)
              : undefined
          }
          onToolToggle={
            paneCtrl
              ? (toolCallId, expanded) => paneCtrl.setToolExpanded(toolCallId, expanded)
              : undefined
          }
          onGroupToggle={
            paneCtrl
              ? (anchorToolCallId, expanded) =>
                  paneCtrl.setGroupExpanded(anchorToolCallId, expanded)
              : undefined
          }
          onTurnToggle={
            paneCtrl ? (turnIndex) => paneCtrl.toggleTurnCollapsed(turnIndex) : undefined
          }
          collapsedTurns={paneCollapsed}
          onApprovalDecision={
            paneCtrl
              ? (requestId, decision) => paneCtrl.respondToApproval(requestId, decision)
              : undefined
          }
          onQuestionSubmit={
            paneCtrl
              ? (requestId, answers) => paneCtrl.respondToQuestion(requestId, answers)
              : undefined
          }
          mcpServerNames={mcpServerNames}
          slashHandlers={slashHandlersValue}
          sideRailPad={false}
          imageReadyHint={imageReadyHint}
        />
      )
    },
    [
      chatSurfaceEpoch,
      contexts,
      effectiveChatSettings,
      getPaneChatSnapshot,
      getRunController,
      imageReadyHint,
      mcpServerNames,
      modelsRefreshKey,
      focusPaneById,
      onChatSettingsChange,
      onDismissChatBanner,
      onMessageListScrollForPane,
      onProviderModel,
      setComposerDraftForPane,
      onServiceTierChange,
      onToggleFavorite,
      operationalError,
      scrollRestoreToken,
      setAgentMode,
      settings.favoriteModels,
      settings.recentModels,
      slashHandlersValue
    ]
  )

  const multiPaneConfig = useMemo(() => {
    if (!paneLayout) return null
    return {
      panes: paneLayout.panes,
      focusedPaneId: paneLayout.focusedPaneId,
      sizes: paneLayout.sizes,
      onFocusPane: focusPaneById,
      onClosePane: closePaneById,
      onSizesChange: setPaneSizesByIndex,
      onSessionDrop: handleSessionDrop,
      getPaneTitle,
      renderPane: renderPaneSession
    }
  }, [
    closePaneById,
    focusPaneById,
    getPaneTitle,
    handleSessionDrop,
    paneLayout,
    renderPaneSession,
    setPaneSizesByIndex
  ])

  const onRenameRunInWorkspace = async (
    path: string,
    runId: string,
    goal: string
  ): Promise<void> => {
    if (!window.vyotiq?.renameRun) return
    const res = await window.vyotiq.renameRun(path, runId, goal)
    if (!res.ok) {
      setSettingsError(res.error)
      return
    }
    refreshWorkspaceRuns(path)
  }

  const onDeleteRun = async (runId: string): Promise<void> => {
    if (!activeWorkspace || !window.vyotiq?.deleteRun) return
    const res = await window.vyotiq.deleteRun(activeWorkspace, runId)
    if (!res.ok) {
      setSettingsError(res.error)
      return
    }
    purgeDeletedRunUi(activeWorkspace, runId)
    closeRunTab(runId)
    refreshActiveRuns()
  }

  const onDeleteRunInWorkspace = async (path: string, runId: string): Promise<void> => {
    if (!window.vyotiq?.deleteRun) return
    const res = await window.vyotiq.deleteRun(path, runId)
    if (!res.ok) {
      setSettingsError(res.error)
      return
    }
    purgeDeletedRunUi(path, runId)
    if (activeWorkspace && workspacePathsEqual(path, activeWorkspace)) {
      closeRunTab(runId)
    }
    refreshWorkspaceRuns(path)
  }

  const onCloseWorkspace = (path: string): void => {
    void removeWorkspace(path)
  }

  const chatError = chat.error

  const runsByWorkspacePath = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(contexts).map(([path, ctx]) => [
          path,
          {
            runs: ctx.runs,
            runsCapped: ctx.runsCapped,
            runsError: ctx.runsError,
            runsLoaded: ctx.runsLoaded,
            activeRunId: ctx.activeRunId
          }
        ])
      ),
    [contexts]
  )

  const shellWorkspaceProps = {
    openWorkspaces,
    activeRuns,
    runsByWorkspacePath,
    onSwitchWorkspace: (path: string) => void switchWorkspace(path),
    onCloseWorkspace,
    onAddWorkspace: onPickWorkspace,
    workspaceHasBackgroundRun,
    onSelectRunInWorkspace: (path: string, runId: string) => void onSelectRunInWorkspace(path, runId),
    onRenameRunInWorkspace: (path: string, runId: string, goal: string) =>
      void onRenameRunInWorkspace(path, runId, goal),
    onDeleteRunInWorkspace: (path: string, runId: string) => void onDeleteRunInWorkspace(path, runId),
    isRunOpenInPane: isSessionOpenInPane,
    isRunFocusedInPane: isSessionFocusedInPane
  }

  if (loading) {
    return (
      <AppShell
        view="chat"
        workspacePath={null}
        sessionQuery=""
        onSessionQuery={() => {}}
        onOpenSettings={() => {}}
        onOpenMarketplace={() => {}}
        onOpenChat={() => {}}
        onNewChat={() => {}}
        {...shellWorkspaceProps}
        loading
      >
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-6"
          role="status"
          aria-busy="true"
        >
          <span className="sr-only">Loading Vyotiq…</span>
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 animate-fade-in">
            <div className="h-4 w-2/5 animate-pulse rounded bg-surface" />
            <div className="h-4 w-3/5 animate-pulse rounded bg-surface" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-surface" />
            <div className="mt-4 h-24 animate-pulse rounded-lg border border-border bg-surface/60" />
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell
      view={view}
      workspacePath={activeWorkspace}
      onDismissRunsError={clearRunsError}
      sessionQuery=""
      onSessionQuery={setSessionQuery}
      onOpenSettings={() => setView('settings')}
      onOpenMarketplace={() => setView('marketplace')}
      onOpenChat={() => setView('chat')}
      onNewChat={onNewChat}
      running={chat.running || chat.pendingRun}
      onChatStop={onChatStop}
      {...shellWorkspaceProps}
    >
      {view === 'settings' ? (
        <ErrorBoundary title="Settings couldn't render" resetKey={settingsSection}>
          <SettingsView
            settings={settings}
            secrets={secrets}
            encryptionAvailable={encryptionAvailable}
            appError={settingsError}
            onDismissAppError={() => setSettingsError(null)}
            backRef={settingsBackRef}
            section={settingsSection}
            onSectionChange={setSettingsSection}
            onClose={() => setView('chat')}
            onUpdate={update}
            onReloadSettings={refresh}
            onSaveSecret={saveSecret}
            onClearSecret={removeSecret}
            onSetTheme={(theme) => {
              const prev = settings.theme
              setTheme(theme)
              void update({ theme }).then((res) => {
                if (!res.ok) setTheme(prev)
              })
            }}
            onPickWorkspace={async () => {
              const res = await pickWorkspace()
              if (res.ok && res.data) await addWorkspace(res.data)
              return res
            }}
            activeWorkspacePath={activeWorkspace}
            openWorkspaces={openWorkspaces}
            settingsOverridesByPath={registry?.settingsOverridesByPath ?? {}}
            effectiveChatSettings={effectiveChatSettings}
            onSetSettingsOverride={setSettingsOverride}
            onModelsRefreshed={() => setModelsRefreshNonce((n) => n + 1)}
          />
        </ErrorBoundary>
      ) : view === 'marketplace' ? (
        <ErrorBoundary
          title="Marketplace couldn't render"
          resetKey={marketplaceFocusServerId ?? 'marketplace'}
        >
          <MarketplaceView
            settings={settings}
            onUpdate={update}
            onReloadSettings={refresh}
            activeWorkspacePath={activeWorkspace}
            settingsOverridesByPath={registry?.settingsOverridesByPath ?? {}}
            onSetSettingsOverride={setSettingsOverride}
            focusServerId={marketplaceFocusServerId}
            onFocusServerConsumed={() => setMarketplaceFocusServerId(null)}
            onClose={() => setView('chat')}
          />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary title="Chat couldn't render" resetKey={chatSurfaceEpoch}>
          <ChatView
            imageReadyHint={imageReadyHint}
            items={chat.items}
            itemsStore={{
              subscribeItems: chat.subscribeItems,
              getItemsRevision: chat.getItemsRevision,
              getItems: chat.getItems
            }}
            metaStore={{
              subscribeMeta: chat.subscribeMeta,
              getMetaRevision: chat.getMetaRevision,
              getContextUsage: chat.getContextUsage
            }}
            running={chat.running}
            invokeId={chat.invokeId}
            pendingRun={chat.pendingRun}
            error={chatError}
            errorCode={chat.errorCode}
            networkWait={chat.networkWait}
            runNotice={chat.runNotice}
            incomplete={chat.incomplete}
            onContinue={onChatContinue}
            contextUsage={chat.contextUsage}
            onCompactContext={activeWorkspace && activeRunId ? onCompactContext : undefined}
            operationalError={operationalError}
            hasWorkspace={Boolean(focusedWorkspacePath ?? activeWorkspace)}
            workspacePath={focusedWorkspacePath ?? activeWorkspace}
            provider={effectiveChatSettings.provider}
            model={effectiveChatSettings.model}
            ollamaBaseUrl={effectiveChatSettings.ollamaBaseUrl}
            customOpenAiBaseUrl={effectiveChatSettings.customOpenAiBaseUrl}
            modelsRefreshKey={modelsRefreshKey}
            activeRunId={chat.runId ?? activeContext?.activeRunId ?? null}
            transcriptLoading={chat.transcriptLoading}
            headingRef={chatHeadingRef}
            onProviderModel={onProviderModel}
            favoriteModels={settings.favoriteModels}
            recentModels={settings.recentModels}
            serviceTier={resolveServiceTier(
              settings,
              effectiveChatSettings.provider,
              effectiveChatSettings.model
            )}
            onToggleFavorite={onToggleFavorite}
            onServiceTierChange={onServiceTierChange}
            chatSettings={effectiveChatSettings}
            onChatSettingsChange={onChatSettingsChange}
            agentMode={activeContext?.ui.agentMode ?? 'agent'}
            onAgentModeChange={(mode) => setAgentMode(mode, { syncOnly: true })}
            onContinueInAgent={() => {
              setAgentMode('agent')
              setComposerDraft(
                'Implement the approved plan from plan.md (run artifact — read plan.md to load it).'
              )
            }}
            onSend={onChatSend}
            onEditAndResend={onChatEditAndResend}
            onRevertToUserMessage={onChatRevertToUserMessage}
            messages={chat.messages}
            onStop={onChatStop}
            pendingFollowUps={chat.pendingFollowUps}
            onRemoveFollowUp={onRemoveFollowUp}
            onEditFollowUp={onEditFollowUp}
            onSendFollowUpNow={onSendFollowUpNow}
            onDismissError={onDismissChatBanner}
            onComposerDraftChange={setComposerDraft}
            restoreScrollTop={activeScrollTop}
            scrollRestoreToken={scrollRestoreToken}
            onScrollTopChange={onMessageListScroll}
            chatSurfaceEpoch={chatSurfaceEpoch}
            showThinking={effectiveChatSettings.showThinking}
            onLoadToolContent={onLoadToolContent}
            onThinkingToggle={onThinkingToggle}
            onToolToggle={onToolToggle}
            onGroupToggle={onGroupToggle}
            onTurnToggle={onTurnToggle}
            collapsedTurns={collapsedTurns}
            onApprovalDecision={onApprovalDecision}
            onQuestionSubmit={onQuestionSubmit}
            mcpServerNames={mcpServerNames}
            slashHandlers={slashHandlersValue}
            canUndoWrites={Boolean(chat.writeCheckpoint && !chat.writeCheckpoint.undone)}
            undoBusy={undoBusy}
            resolveBlockedReason={
              chat.running ? 'Stop the run to Keep/Discard agent writes.' : null
            }
            onUndoWrites={onUndoWrites}
            writeFileResolutions={writeFileResolutions}
            writeResolvablePaths={writeResolvablePaths}
            onKeepWriteFile={onKeepWriteFile}
            onDiscardWriteFile={onDiscardWriteFile}
            onKeepAllWrites={onKeepAllWrites}
            multiPane={multiPaneConfig}
            onPaneCapacityChange={setPaneCapacityContext}
            paneCount={paneLayout?.panes.length ?? 1}
          />
        </ErrorBoundary>
      )}
      <ToastHost />
    </AppShell>
  )
}

export default App
