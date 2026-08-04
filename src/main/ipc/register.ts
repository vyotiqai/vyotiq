import { ipcMain, BrowserWindow, shell, nativeTheme, dialog } from 'electron'
import { ZodError } from 'zod'
import { IPC } from '../../shared/channels'
import { toolMessageForIpc } from '../../shared/utils/toolResultIpc'
import {
  ChatStartRequestSchema,
  ChatRewindAndStartRequestSchema,
  CancelRunRequestSchema,
  ChatFollowUpRequestSchema,
  ChatFollowUpRemoveRequestSchema,
  CompactRunRequestSchema,
  UndoWritesRequestSchema,
  ResolveWritesRequestSchema,
  ReadRunArtifactRequestSchema,
  HarnessReviewRequestSchema,
  HarnessPreviewApplyRequestSchema,
  HarnessApplyRequestSchema,
  SetSettingsRequestSchema,
  SetSecretRequestSchema,
  ClearSecretRequestSchema,
  ListModelsRequestSchema,
  ListRunsRequestSchema,
  LoadRunRequestSchema,
  LoadRunEventsRequestSchema,
  LoadToolResultRequestSchema,
  DeleteRunRequestSchema,
  RenameRunRequestSchema,
  WorkspacesAddRequestSchema,
  WorkspacesRemoveRequestSchema,
  WorkspacesSetActiveRequestSchema,
  WorkspacesUpdateUiStateRequestSchema,
  WorkspacesSetSettingsOverrideRequestSchema,
  GitStatusRequestSchema,
  GitCommitRequestSchema,
  GitStageAllRequestSchema,
  GitStagePathsRequestSchema,
  GitUnstagePathsRequestSchema,
  GitBranchesRequestSchema,
  GitCheckoutRequestSchema,
  GitDiffRequestSchema,
  GitLogRequestSchema,
  GitCommitFilesRequestSchema,
  PrViewRequestSchema,
  PrMergeRequestSchema,
  PrDiffRequestSchema,
  PrCloseRequestSchema,
  PrEditTitleRequestSchema,
  ShellOpenExternalRequestSchema,
  PtyCreateRequestSchema,
  PtyListRequestSchema,
  PtyIdRequestSchema,
  PtyWriteRequestSchema,
  PtyResizeRequestSchema,
  ToolApprovalResponseSchema,
  AgentQuestionResponseSchema,
  ListPendingAgentQuestionsRequestSchema,
  ListPendingToolApprovalsRequestSchema,
  ExtractAttachmentRequestSchema,
  WorkspaceSuggestPathsRequestSchema,
  WorkspaceReadTextRequestSchema,
  WorkspaceReadImageRequestSchema,
  WorkspaceListDocsRequestSchema,
  WorkspaceListRulesRequestSchema,
  WorkspaceDiagnosticsRequestSchema,
  MarketplaceBrowseRequestSchema,
  MarketplaceGetContentsRequestSchema,
  MarketplaceInstallRequestSchema,
  MarketplaceRemoteInstallAckRequestSchema,
  MarketplaceSetEnabledRequestSchema,
  MarketplaceUninstallRequestSchema,
  McpDetectRequestSchema,
  McpClearAuthTokenRequestSchema,
  McpRefreshRequestSchema,
  McpSetAuthTokenRequestSchema,
  McpStartOAuthRequestSchema,
  McpStatusRequestSchema,
  McpApplyDetectedRequestSchema,
  McpImportExternalRequestSchema,
  McpScanExternalRequestSchema,
  SlashCommandsListRequestSchema,
  SlashCommandsResolveRequestSchema,
  SlashCommandsCreateRuleRequestSchema,
  SlashCommandsOpenFileRequestSchema,
  ok,
  fail,
  MAX_ATTACHMENT_BYTES,
  type ExtractAttachmentResult,
  type IpcResult,
  type Settings,
  type AgentEvent,
  type AgentQuestionRequest,
  type ToolApprovalRequest,
  type ChatStartResult,
  type ChatFollowUpResult,
  type ChatFollowUpRemoveResult,
  type ChatMessage,
  type CompactRunResult,
  type UndoWritesResult,
  type ResolveWritesResult,
  type ReadRunArtifactResult,
  type HarnessReviewResult,
  type HarnessPreviewApplyResult,
  type HarnessApplyResult,
  type ListRunsResult,
  type RunSummary,
  type SecretsStatus,
  type ListModelsResult,
  type PersistedEvent,
  type TelemetryStatus,
  type CrashDiagnosticsSnapshot,
  type CrashRecoveryPending,
  type McpStatusResult,
  type WorkspacesState,
  type ActiveRunsResult,
  type GitStatusResult,
  type GitCommitResult,
  type AgentBrowserState,
  BrowserNavigateRequestSchema,
  BrowserSelectTabRequestSchema,
  BrowserClearBrowsingDataRequestSchema,
  BrowserSetBoundsRequestSchema,
  BrowserTakeScreenshotRequestSchema
} from '../../shared/ipc'
import { resolveProviderListBaseUrl } from '../../shared/providers'
import { WORKSPACE_IMAGE_PREVIEW_MAX_BYTES } from '../agent/providers/imageGen/workspaceImages'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { formatError, AppError, isAbortError, isAppError } from '../../shared/errors'
import { scrubString } from '../../shared/utils/scrub'
import { logger, logErrorSummary } from '../../shared/logger'
import { pickWorkspace } from '@main/workspace/workspace'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import { getSettings, setSettings, setMarketplaceRemoteInstallAcked, redactSettingsForIpc, enqueueSettingsMutation } from '@main/settings/settings'
import { syncMcpServers, getMcpServerStatus, refreshMcpServers, startMcpOAuth, setMcpStdioWorkspace } from '@main/agent/mcp'
import { headersWithoutAuthorization } from '../../shared/utils/mcpAuth'
import {
  browseCatalog,
  refreshRemoteCatalog,
  readMarketplaceIndex,
  installMarketplacePackage,
  removeInstalledItem,
  setInstalledEnabled,
  syncMarketplaceMcpIntoSettings,
  resolveEffectiveMcpServers,
  resolveMcpServersForSessionMap,
  getPackageContents,
  detectMcpInput,
  applyDetectedManualMcp,
  scanExternalMcpConfigs,
  importExternalMcpServers,
  invalidateMcpResolveCache
} from '@main/marketplace'
import {
  listSlashCommands,
  resolveSlashCommand,
  createWorkspaceRule,
  openSlashFile
} from '@main/agent/slashCommands'
import { runHarnessReviewWithSettings } from '@main/agent/harnessReviewRun'
import { WORKSPACE_HARNESS_REL } from '@main/agent/harness'
import {
  applyHarnessProposal,
  previewHarnessApply,
  workspaceHasEditableHarness
} from '@main/agent/harnessApply'
import {
  setSecret,
  clearSecret,
  getSecret,
  secretStatus,
  setMcpAuthToken,
  clearMcpAuthToken,
  clearMcpOAuthState,
  enqueueSecretsMutation
} from '@main/settings/secrets'
import { ChatEventBatcher, getChatEventBatchStats, getChatEventDispatcher, resetChatEventBatchStats } from './streamBatch'
import { installIpcTiming, timeSyncIpc } from '../perf/ipcTiming'
import { runAgent, createRunId } from '../agent/loop'
import { compactRunNow, CompactionUnavailableError } from '../agent/compactRun'
import { undoWrites, resolveWrites, getWriteCheckpointMeta } from '../agent/checkpoints'
import { prepareRewindAndReplaceUserMessage } from '../agent/rewindRun'
import { resolveRunDir } from '@main/storage/paths'
import { focusAgentBrowser, closeAgentBrowser, getAgentBrowserState, selectBrowserTab, browserGoBack, browserGoForward, setAgentBrowserBounds, navigateUrl, clearAgentBrowserData, takeBrowserScreenshot, disposeAgentBrowserForWorkspace } from '@main/app/agentBrowser'
import { extractAttachment } from '../attachments/extract'
import {
  cancelPendingApprovals,
  listPendingToolApprovals,
  registerApprovalSender,
  resolveToolApproval
} from '../agent/toolApproval'
import {
  cancelPendingQuestions,
  listPendingAgentQuestions,
  registerQuestionSender,
  resolveAgentQuestion
} from '../agent/agentQuestion'
import { listProviderModels } from '../agent/providers'
import { clearModelCache } from '../agent/providers/modelCache'
import { collectWorkspaceFiles } from '../agent/tools/walk'
import { listWorkspaceRulesForMention } from '../agent/context/rules'
import { toolDiagnosticsAsync } from '../agent/tools/diagnostics'
import { disposeTerminalSessionsForWorkspace as disposeAgentTerminalSessionsForWorkspace } from '../agent/tools/terminalSessions'
import {
  chatCancelResult,
  listActiveRuns,
  tryRegisterRunAbort,
  clearRunAbort,
  isActive,
  isRunTurnComplete,
  waitUntilRunInactive,
  markRunTurnComplete,
  enqueueFollowUp,
  removeFollowUp,
  getRunInvokeId,
  followUpPreview,
  getRunWorkspace
} from '../agent/runRegistry'
import {
  listRuns,
  loadMessagesAsync,
  loadEventsForRunAsync,
  LOAD_EVENTS_UI_LIMIT,
  loadToolResultContent,
  deleteRun,
  renameRun,
  runExists,
  appendEvent
} from '../agent/state'
import {
  getWorkspaces,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  updateWorkspaceUiState,
  setWorkspaceSettingsOverride,
  findWorkspaceSettingsOverride,
  enqueueWorkspaceMutation
} from '@main/workspace/workspaces'
import { canonicalizeWorkspacePath, isCuratedDocPath, isSafeWorkspaceRelPath, workspacePathsEqual } from '../../shared/workspacePath'
import { relative, isAbsolute, join } from 'path'
import {
  checkoutBranch,
  commitAll,
  listLocalBranches,
  readGitCommitFiles,
  readGitDiff,
  readGitLog,
  stageAll,
  stagePaths,
  unstagePaths
} from '@main/git/git'
import { invalidateGitStatusCache, readGitStatusCached } from '@main/git/gitStatusCache'
import { prClose, prDiff, prEditTitle, prMerge, prView } from '@main/git/gh'
import {
  cancelGithubAuth,
  githubAuthStatus,
  logoutGithubAuth,
  startGithubAuth
} from '@main/git/githubAuth'
import {
  createPtySession,
  disposePtySessionsForWorkspace,
  killPty,
  listPtySessions,
  resizePty,
  writePty
} from '@main/app/ptySessions'
import { applyTitleBarTheme, getMainWindow } from '@main/app/window'
import { logsDirectory } from '../logging/init'
import {
  consumeRendererRecoveryPending,
  getCrashDiagnosticsSnapshot
} from '../logging/crashDiagnostics'
import { applySentryTelemetry, isSentryBuildConfigured } from '../logging/sentry'

export { chatCancelResult }

function senderOk(event: Electron.IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return false
  // Electron guidance: validate senderFrame so a compromised subframe cannot
  // invoke privileged handlers. Frame-unaware test stubs omit both fields.
  const frame = event.senderFrame
  const main = event.sender.mainFrame
  if (frame === undefined && main === undefined) return true
  if (!frame || !main) return false
  if (typeof (frame as { isDestroyed?: () => boolean }).isDestroyed === 'function') {
    if ((frame as { isDestroyed: () => boolean }).isDestroyed()) return false
  }
  return frame === main
}

function sendToCurrentRenderer(
  channel: string,
  payload: unknown,
  fallback?: Electron.WebContents
): void {
  const current = getMainWindow()
  const target =
    current && !current.isDestroyed() && !current.webContents.isDestroyed()
      ? current.webContents
      : fallback && !fallback.isDestroyed()
        ? fallback
        : null
  target?.send(channel, payload)
}

/** Git runs commands in a directory, so only ever in one the user has opened. */
function isOpenWorkspace(path: string): boolean {
  return getWorkspaces().openPaths.some((open) => workspacePathsEqual(open, path))
}

function isTerminalStatusEvent(ev: AgentEvent): boolean {
  return (
    ev.type === 'status' &&
    (ev.status === 'cancelled' || ev.status === 'error' || ev.status === 'done')
  )
}

function isTerminalChatEvent(ev: AgentEvent): boolean {
  return ev.type === 'error' || isTerminalStatusEvent(ev)
}

function isExpectedIpcFailure(err: unknown): boolean {
  if (err instanceof AppError && (err.code === 'IPC_CLIENT' || err.code === 'MCP_CONNECT' || err.code === 'MCP_SPAWN')) {
    return true
  }
  const msg = formatError(err)
  return /no undoable write checkpoint|nothing to undo|no editable harness|already undone|already resolved|checkpoint not found|invalid checkpoint|no harness proposal found|missing a ## Proposed harness body|requires confirm/i.test(
    msg
  )
}

function failFrom(err: unknown, channel: string, correlationId?: string): IpcResult<never> {
  const isValidation = err instanceof ZodError || (err instanceof AppError && err.code === 'IPC_VALIDATION')
  const message = formatError(err)
  const expected = !isValidation && !isAbortError(err) && isExpectedIpcFailure(err)
  // AppError `err` fields are taxonomy-only; append scrubbed message/cause for ops.
  const summary = isValidation
    ? logErrorSummary(err, 'IPC_VALIDATION')
    : isAbortError(err)
      ? logErrorSummary(err)
      : expected
        ? logErrorSummary(err, 'IPC_CLIENT')
        : logErrorSummary(err, 'IPC_HANDLER')
  const detail =
    isAppError(err) && message && message !== 'Unknown error'
      ? `${summary} — ${message}`
      : summary
  const logLine = isValidation
    ? `IPC validation failed: ${detail}`
    : isAbortError(err)
      ? `IPC aborted: ${detail}`
      : expected
        ? `IPC expected failure: ${detail}`
        : `IPC handler failed: ${detail}`
  const code = isValidation
    ? 'IPC_VALIDATION'
    : isAbortError(err)
      ? undefined
      : expected
        ? 'IPC_CLIENT'
        : 'IPC_HANDLER'
  if (isValidation) {
    logger.warn(logLine, {
      scope: 'ipc',
      code: 'IPC_VALIDATION',
      channel,
      correlationId,
      err,
      reason: message
    })
  } else if (isAbortError(err) || expected) {
    logger.warn(logLine, {
      scope: 'ipc',
      ...(code ? { code } : {}),
      channel,
      correlationId,
      err,
      reason: message
    })
  } else {
    logger.error(logLine, {
      scope: 'ipc',
      code,
      channel,
      correlationId,
      err,
      reason: message
    })
  }
  return fail(message, code)
}

/** Persist Keep/Discard/Undo into events.jsonl so reload hydrates resolution state. */
function persistWriteCheckpointEvent(
  runDir: string,
  runId: string,
  checkpointId: string
): void {
  // Soft no-op resolveWrites returns checkpointId '' — do not validate/throw.
  if (!checkpointId.trim()) return
  const meta = getWriteCheckpointMeta(runDir, checkpointId)
  if (!meta) return
  appendEvent(runDir, {
    type: 'writes_checkpoint',
    runId,
    checkpointId: meta.id,
    undone: Boolean(meta.undone || meta.resolved),
    files: meta.files
  })
}

export function registerIpc(): void {
  installIpcTiming()
  ipcMain.handle(IPC.pickWorkspace, async (event): Promise<IpcResult<string | null>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return ok(await pickWorkspace(win))
    } catch (err) {
      return failFrom(err, IPC.pickWorkspace)
    }
  })

  ipcMain.handle(IPC.workspacesGet, async (event): Promise<IpcResult<WorkspacesState>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(getWorkspaces())
    } catch (err) {
      return failFrom(err, IPC.workspacesGet)
    }
  })

  ipcMain.handle(
    IPC.workspacesAdd,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = WorkspacesAddRequestSchema.parse(raw ?? {})
        const win = BrowserWindow.fromWebContents(event.sender)
        const next = await addWorkspace(win, req.path)
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
        return ok(next)
      } catch (err) {
        return failFrom(err, IPC.workspacesAdd)
      }
    }
  )

  ipcMain.handle(
    IPC.workspacesRemove,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path, stopActiveRuns } = WorkspacesRemoveRequestSchema.parse(raw)
        const activeRuns = listActiveRuns().filter((run) =>
          workspacePathsEqual(run.workspacePath, path)
        )
        if (activeRuns.length > 0 && !stopActiveRuns) {
          return fail(
            `Workspace has ${activeRuns.length} active run(s). Confirm “Stop run and close” to continue.`
          )
        }
        for (const run of activeRuns) {
          chatCancelResult(run.runId)
        }
        disposeAgentTerminalSessionsForWorkspace(path)
        disposePtySessionsForWorkspace(path)
        disposeAgentBrowserForWorkspace(path)
        // Same mutation queue as UI state / setActive — flushPersistUiState sync
        // IPC otherwise races remove and can rewrite openPaths from a stale read.
        const next = await enqueueWorkspaceMutation(() => removeWorkspace(path))
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
        return ok(next)
      } catch (err) {
        return failFrom(err, IPC.workspacesRemove)
      }
    }
  )

  ipcMain.handle(
    IPC.workspacesSetActive,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path } = WorkspacesSetActiveRequestSchema.parse(raw)
        const state = await enqueueWorkspaceMutation(() => setActiveWorkspace(path))
        setMcpStdioWorkspace(path)
        return ok(state)
      } catch (err) {
        return failFrom(err, IPC.workspacesSetActive)
      }
    }
  )

  ipcMain.handle(
    IPC.workspacesUpdateUiState,
    async (event, raw): Promise<IpcResult<true>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path, ui } = WorkspacesUpdateUiStateRequestSchema.parse(raw)
        return ok(await enqueueWorkspaceMutation(() => updateWorkspaceUiState(path, ui)))
      } catch (err) {
        return failFrom(err, IPC.workspacesUpdateUiState)
      }
    }
  )

  ipcMain.on(IPC.workspacesUpdateUiStateSync, (event, raw) => {
    if (!senderOk(event)) return
    timeSyncIpc(IPC.workspacesUpdateUiStateSync, () => {
      try {
        const { path, ui } = WorkspacesUpdateUiStateRequestSchema.parse(raw)
        // Fire-and-forget through the same mutation queue / writeGeneration path
        // as the async handler so sync IPC cannot race other workspace writes.
        void enqueueWorkspaceMutation(() => updateWorkspaceUiState(path, ui)).catch((err) => {
          logger.warn('Sync UI state update failed', {
            scope: 'ipc',
            channel: IPC.workspacesUpdateUiStateSync,
            err
          })
        })
      } catch (err) {
        logger.warn('Sync UI state update failed', {
          scope: 'ipc',
          channel: IPC.workspacesUpdateUiStateSync,
          err
        })
      }
    })
  })

  ipcMain.handle(
    IPC.workspacesSetSettingsOverride,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path, override } = WorkspacesSetSettingsOverrideRequestSchema.parse(raw)
        if (!isOpenWorkspace(path)) return fail('Workspace is not open')
        const next = await enqueueWorkspaceMutation(() =>
          setWorkspaceSettingsOverride(path, override)
        )
        invalidateMcpResolveCache()
        // Force-off / Force-on may change which MCP processes should stay alive.
        await syncMcpServers(resolveMcpServersForSessionMap())
        return ok(next)
      } catch (err) {
        return failFrom(err, IPC.workspacesSetSettingsOverride)
      }
    }
  )

  ipcMain.handle(IPC.getSettings, async (event): Promise<IpcResult<Settings>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(redactSettingsForIpc(getSettings()))
    } catch (err) {
      return failFrom(err, IPC.getSettings)
    }
  })

  ipcMain.handle(IPC.setSettings, async (event, raw): Promise<IpcResult<Settings>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const partial = SetSettingsRequestSchema.parse(raw)
      const next = await enqueueSettingsMutation(() => setSettings(partial))
      if (partial.theme !== undefined) applyTitleBarTheme(partial.theme)
      if (partial.telemetryEnabled !== undefined) {
        applySentryTelemetry(next.telemetryEnabled)
      }
      if (partial.mcpServers !== undefined || partial.marketplace !== undefined) {
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
      }
      return ok(redactSettingsForIpc(next))
    } catch (err) {
      return failFrom(err, IPC.setSettings)
    }
  })

  ipcMain.handle(IPC.setSecret, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { provider, key } = SetSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => setSecret(provider, key))
      clearModelCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.setSecret)
    }
  })

  ipcMain.handle(IPC.clearSecret, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { provider } = ClearSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => clearSecret(provider))
      clearModelCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.clearSecret)
    }
  })

  ipcMain.handle(
    IPC.secretStatus,
    async (event): Promise<IpcResult<SecretsStatus>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        return ok(secretStatus())
      } catch (err) {
        return failFrom(err, IPC.secretStatus)
      }
    }
  )

  ipcMain.handle(
    IPC.listModels,
    async (event, raw): Promise<IpcResult<ListModelsResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ListModelsRequestSchema.parse(raw ?? {})
        const settings = getSettings()
        const apiKey = getSecret(req.provider)
        const baseUrl = resolveProviderListBaseUrl(
          req.provider,
          req.baseUrl,
          settings,
          apiKey
        )
        const result = await listProviderModels({
          provider: req.provider,
          apiKey,
          baseUrl,
          forceRefresh: req.forceRefresh
        })
        return ok(result)
      } catch (err) {
        return failFrom(err, IPC.listModels)
      }
    }
  )

  ipcMain.handle(IPC.chatStart, async (event, raw): Promise<IpcResult<ChatStartResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ChatStartRequestSchema.parse(raw)
      const workspaces = getWorkspaces()
      const open = workspaces.openPaths.some((p) => workspacePathsEqual(p, req.workspacePath))
      if (!open) {
        return fail('Workspace is not open')
      }
      if (!existsSync(req.workspacePath)) {
        return fail('Workspace path does not exist')
      }
      const wc = event.sender
      let runId: string
      let resume = false
      if (req.runId && runExists(req.workspacePath, req.runId)) {
        if (isActive(req.runId)) {
          // UI can show done while finally is still flushing; wait for unwind
          // instead of failing a quick next send with "Run is already active".
          if (isRunTurnComplete(req.runId)) {
            const cleared = await waitUntilRunInactive(req.runId)
            if (!cleared || isActive(req.runId)) {
              return fail('Run is already active')
            }
          } else {
            return fail('Run is already active')
          }
        }
        runId = req.runId
        resume = true
      } else {
        runId = createRunId()
      }
      // Atomic register BEFORE return so cancel works during startup and concurrent
      // chatStart cannot overlap the same runDir (check+set with no await gap).
      const registered = tryRegisterRunAbort(runId, req.workspacePath)
      if (!registered.ok) {
        return fail(registered.error)
      }
      const { invokeId } = registered
      logger.info('Chat start', {
        scope: 'ipc',
        correlationId: runId,
        channel: IPC.chatStart,
        resume
      })

      ;(async () => {
        let terminalSent = false
        // IPC `incremental` stays on the schema for client stability; the loop
        // keys off resume + newMessages (not a separate incremental branch).
        const agentInput =
          req.incremental && req.runId && req.newMessages?.length
            ? {
                runId,
                workspacePath: req.workspacePath,
                resume,
                newMessages: req.newMessages,
                mode: req.mode
              }
            : {
                runId,
                messages: req.messages ?? [],
                workspacePath: req.workspacePath,
                resume,
                mode: req.mode
              }
        // Stamp the invoke on every event so the renderer can tell a live event apart
        // from one arriving late from the previous turn of the same run.
        const sendEvent = (ev: AgentEvent): void => {
          sendToCurrentRenderer(IPC.chatEvent, { ...ev, invokeId }, wc)
        }
        const batcher = new ChatEventBatcher(sendEvent, {
          runId,
          workspacePath: req.workspacePath
        })
        const releaseApprovalSender = registerApprovalSender(runId, (request) => {
          // The gate is parked on this prompt, so it has to jump the event batcher.
          batcher.flush()
          sendToCurrentRenderer(IPC.toolApprovalRequest, request, wc)
        })
        const releaseQuestionSender = registerQuestionSender(runId, (request) => {
          batcher.flush()
          sendToCurrentRenderer(IPC.agentQuestionRequest, request, wc)
        })
        try {
          for await (const ev of runAgent(agentInput)) {
            const terminal = isTerminalChatEvent(ev as AgentEvent)
            if (terminal) terminalSent = true
            batcher.push(ev as AgentEvent)
            // Loop already called tryBeginRunClosing before terminal yield; keep
            // mark as a safety net for abort/error paths that skip that helper.
            if (terminal) markRunTurnComplete(runId, invokeId)
          }
        } catch (err) {
          if (isAbortError(err)) {
            logger.warn('Chat run aborted', {
              scope: 'ipc',
              correlationId: runId
            })
            if (!terminalSent) {
              batcher.push({ type: 'status', runId, status: 'cancelled' })
            }
            return
          }
          const message = formatError(err)
          logger.error(`Chat run crashed: ${logErrorSummary(err, 'AGENT_LOOP')}`, {
            scope: 'ipc',
            code: 'AGENT_LOOP',
            correlationId: runId,
            err
          })
          if (!terminalSent) {
            batcher.push({ type: 'error', runId, message, code: 'AGENT_LOOP' })
            batcher.push({ type: 'status', runId, status: 'error' })
          }
        } finally {
          batcher.flush()
          batcher.dispose()
          if (process.env.VYOTIQ_PERF === '1') {
            const stats = getChatEventBatchStats()
            console.info('[vyotiq-perf] chatEvent batch', JSON.stringify(stats))
            // Keep counters across concurrent runs; only reset when none remain.
            if (stats.attachedRuns === 0) resetChatEventBatchStats()
          }
          releaseApprovalSender()
          releaseQuestionSender()
          cancelPendingApprovals(runId, invokeId)
          cancelPendingQuestions(runId, invokeId)
          // clearRunAbort lives in runAgent's finally (single owner).
        }
      })()

      return ok({ runId, invokeId })
    } catch (err) {
      return failFrom(err, IPC.chatStart)
    }
  })

  ipcMain.handle(
    IPC.chatRewindAndStart,
    async (event, raw): Promise<IpcResult<ChatStartResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatRewindAndStartRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) {
          return fail('Workspace is not open')
        }
        if (!existsSync(req.workspacePath)) {
          return fail('Workspace path does not exist')
        }
        if (!runExists(req.workspacePath, req.runId)) {
          return fail('Run not found')
        }

        if (isActive(req.runId)) {
          const cancelled = chatCancelResult(req.runId)
          if (!cancelled.ok) return fail(cancelled.error)
          const cleared = await waitUntilRunInactive(req.runId)
          if (!cleared || isActive(req.runId)) {
            return fail('Run is already active')
          }
        }

        // Register before mutating disk so a failed register cannot leave a
        // rewound transcript without a new invoke (matches chatStart ordering).
        const runId = req.runId
        const registered = tryRegisterRunAbort(runId, req.workspacePath)
        if (!registered.ok) {
          return fail(registered.error)
        }
        const { invokeId } = registered

        let prepared: Awaited<ReturnType<typeof prepareRewindAndReplaceUserMessage>>
        try {
          prepared = await prepareRewindAndReplaceUserMessage({
            workspacePath: req.workspacePath,
            runId: req.runId,
            editMessageIndex: req.editMessageIndex,
            editedUserMessage: req.editedUserMessage
          })
        } catch (err) {
          clearRunAbort(runId, invokeId)
          throw err
        }
        if (prepared.writes.restored.length > 0) {
          invalidateGitStatusCache(req.workspacePath)
        }

        const wc = event.sender
        logger.info('Chat rewind and start', {
          scope: 'ipc',
          correlationId: runId,
          channel: IPC.chatRewindAndStart,
          editMessageIndex: req.editMessageIndex,
          restoredFiles: prepared.writes.restored.length
        })

        ;(async () => {
          let terminalSent = false
          const agentInput = {
            runId,
            workspacePath: req.workspacePath,
            resume: true as const,
            mode: req.mode
          }
          const sendEvent = (ev: AgentEvent): void => {
            sendToCurrentRenderer(IPC.chatEvent, { ...ev, invokeId }, wc)
          }
          const batcher = new ChatEventBatcher(sendEvent, {
            runId,
            workspacePath: req.workspacePath
          })
          const releaseApprovalSender = registerApprovalSender(runId, (request) => {
            batcher.flush()
            sendToCurrentRenderer(IPC.toolApprovalRequest, request, wc)
          })
          const releaseQuestionSender = registerQuestionSender(runId, (request) => {
            batcher.flush()
            sendToCurrentRenderer(IPC.agentQuestionRequest, request, wc)
          })
          try {
            for await (const ev of runAgent(agentInput)) {
              const terminal = isTerminalChatEvent(ev as AgentEvent)
              if (terminal) terminalSent = true
              batcher.push(ev as AgentEvent)
              if (terminal) markRunTurnComplete(runId, invokeId)
            }
          } catch (err) {
            if (isAbortError(err)) {
              logger.warn('Chat rewind run aborted', {
                scope: 'ipc',
                correlationId: runId
              })
              if (!terminalSent) {
                batcher.push({ type: 'status', runId, status: 'cancelled' })
              }
              return
            }
            const message = formatError(err)
            logger.error(`Chat rewind run crashed: ${logErrorSummary(err, 'AGENT_LOOP')}`, {
              scope: 'ipc',
              code: 'AGENT_LOOP',
              correlationId: runId,
              err
            })
            if (!terminalSent) {
              batcher.push({ type: 'error', runId, message, code: 'AGENT_LOOP' })
              batcher.push({ type: 'status', runId, status: 'error' })
            }
          } finally {
            batcher.flush()
            batcher.dispose()
            releaseApprovalSender()
            releaseQuestionSender()
            cancelPendingApprovals(runId, invokeId)
            cancelPendingQuestions(runId, invokeId)
          }
        })()

        return ok({ runId, invokeId })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // prepareRewind user-state (index/role/missing run) — not IPC_HANDLER.
        if (/editMessageIndex|run not found/i.test(msg)) {
          return fail(msg)
        }
        return failFrom(err, IPC.chatRewindAndStart)
      }
    }
  )

  ipcMain.handle(IPC.toolApprovalResponse, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const response = ToolApprovalResponseSchema.parse(raw)
      if (!isActive(response.runId)) return fail('Run is not active')
      const workspace = getRunWorkspace(response.runId)
      if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
      return ok(resolveToolApproval(response))
    } catch (err) {
      return failFrom(err, IPC.toolApprovalResponse)
    }
  })

  ipcMain.handle(
    IPC.toolApprovalListPending,
    async (event, raw): Promise<IpcResult<ToolApprovalRequest[]>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { runId } = ListPendingToolApprovalsRequestSchema.parse(raw)
        const workspace = getRunWorkspace(runId)
        if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
        return ok(listPendingToolApprovals(runId))
      } catch (err) {
        return failFrom(err, IPC.toolApprovalListPending)
      }
    }
  )

  ipcMain.handle(IPC.agentQuestionResponse, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const response = AgentQuestionResponseSchema.parse(raw)
      if (!isActive(response.runId)) return fail('Run is not active')
      const workspace = getRunWorkspace(response.runId)
      if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
      return ok(resolveAgentQuestion(response))
    } catch (err) {
      return failFrom(err, IPC.agentQuestionResponse)
    }
  })

  ipcMain.handle(
    IPC.agentQuestionListPending,
    async (event, raw): Promise<IpcResult<AgentQuestionRequest[]>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { runId } = ListPendingAgentQuestionsRequestSchema.parse(raw)
        const workspace = getRunWorkspace(runId)
        if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
        return ok(listPendingAgentQuestions(runId))
      } catch (err) {
        return failFrom(err, IPC.agentQuestionListPending)
      }
    }
  )

  ipcMain.handle(
    IPC.attachmentExtract,
    async (event, raw): Promise<IpcResult<ExtractAttachmentResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ExtractAttachmentRequestSchema.parse(raw)
        return ok(await extractAttachment(req))
      } catch (err) {
        return failFrom(err, IPC.attachmentExtract)
      }
    }
  )

  ipcMain.handle(IPC.chatCancel, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { runId } = CancelRunRequestSchema.parse(raw)
      const workspace = getRunWorkspace(runId)
      if (!workspace || !isOpenWorkspace(workspace)) return fail('Run not found')
      logger.info('Chat cancel', { scope: 'ipc', correlationId: runId })
      return chatCancelResult(runId)
    } catch (err) {
      return failFrom(err, IPC.chatCancel)
    }
  })

  ipcMain.handle(
    IPC.chatFollowUp,
    async (event, raw): Promise<IpcResult<ChatFollowUpResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatFollowUpRequestSchema.parse(raw)
        if (!isActive(req.runId)) {
          return fail('Run is not active')
        }
        const workspace = getRunWorkspace(req.runId)
        if (!workspace || !isOpenWorkspace(workspace)) {
          return fail('Workspace is not open')
        }
        const result = enqueueFollowUp(req.runId, req.message)
        if (!result.ok) return fail(result.error)
        logger.info('Chat follow-up queued', {
          scope: 'ipc',
          correlationId: req.runId,
          channel: IPC.chatFollowUp,
          queueLength: result.queueLength
        })
        // Notify the renderer so queue chrome stays in sync across optimistic UI.
        // Flush pending stream deltas first so follow_up_queued is not reordered
        // ahead of text already batched for this run. Match stream/approval routing
        // via sendToCurrentRenderer (not event.sender alone).
        getChatEventDispatcher().flush(req.runId)
        const invokeId = getRunInvokeId(req.runId)
        sendToCurrentRenderer(
          IPC.chatEvent,
          {
            type: 'follow_up_queued',
            runId: req.runId,
            id: result.id,
            position: result.position,
            queueLength: result.queueLength,
            preview: followUpPreview(req.message),
            ...(invokeId != null ? { invokeId } : {})
          } satisfies AgentEvent,
          event.sender
        )
        return ok({
          id: result.id,
          position: result.position,
          queueLength: result.queueLength
        })
      } catch (err) {
        return failFrom(err, IPC.chatFollowUp)
      }
    }
  )

  ipcMain.handle(
    IPC.chatFollowUpRemove,
    async (event, raw): Promise<IpcResult<ChatFollowUpRemoveResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatFollowUpRemoveRequestSchema.parse(raw)
        const workspace = getRunWorkspace(req.runId)
        if (!workspace || !isOpenWorkspace(workspace)) {
          return fail('Workspace is not open')
        }
        const result = removeFollowUp(req.runId, req.id)
        if (!result.ok) return fail(result.error)
        return ok({ removed: result.removed, queueLength: result.queueLength })
      } catch (err) {
        return failFrom(err, IPC.chatFollowUpRemove)
      }
    }
  )

  ipcMain.handle(IPC.chatCompact, async (event, raw): Promise<IpcResult<CompactRunResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = CompactRunRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (isActive(req.runId)) {
        return fail('Stop the run before compacting its history.')
      }
      logger.info('Manual compaction requested', {
        scope: 'ipc',
        correlationId: req.runId,
        channel: IPC.chatCompact
      })
      return ok(await compactRunNow(req))
    } catch (err) {
      if (err instanceof CompactionUnavailableError) return fail(err.message)
      return failFrom(err, IPC.chatCompact)
    }
  })

  ipcMain.handle(IPC.runsUndoWrites, async (event, raw): Promise<IpcResult<UndoWritesResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = UndoWritesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (isActive(req.runId)) {
        return fail('Stop the run before undoing agent writes.')
      }
      const runDir = resolveRunDir(req.workspacePath, req.runId)
      const result = undoWrites(runDir, req.workspacePath, req.checkpointId)
      persistWriteCheckpointEvent(runDir, req.runId, result.checkpointId)
      logger.info('Undid agent writes', {
        scope: 'ipc',
        correlationId: req.runId,
        channel: IPC.runsUndoWrites,
        checkpointId: result.checkpointId,
        restored: result.restored.length
      })
      return ok(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/no undoable write checkpoint/i.test(msg)) {
        return fail('Nothing to undo — no write checkpoint for this run.')
      }
      if (/already undone|checkpoint not found|invalid checkpoint/i.test(msg)) {
        return fail(msg)
      }
      return failFrom(err, IPC.runsUndoWrites)
    }
  })

  ipcMain.handle(
    IPC.runsResolveWrites,
    async (event, raw): Promise<IpcResult<ResolveWritesResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ResolveWritesRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (isActive(req.runId)) {
          return fail('Stop the run before resolving agent writes.')
        }
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        const result = resolveWrites(runDir, req.workspacePath, {
          checkpointId: req.checkpointId,
          action: req.action,
          paths: req.paths
        })
        persistWriteCheckpointEvent(runDir, req.runId, result.checkpointId)
        if (result.discarded.length > 0) {
          invalidateGitStatusCache(req.workspacePath)
        }
        logger.info('Resolved agent writes', {
          scope: 'ipc',
          correlationId: req.runId,
          channel: IPC.runsResolveWrites,
          checkpointId: result.checkpointId,
          action: req.action,
          kept: result.kept.length,
          discarded: result.discarded.length
        })
        return ok(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/already resolved|checkpoint not found|invalid checkpoint/i.test(msg)) {
          return fail(msg)
        }
        return failFrom(err, IPC.runsResolveWrites)
      }
    }
  )

  ipcMain.handle(
    IPC.runsReadArtifact,
    async (event, raw): Promise<IpcResult<ReadRunArtifactResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ReadRunArtifactRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        const filePath = join(runDir, req.name)
        if (!existsSync(filePath)) {
          return ok({ name: req.name, exists: false, content: null })
        }
        if (req.name === 'browser/snapshot.jpg') {
          const jpeg = readFileSync(filePath)
          return ok({
            name: req.name,
            exists: true,
            content: `data:image/jpeg;base64,${jpeg.toString('base64')}`
          })
        }
        const content = readFileSync(filePath, 'utf8')
        return ok({ name: req.name, exists: true, content })
      } catch (err) {
        return failFrom(err, IPC.runsReadArtifact)
      }
    }
  )

  ipcMain.handle(
    IPC.harnessReview,
    async (event, raw): Promise<IpcResult<HarnessReviewResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = HarnessReviewRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(
          await runHarnessReviewWithSettings(req.workspacePath, { limit: req.limit })
        )
      } catch (err) {
        return failFrom(err, IPC.harnessReview)
      }
    }
  )

  ipcMain.handle(
    IPC.harnessPreviewApply,
    async (event, raw): Promise<IpcResult<HarnessPreviewApplyResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = HarnessPreviewApplyRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!workspaceHasEditableHarness(req.workspacePath)) {
          return fail(
            `This workspace has no editable harness at ${WORKSPACE_HARNESS_REL}. Open the Agent V repo (or a fork) to apply harness changes.`
          )
        }
        return ok(previewHarnessApply(req.workspacePath, req.proposalPath))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          /no harness proposal found|missing a ## Proposed harness body|no editable harness/i.test(
            msg
          )
        ) {
          return fail(msg)
        }
        return failFrom(err, IPC.harnessPreviewApply)
      }
    }
  )

  ipcMain.handle(
    IPC.harnessApply,
    async (event, raw): Promise<IpcResult<HarnessApplyResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = HarnessApplyRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!workspaceHasEditableHarness(req.workspacePath)) {
          return fail(
            `This workspace has no editable harness at ${WORKSPACE_HARNESS_REL}. Open the Agent V repo (or a fork) to apply harness changes.`
          )
        }
        return ok(
          await applyHarnessProposal(req.workspacePath, {
            proposalPath: req.proposalPath,
            confirm: req.confirm
          })
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          /no harness proposal found|missing a ## Proposed harness body|requires confirm|no editable harness/i.test(
            msg
          )
        ) {
          return fail(msg)
        }
        return failFrom(err, IPC.harnessApply)
      }
    }
  )

  ipcMain.handle(IPC.listRuns, async (event, raw): Promise<IpcResult<ListRunsResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const body = (raw ?? {}) as { workspacePath?: string }
      const workspacePath = body.workspacePath?.trim() ?? ''
      if (!workspacePath) {
        return ok({ runs: [], capped: false })
      }
      const req = ListRunsRequestSchema.parse({ workspacePath })
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listRuns(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.listRuns)
    }
  })

  ipcMain.handle(
    IPC.loadRun,
    async (event, raw): Promise<IpcResult<{ messages: ChatMessage[]; runId: string }>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = LoadRunRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        const messages = await loadMessagesAsync(req.workspacePath, req.runId)
        return ok({ runId: req.runId, messages: messages.map(toolMessageForIpc) })
      } catch (err) {
        return failFrom(err, IPC.loadRun)
      }
    }
  )

  ipcMain.handle(
    IPC.loadRunEvents,
    async (event, raw): Promise<IpcResult<PersistedEvent[]>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = LoadRunEventsRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(
          await loadEventsForRunAsync(req.workspacePath, req.runId, {
            limit: LOAD_EVENTS_UI_LIMIT
          })
        )
      } catch (err) {
        return failFrom(err, IPC.loadRunEvents)
      }
    }
  )

  ipcMain.handle(IPC.loadToolResult, async (event, raw): Promise<IpcResult<{ content: string }>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = LoadToolResultRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const content = await loadToolResultContent(
        req.workspacePath,
        req.runId,
        req.toolCallId
      )
      if (content == null) return fail('Tool result not found')
      return ok({ content })
    } catch (err) {
      return failFrom(err, IPC.loadToolResult)
    }
  })

  ipcMain.handle(IPC.runsDelete, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = DeleteRunRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = deleteRun(req.workspacePath, req.runId)
      if (!result.ok) return fail(result.error)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.runsDelete)
    }
  })

  ipcMain.handle(
    IPC.runsRename,
    async (event, raw): Promise<IpcResult<RunSummary>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = RenameRunRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(renameRun(req.workspacePath, req.runId, req.goal))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Same user-state class as runsDelete result.error (active / missing / corrupt).
        if (/cancel run first|run not found|invalid run status/i.test(msg)) {
          return fail(msg)
        }
        return failFrom(err, IPC.runsRename)
      }
    }
  )

  ipcMain.handle(IPC.runsActive, async (event): Promise<IpcResult<ActiveRunsResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(listActiveRuns())
    } catch (err) {
      return failFrom(err, IPC.runsActive)
    }
  })

  ipcMain.handle(IPC.gitStatus, async (event, raw): Promise<IpcResult<GitStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStatusRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitStatusCached(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitStatus)
    }
  })

  ipcMain.handle(IPC.gitCommit, async (event, raw): Promise<IpcResult<GitCommitResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCommitRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await commitAll(
        req.workspacePath,
        req.message,
        req.push === true,
        req.mode ?? 'all'
      )
      invalidateGitStatusCache(req.workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.gitCommit)
    }
  })

  ipcMain.handle(IPC.gitStageAll, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStageAllRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await stageAll(req.workspacePath)
      invalidateGitStatusCache(req.workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.gitStageAll)
    }
  })

  ipcMain.handle(IPC.gitStagePaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStagePathsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await stagePaths(req.workspacePath, req.paths)
      invalidateGitStatusCache(req.workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.gitStagePaths)
    }
  })

  ipcMain.handle(IPC.gitUnstagePaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitUnstagePathsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await unstagePaths(req.workspacePath, req.paths)
      invalidateGitStatusCache(req.workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.gitUnstagePaths)
    }
  })

  ipcMain.handle(IPC.gitBranches, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listLocalBranches(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitBranches)
    }
  })

  ipcMain.handle(IPC.gitCheckout, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCheckoutRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await checkoutBranch(req.workspacePath, req.branch)
      invalidateGitStatusCache(req.workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.gitCheckout)
    }
  })

  ipcMain.handle(IPC.gitLog, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitLogRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitLog(req.workspacePath, req.limit))
    } catch (err) {
      return failFrom(err, IPC.gitLog)
    }
  })

  ipcMain.handle(IPC.gitCommitFiles, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCommitFilesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok({ files: await readGitCommitFiles(req.workspacePath, req.sha) })
    } catch (err) {
      return failFrom(err, IPC.gitCommitFiles)
    }
  })

  ipcMain.handle(IPC.gitDiff, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitDiffRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await readGitDiff(req.workspacePath, {
        path: req.path,
        staged: req.staged,
        ignoreWhitespace: req.ignoreWhitespace,
        sha: req.sha
      })
      if (!result.ok) return fail(result.error)
      return ok({ content: result.content })
    } catch (err) {
      return failFrom(err, IPC.gitDiff)
    }
  })

  ipcMain.handle(IPC.prView, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrViewRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prView(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.prView)
    }
  })

  ipcMain.handle(IPC.prMerge, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrMergeRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prMerge(req.workspacePath, req.method))
    } catch (err) {
      return failFrom(err, IPC.prMerge)
    }
  })

  ipcMain.handle(IPC.prDiff, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrDiffRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await prDiff(req.workspacePath, {
          path: req.path,
          ignoreWhitespace: req.ignoreWhitespace
        })
      )
    } catch (err) {
      return failFrom(err, IPC.prDiff)
    }
  })

  ipcMain.handle(IPC.prClose, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrCloseRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prClose(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.prClose)
    }
  })

  ipcMain.handle(IPC.prEditTitle, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrEditTitleRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prEditTitle(req.workspacePath, req.title))
    } catch (err) {
      return failFrom(err, IPC.prEditTitle)
    }
  })

  ipcMain.handle(IPC.githubAuthStatus, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await githubAuthStatus())
    } catch (err) {
      return failFrom(err, IPC.githubAuthStatus)
    }
  })

  ipcMain.handle(IPC.githubAuthStart, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await startGithubAuth())
    } catch (err) {
      return failFrom(err, IPC.githubAuthStart)
    }
  })

  ipcMain.handle(IPC.githubAuthCancel, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      cancelGithubAuth()
      return ok(await githubAuthStatus())
    } catch (err) {
      return failFrom(err, IPC.githubAuthCancel)
    }
  })

  ipcMain.handle(IPC.githubAuthLogout, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await logoutGithubAuth())
    } catch (err) {
      return failFrom(err, IPC.githubAuthLogout)
    }
  })

  ipcMain.handle(IPC.shellOpenExternal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ShellOpenExternalRequestSchema.parse(raw)
      let parsed: URL
      try {
        parsed = new URL(req.url)
      } catch {
        return fail('Invalid URL')
      }
      if (parsed.protocol !== 'https:') {
        return fail('Only https URLs can be opened')
      }
      await shell.openExternal(parsed.toString())
      return ok(true as const)
    } catch (err) {
      return failFrom(err, IPC.shellOpenExternal)
    }
  })

  ipcMain.handle(IPC.ptyCreate, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyCreateRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return fail('No window')
      return ok(
        createPtySession({
          cwd: req.workspacePath,
          cols: req.cols,
          rows: req.rows,
          sendTo: win
        })
      )
    } catch (err) {
      return failFrom(err, IPC.ptyCreate)
    }
  })

  ipcMain.handle(IPC.ptyList, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyListRequestSchema.parse(raw ?? {})
      if (req.workspacePath && !isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      // Never disclose sessions (cwd paths) of workspaces that are not open.
      return ok(listPtySessions(req.workspacePath, (path) => isOpenWorkspace(path)))
    } catch (err) {
      return failFrom(err, IPC.ptyList)
    }
  })

  ipcMain.handle(IPC.ptyWrite, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyWriteRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(writePty(req.id, req.data, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyWrite)
    }
  })

  ipcMain.handle(IPC.ptyResize, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyResizeRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(resizePty(req.id, req.cols, req.rows, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyResize)
    }
  })

  ipcMain.handle(IPC.ptyKill, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyIdRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(killPty(req.id, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyKill)
    }
  })

  ipcMain.handle(IPC.logsGetPath, async (event): Promise<IpcResult<string>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(logsDirectory())
    } catch (err) {
      return failFrom(err, IPC.logsGetPath)
    }
  })

  ipcMain.handle(IPC.logsOpenDir, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const dir = logsDirectory()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const result = await shell.openPath(dir)
      if (result) {
        logger.warn('Failed to open logs directory', {
          scope: 'ipc',
          code: 'IPC_HANDLER',
          channel: IPC.logsOpenDir,
          err: scrubString(result)
        })
        return fail('Could not open the logs folder', 'IPC_HANDLER')
      }
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.logsOpenDir)
    }
  })

  ipcMain.handle(
    IPC.crashDiagnosticsGet,
    async (event): Promise<IpcResult<CrashDiagnosticsSnapshot>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        return ok(getCrashDiagnosticsSnapshot())
      } catch (err) {
        return failFrom(err, IPC.crashDiagnosticsGet)
      }
    }
  )

  ipcMain.handle(
    IPC.crashRecoveryConsume,
    async (event): Promise<IpcResult<CrashRecoveryPending | null>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        return ok(consumeRendererRecoveryPending())
      } catch (err) {
        return failFrom(err, IPC.crashRecoveryConsume)
      }
    }
  )

  ipcMain.handle(IPC.telemetryStatus, async (event): Promise<IpcResult<TelemetryStatus>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok({
        dsnConfigured: isSentryBuildConfigured(),
        telemetryEnabled: getSettings().telemetryEnabled
      })
    } catch (err) {
      return failFrom(err, IPC.telemetryStatus)
    }
  })

  ipcMain.handle(IPC.mcpStatus, async (event, raw): Promise<IpcResult<McpStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpStatusRequestSchema.parse(raw ?? {})
      const workspaces = getWorkspaces()
      const requestedPath =
        typeof req.workspacePath === 'string' ? req.workspacePath.trim() || null : undefined
      if (requestedPath && !isOpenWorkspace(requestedPath)) {
        return fail('Workspace is not open')
      }
      const workspacePath = requestedPath !== undefined ? requestedPath : workspaces.activePath
      const overrides = workspacePath
        ? findWorkspaceSettingsOverride(workspaces, workspacePath)?.marketplaceOverrides ?? null
        : null
      const servers = resolveEffectiveMcpServers(overrides)
      return ok({ servers: getMcpServerStatus(servers) })
    } catch (err) {
      return failFrom(err, IPC.mcpStatus)
    }
  })

  ipcMain.handle(IPC.mcpRefresh, async (event, raw): Promise<IpcResult<McpStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpRefreshRequestSchema.parse(raw ?? {})
      const workspaces = getWorkspaces()
      const requestedPath =
        typeof req.workspacePath === 'string' ? req.workspacePath.trim() || null : undefined
      if (requestedPath && !isOpenWorkspace(requestedPath)) {
        return fail('Workspace is not open')
      }
      const workspacePath = requestedPath !== undefined ? requestedPath : workspaces.activePath
      const overrides = workspacePath
        ? findWorkspaceSettingsOverride(workspaces, workspacePath)?.marketplaceOverrides ?? null
        : null
      await refreshMcpServers(resolveMcpServersForSessionMap())
      return ok({ servers: getMcpServerStatus(resolveEffectiveMcpServers(overrides)) })
    } catch (err) {
      return failFrom(err, IPC.mcpRefresh)
    }
  })

  ipcMain.handle(IPC.mcpSetAuthToken, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId, token } = McpSetAuthTokenRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => setMcpAuthToken(serverId, token))
      await enqueueSettingsMutation(() => {
        invalidateMcpResolveCache()
        const settings = getSettings()
        const nextServers = (settings.mcpServers ?? []).map((s) =>
          s.id === serverId
            ? { ...s, headers: headersWithoutAuthorization(s.headers) }
            : s
        )
        setSettings({ mcpServers: nextServers })
      })
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpSetAuthToken)
    }
  })

  ipcMain.handle(IPC.mcpClearAuthToken, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId } = McpClearAuthTokenRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        clearMcpAuthToken(serverId)
        clearMcpOAuthState(serverId)
      })
      await enqueueSettingsMutation(() => {
        invalidateMcpResolveCache()
        const settings = getSettings()
        const nextServers = (settings.mcpServers ?? []).map((s) =>
          s.id === serverId
            ? { ...s, headers: headersWithoutAuthorization(s.headers) }
            : s
        )
        setSettings({ mcpServers: nextServers })
      })
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpClearAuthToken)
    }
  })

  ipcMain.handle(IPC.mcpStartOAuth, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId } = McpStartOAuthRequestSchema.parse(raw)
      await startMcpOAuth(serverId)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok({ servers: getMcpServerStatus(resolveEffectiveMcpServers()) })
    } catch (err) {
      return failFrom(err, IPC.mcpStartOAuth)
    }
  })

  ipcMain.handle(IPC.marketplaceListInstalled, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(readMarketplaceIndex())
    } catch (err) {
      return failFrom(err, IPC.marketplaceListInstalled)
    }
  })

  ipcMain.handle(IPC.marketplaceBrowse, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceBrowseRequestSchema.parse(raw ?? {})
      const packages = await browseCatalog(req)
      return ok({ packages })
    } catch (err) {
      return failFrom(err, IPC.marketplaceBrowse)
    }
  })

  ipcMain.handle(IPC.marketplaceRefreshCatalog, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const remote = await refreshRemoteCatalog()
      const packages = await browseCatalog()
      return ok({ packages, remoteCount: remote.packages.length })
    } catch (err) {
      return failFrom(err, IPC.marketplaceRefreshCatalog)
    }
  })

  ipcMain.handle(IPC.marketplaceInstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceInstallRequestSchema.parse(raw)
      const result = await installMarketplacePackage(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceInstall)
    }
  })

  ipcMain.handle(IPC.marketplaceDetectMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpDetectRequestSchema.parse(raw)
      const result = await detectMcpInput(req)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceDetectMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceApplyDetectedMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpApplyDetectedRequestSchema.parse(raw)
      if (req.install) {
        const result = await installMarketplacePackage(req.install)
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
        return ok({
          applied: 'marketplace' as const,
          serverId: result.item.id,
          installResult: result
        })
      }
      const applied = applyDetectedManualMcp(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(applied)
    } catch (err) {
      return failFrom(err, IPC.marketplaceApplyDetectedMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceScanExternalMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpScanExternalRequestSchema.parse(raw ?? {})
      return ok(scanExternalMcpConfigs(req))
    } catch (err) {
      return failFrom(err, IPC.marketplaceScanExternalMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceImportExternalMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpImportExternalRequestSchema.parse(raw)
      const result = await importExternalMcpServers(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceImportExternalMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceUninstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { id } = MarketplaceUninstallRequestSchema.parse(raw)
      const index = removeInstalledItem(id)
      await syncMarketplaceMcpIntoSettings()
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(index)
    } catch (err) {
      return failFrom(err, IPC.marketplaceUninstall)
    }
  })

  ipcMain.handle(IPC.marketplaceSetEnabled, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { id, enabled } = MarketplaceSetEnabledRequestSchema.parse(raw)
      const index = setInstalledEnabled(id, enabled)
      invalidateMcpResolveCache()
      const item = index.items.find((i) => i.id === id)
      if (item?.kind === 'mcp' || item?.kind === 'plugin') {
        if (item.kind === 'mcp') await syncMarketplaceMcpIntoSettings()
        await syncMcpServers(resolveMcpServersForSessionMap())
      }
      return ok(index)
    } catch (err) {
      return failFrom(err, IPC.marketplaceSetEnabled)
    }
  })

  ipcMain.handle(IPC.marketplacePickLocal, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Add marketplace package',
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Packages', extensions: ['zip', 'tgz', 'json', 'md'] },
          { name: 'All', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return ok(null)
      return ok(result.filePaths[0])
    } catch (err) {
      return failFrom(err, IPC.marketplacePickLocal)
    }
  })

  ipcMain.handle(IPC.marketplaceGetContents, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceGetContentsRequestSchema.parse(raw)
      const contents = getPackageContents(req.id)
      if (!contents) return fail('Package not found')
      return ok(contents)
    } catch (err) {
      return failFrom(err, IPC.marketplaceGetContents)
    }
  })

  ipcMain.handle(IPC.marketplaceAckRemoteInstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceRemoteInstallAckRequestSchema.parse(raw ?? { acked: true })
      if (req.acked) {
        const win = BrowserWindow.fromWebContents(event.sender)
        const message =
          'Marketplace packages (remote catalogs, git/npm/zip, local path folders) and MCP endpoints are unsigned. Install only from sources you trust.'
        const result = win
          ? await dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['Cancel', 'Continue'],
              defaultId: 1,
              cancelId: 0,
              title: 'Acknowledge marketplace risk',
              message
            })
          : await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Cancel', 'Continue'],
              defaultId: 1,
              cancelId: 0,
              title: 'Acknowledge marketplace risk',
              message
            })
        if (result.response !== 1) {
          return ok(redactSettingsForIpc(getSettings()))
        }
      }
      const next = await enqueueSettingsMutation(() =>
        setMarketplaceRemoteInstallAcked(req.acked)
      )
      return ok(redactSettingsForIpc(next))
    } catch (err) {
      return failFrom(err, IPC.marketplaceAckRemoteInstall)
    }
  })

  ipcMain.handle(IPC.slashCommandsList, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsListRequestSchema.parse(raw ?? {})
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      const commands = await listSlashCommands(workspacePath)
      return ok({ commands })
    } catch (err) {
      return failFrom(err, IPC.slashCommandsList)
    }
  })

  ipcMain.handle(IPC.slashCommandsResolve, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsResolveRequestSchema.parse(raw)
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      const result = await resolveSlashCommand(req.id, {
        workspacePath,
        trailingText: req.trailingText
      })
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.slashCommandsResolve)
    }
  })

  ipcMain.handle(IPC.slashCommandsCreateRule, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsCreateRuleRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      const result = await createWorkspaceRule(req.workspacePath, req.title)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.slashCommandsCreateRule)
    }
  })

  ipcMain.handle(IPC.slashCommandsOpenFile, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsOpenFileRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      const root = canonicalizeWorkspacePath(req.workspacePath)
      const trimmed = req.path.trim()
      let rel = trimmed.replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(rel)) {
        // Absolute path under the workspace — convert to a safe relative path.
        const target = canonicalizeWorkspacePath(trimmed)
        rel = relative(root, target).replace(/\\/g, '/')
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || !isSafeWorkspaceRelPath(rel)) {
          return fail('Path is outside the workspace')
        }
      }
      const abs = resolveInsideWorkspace(req.workspacePath, rel)
      await openSlashFile(abs)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.slashCommandsOpenFile)
    }
  })

  ipcMain.handle(IPC.workspaceSuggestPaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceSuggestPathsRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      const maxResults = req.maxResults ?? 24
      const query = (req.query ?? '').trim().toLowerCase().replace(/\\/g, '/')
      const files = await collectWorkspaceFiles(req.workspacePath, 8_000)
      const matched = files
        .map((f) => f.rel.replace(/\\/g, '/'))
        .filter((rel) => {
          if (!isSafeWorkspaceRelPath(rel)) return false
          return query ? rel.toLowerCase().includes(query) : true
        })
        .sort((a, b) => {
          if (!query) return a.localeCompare(b)
          const aBase = a.toLowerCase().includes(`/${query}`) || a.toLowerCase().startsWith(query)
          const bBase = b.toLowerCase().includes(`/${query}`) || b.toLowerCase().startsWith(query)
          if (aBase !== bBase) return aBase ? -1 : 1
          return a.localeCompare(b)
        })
      return ok({ paths: matched.slice(0, maxResults), total: matched.length })
    } catch (err) {
      return failFrom(err, IPC.workspaceSuggestPaths)
    }
  })

  ipcMain.handle(IPC.workspaceReadText, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceReadTextRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const rel = String(req.path ?? '').trim().replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(rel)) {
        return fail('Path is outside the workspace')
      }
      const abs = resolveInsideWorkspace(req.workspacePath, rel)
      const st = statSync(abs)
      if (!st.isFile()) return fail('Not a file')
      if (st.size > MAX_ATTACHMENT_BYTES) {
        return fail(
          `File is larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB`
        )
      }
      const bytes = readFileSync(abs)
      const data = bytes.toString('base64')
      const result = await extractAttachment({
        name: rel,
        mime: '',
        data
      })
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.workspaceReadText)
    }
  })

  ipcMain.handle(IPC.workspaceReadImage, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceReadImageRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const rel = String(req.path ?? '').trim().replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(rel)) {
        return fail('Path is outside the workspace')
      }
      const lower = rel.toLowerCase()
      const mime =
        lower.endsWith('.jpg') || lower.endsWith('.jpeg')
          ? 'image/jpeg'
          : lower.endsWith('.webp')
            ? 'image/webp'
            : lower.endsWith('.gif')
              ? 'image/gif'
              : lower.endsWith('.svg')
                ? 'image/svg+xml'
                : lower.endsWith('.png')
                  ? 'image/png'
                  : null
      if (!mime) return fail('Not an image file (png, jpg, jpeg, webp, gif, svg)')
      const abs = resolveInsideWorkspace(req.workspacePath, rel)
      const st = statSync(abs)
      if (!st.isFile()) return fail('Not a file')
      if (st.size > WORKSPACE_IMAGE_PREVIEW_MAX_BYTES) {
        return fail(
          `Image is larger than ${Math.round(WORKSPACE_IMAGE_PREVIEW_MAX_BYTES / (1024 * 1024))}MB for preview`
        )
      }
      const bytes = readFileSync(abs)
      if (bytes.length === 0) return fail('Image is empty')
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
      return ok({ path: rel, mime, dataUrl, byteLength: bytes.length })
    } catch (err) {
      return failFrom(err, IPC.workspaceReadImage)
    }
  })

  ipcMain.handle(IPC.workspaceListDocs, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceListDocsRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const maxResults = req.maxResults ?? 40
      const query = (req.query ?? '').trim().toLowerCase().replace(/\\/g, '/')
      const files = await collectWorkspaceFiles(req.workspacePath, 8_000)
      const matched = files
        .map((f) => f.rel.replace(/\\/g, '/'))
        .filter((rel) => isSafeWorkspaceRelPath(rel) && isCuratedDocPath(rel))
        .filter((rel) => (query ? rel.toLowerCase().includes(query) : true))
        .sort((a, b) => a.localeCompare(b))
      return ok({ paths: matched.slice(0, maxResults) })
    } catch (err) {
      return failFrom(err, IPC.workspaceListDocs)
    }
  })

  ipcMain.handle(IPC.workspaceListRules, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceListRulesRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const rules = await listWorkspaceRulesForMention(req.workspacePath)
      return ok({
        rules: rules.filter((r) => isSafeWorkspaceRelPath(r.path))
      })
    } catch (err) {
      return failFrom(err, IPC.workspaceListRules)
    }
  })

  ipcMain.handle(IPC.workspaceDiagnostics, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceDiagnosticsRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const kind = req.kind ?? 'typecheck'
      const ac = new AbortController()
      const result = await toolDiagnosticsAsync(req.workspacePath, kind, ac.signal)
      return ok({ ok: result.ok, content: result.content, kind })
    } catch (err) {
      return failFrom(err, IPC.workspaceDiagnostics)
    }
  })

  ipcMain.handle(IPC.windowMinimize, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      win.minimize()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.windowMinimize)
    }
  })

  ipcMain.handle(IPC.windowMaximize, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return ok(win.isMaximized())
    } catch (err) {
      return failFrom(err, IPC.windowMaximize)
    }
  })

  ipcMain.handle(IPC.windowClose, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      win.close()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.windowClose)
    }
  })

  ipcMain.handle(IPC.windowIsMaximized, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      return ok(win.isMaximized())
    } catch (err) {
      return failFrom(err, IPC.windowIsMaximized)
    }
  })

  ipcMain.handle(IPC.browserGetState, async (event): Promise<IpcResult<AgentBrowserState>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(getAgentBrowserState())
    } catch (err) {
      return failFrom(err, IPC.browserGetState)
    }
  })

  ipcMain.handle(IPC.browserFocus, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(focusAgentBrowser())
    } catch (err) {
      return failFrom(err, IPC.browserFocus)
    }
  })

  ipcMain.handle(IPC.browserClose, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      closeAgentBrowser()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserClose)
    }
  })

  ipcMain.handle(IPC.browserSelectTab, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = BrowserSelectTabRequestSchema.parse(raw)
      const tabId = req.tabId.trim()
      if (!tabId) return fail('tabId is required')
      return ok(selectBrowserTab(tabId))
    } catch (err) {
      return failFrom(err, IPC.browserSelectTab)
    }
  })

  ipcMain.handle(IPC.browserBack, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await browserGoBack())
    } catch (err) {
      return failFrom(err, IPC.browserBack)
    }
  })

  ipcMain.handle(IPC.browserForward, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await browserGoForward())
    } catch (err) {
      return failFrom(err, IPC.browserForward)
    }
  })

  ipcMain.handle(IPC.browserNavigate, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const url = BrowserNavigateRequestSchema.parse(raw)
      await navigateUrl(url)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserNavigate)
    }
  })

  ipcMain.handle(IPC.browserReload, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const state = getAgentBrowserState()
      if (!state.url) return fail('No active page')
      await navigateUrl(state.url)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserReload)
    }
  })

  ipcMain.handle(
    IPC.browserTakeScreenshot,
    async (event, raw): Promise<IpcResult<{ path: string }>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const payload = BrowserTakeScreenshotRequestSchema.parse(raw)
        if (!isOpenWorkspace(payload.workspacePath)) return fail('Workspace is not open')
        const runDir = resolveRunDir(payload.workspacePath, payload.runId)
        const result = await takeBrowserScreenshot({
          runDir,
          tabId: payload.tabId
        })
        return ok(result)
      } catch (err) {
        return failFrom(err, IPC.browserTakeScreenshot)
      }
    }
  )

  ipcMain.handle(
    IPC.browserClearBrowsingData,
    async (
      event,
      raw
    ): Promise<IpcResult<{ cleared: 'history' | 'cookies' | 'cache' | 'all' }>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = BrowserClearBrowsingDataRequestSchema.parse(raw)
        return ok(await clearAgentBrowserData(req.kind))
      } catch (err) {
        return failFrom(err, IPC.browserClearBrowsingData)
      }
    }
  )

  ipcMain.handle(
    IPC.browserSetBounds,
    async (
      event,
      raw
    ): Promise<IpcResult<true>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        if (raw == null) {
          setAgentBrowserBounds(null)
          return ok(true)
        }
        const bounds = BrowserSetBoundsRequestSchema.parse(raw)
        setAgentBrowserBounds(bounds)
        return ok(true)
      } catch (err) {
        return failFrom(err, IPC.browserSetBounds)
      }
    }
  )

  ipcMain.handle(IPC.getSystemTheme, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(nativeTheme.shouldUseDarkColors)
    } catch (err) {
      return failFrom(err, IPC.getSystemTheme)
    }
  })
}
