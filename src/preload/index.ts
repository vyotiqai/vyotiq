import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/channels'
import { AgentEventSchema, ToolApprovalRequestSchema, AgentQuestionRequestSchema, AgentQuestionRejectSchema, AgentBrowserStateSchema } from '../shared/ipc'
import type { VyotiqApi } from '../shared/vyotiqApi'

export type { HostPlatform, VyotiqApi } from '../shared/vyotiqApi'

// Sentry is initialized in the renderer after settings.telemetryEnabled is known.

const api: VyotiqApi = {
  platform: process.platform,
  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace),
  getWorkspaces: () => ipcRenderer.invoke(IPC.workspacesGet),
  addWorkspace: (path) => ipcRenderer.invoke(IPC.workspacesAdd, path ? { path } : {}),
  removeWorkspace: (path, stopActiveRuns) =>
    ipcRenderer.invoke(IPC.workspacesRemove, { path, stopActiveRuns }),
  setActiveWorkspace: (path) => ipcRenderer.invoke(IPC.workspacesSetActive, { path }),
  updateWorkspaceUiState: (path, ui) =>
    ipcRenderer.invoke(IPC.workspacesUpdateUiState, { path, ui }),
  updateWorkspaceUiStateSync: (path, ui) =>
    ipcRenderer.send(IPC.workspacesUpdateUiStateSync, { path, ui }),
  setWorkspaceSettingsOverride: (path, override) =>
    ipcRenderer.invoke(IPC.workspacesSetSettingsOverride, { path, override }),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (partial) => ipcRenderer.invoke(IPC.setSettings, partial),
  setSecret: (provider, key) => ipcRenderer.invoke(IPC.setSecret, { provider, key }),
  clearSecret: (provider) => ipcRenderer.invoke(IPC.clearSecret, { provider }),
  secretStatus: () => ipcRenderer.invoke(IPC.secretStatus),
  listModels: (payload) => ipcRenderer.invoke(IPC.listModels, payload),
  chatStart: (payload) => ipcRenderer.invoke(IPC.chatStart, payload),
  chatRewindAndStart: (payload) => ipcRenderer.invoke(IPC.chatRewindAndStart, payload),
  chatRewind: (payload) => ipcRenderer.invoke(IPC.chatRewind, payload),
  chatCancel: (runId) => ipcRenderer.invoke(IPC.chatCancel, { runId }),
  chatFollowUp: (payload) => ipcRenderer.invoke(IPC.chatFollowUp, payload),
  chatFollowUpRemove: (payload) => ipcRenderer.invoke(IPC.chatFollowUpRemove, payload),
  chatFollowUpUpdate: (payload) => ipcRenderer.invoke(IPC.chatFollowUpUpdate, payload),
  chatFollowUpPromote: (payload) => ipcRenderer.invoke(IPC.chatFollowUpPromote, payload),
  chatQueueMode: (payload) => ipcRenderer.invoke(IPC.chatQueueMode, payload),
  chatCompact: (workspacePath, runId) =>
    ipcRenderer.invoke(IPC.chatCompact, { workspacePath, runId }),
  undoWrites: (workspacePath, runId, checkpointId) =>
    ipcRenderer.invoke(IPC.runsUndoWrites, {
      workspacePath,
      runId,
      ...(checkpointId ? { checkpointId } : {})
    }),
  resolveWrites: (payload) => ipcRenderer.invoke(IPC.runsResolveWrites, payload),
  readRunArtifact: (payload) => ipcRenderer.invoke(IPC.runsReadArtifact, payload),
  harnessReview: (payload) => ipcRenderer.invoke(IPC.harnessReview, payload),
  harnessPreviewApply: (payload) => ipcRenderer.invoke(IPC.harnessPreviewApply, payload),
  harnessApply: (payload) => ipcRenderer.invoke(IPC.harnessApply, payload),
  onChatEvent: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = AgentEventSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn('[vyotiq] Invalid chat event dropped', parsed.error.issues[0]?.message)
        return
      }
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.chatEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, listener)
    }
  },
  onToolApprovalRequest: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = ToolApprovalRequestSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn('[vyotiq] Invalid approval request dropped', parsed.error.issues[0]?.message)
        return
      }
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.toolApprovalRequest, listener)
    return () => {
      ipcRenderer.removeListener(IPC.toolApprovalRequest, listener)
    }
  },
  respondToolApproval: (requestId, decision, runId) =>
    ipcRenderer.invoke(IPC.toolApprovalResponse, { requestId, decision, runId }),
  listPendingToolApprovals: (runId) =>
    ipcRenderer.invoke(IPC.toolApprovalListPending, { runId }),
  onAgentQuestionRequest: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = AgentQuestionRequestSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn(
          '[vyotiq] Invalid question request dropped',
          parsed.error.issues[0]?.message
        )
        const rejectParsed = AgentQuestionRejectSchema.safeParse(raw)
        if (rejectParsed.success) {
          void ipcRenderer.invoke(IPC.agentQuestionReject, rejectParsed.data)
          return
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const partial = raw as { requestId?: unknown; runId?: unknown }
          const requestId =
            typeof partial.requestId === 'string' && partial.requestId.trim()
              ? partial.requestId
              : undefined
          const runId =
            typeof partial.runId === 'string' && partial.runId.trim()
              ? partial.runId
              : undefined
          // Either id is enough — main looks up pending by requestId or runId.
          if (requestId || runId) {
            void ipcRenderer.invoke(IPC.agentQuestionReject, {
              ...(requestId ? { requestId } : {}),
              ...(runId ? { runId } : {}),
              reason: parsed.error.issues[0]?.message
            })
          }
        }
        return
      }
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.agentQuestionRequest, listener)
    return () => {
      ipcRenderer.removeListener(IPC.agentQuestionRequest, listener)
    }
  },
  respondAgentQuestion: (requestId, answers, runId) =>
    ipcRenderer.invoke(IPC.agentQuestionResponse, { requestId, answers, runId }),
  listPendingAgentQuestions: (runId) =>
    ipcRenderer.invoke(IPC.agentQuestionListPending, { runId }),
  extractAttachment: (payload) => ipcRenderer.invoke(IPC.attachmentExtract, payload),
  listRuns: (workspacePath) => {
    const path = workspacePath?.trim() ?? ''
    if (!path) {
      return Promise.resolve({ ok: true as const, data: { runs: [], capped: false } })
    }
    return ipcRenderer.invoke(IPC.listRuns, { workspacePath: path })
  },
  loadRun: (workspacePath, runId) => ipcRenderer.invoke(IPC.loadRun, { workspacePath, runId }),
  loadRunEvents: (workspacePath, runId) =>
    ipcRenderer.invoke(IPC.loadRunEvents, { workspacePath, runId }),
  loadToolResult: (workspacePath, runId, toolCallId) =>
    ipcRenderer.invoke(IPC.loadToolResult, { workspacePath, runId, toolCallId }),
  deleteRun: (workspacePath, runId) =>
    ipcRenderer.invoke(IPC.runsDelete, { workspacePath, runId }),
  renameRun: (workspacePath, runId, goal) =>
    ipcRenderer.invoke(IPC.runsRename, { workspacePath, runId, goal }),
  listActiveRuns: () => ipcRenderer.invoke(IPC.runsActive),
  gitStatus: (workspacePath) => ipcRenderer.invoke(IPC.gitStatus, { workspacePath }),
  gitCommit: (workspacePath, message, push, mode) =>
    ipcRenderer.invoke(IPC.gitCommit, { workspacePath, message, push, mode }),
  gitStageAll: (workspacePath) => ipcRenderer.invoke(IPC.gitStageAll, { workspacePath }),
  gitStagePaths: (payload) => ipcRenderer.invoke(IPC.gitStagePaths, payload),
  gitUnstagePaths: (payload) => ipcRenderer.invoke(IPC.gitUnstagePaths, payload),
  gitBranches: (workspacePath) => ipcRenderer.invoke(IPC.gitBranches, { workspacePath }),
  gitCheckout: (workspacePath, branch) =>
    ipcRenderer.invoke(IPC.gitCheckout, { workspacePath, branch }),
  gitLog: (payload) => ipcRenderer.invoke(IPC.gitLog, payload),
  gitCommitFiles: (payload) => ipcRenderer.invoke(IPC.gitCommitFiles, payload),
  gitDiff: (payload) => ipcRenderer.invoke(IPC.gitDiff, payload),
  prView: (workspacePath) => ipcRenderer.invoke(IPC.prView, { workspacePath }),
  prMerge: (workspacePath, method) =>
    ipcRenderer.invoke(IPC.prMerge, { workspacePath, method }),
  prDiff: (payload) => ipcRenderer.invoke(IPC.prDiff, payload),
  prClose: (workspacePath) => ipcRenderer.invoke(IPC.prClose, { workspacePath }),
  prEditTitle: (workspacePath, title) =>
    ipcRenderer.invoke(IPC.prEditTitle, { workspacePath, title }),
  githubAuthStatus: () => ipcRenderer.invoke(IPC.githubAuthStatus),
  githubAuthStart: () => ipcRenderer.invoke(IPC.githubAuthStart),
  githubAuthCancel: () => ipcRenderer.invoke(IPC.githubAuthCancel),
  githubAuthLogout: () => ipcRenderer.invoke(IPC.githubAuthLogout),
  shellOpenExternal: (url) => ipcRenderer.invoke(IPC.shellOpenExternal, { url }),
  ptyCreate: (payload) => ipcRenderer.invoke(IPC.ptyCreate, payload),
  ptyList: (workspacePath) =>
    ipcRenderer.invoke(IPC.ptyList, workspacePath ? { workspacePath } : {}),
  ptyWrite: (id, data, workspacePath) =>
    ipcRenderer.invoke(IPC.ptyWrite, { id, data, workspacePath }),
  ptyResize: (id, cols, rows, workspacePath) =>
    ipcRenderer.invoke(IPC.ptyResize, { id, cols, rows, workspacePath }),
  ptyKill: (id, workspacePath) => ipcRenderer.invoke(IPC.ptyKill, { id, workspacePath }),
  onPtyData: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      if (!raw || typeof raw !== 'object') return
      const rec = raw as { id?: unknown; data?: unknown }
      if (typeof rec.id !== 'string' || typeof rec.data !== 'string') return
      handler({ id: rec.id, data: rec.data })
    }
    ipcRenderer.on(IPC.ptyData, listener)
    return () => {
      ipcRenderer.removeListener(IPC.ptyData, listener)
    }
  },
  onPtyExit: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      if (!raw || typeof raw !== 'object') return
      const rec = raw as { id?: unknown; exitCode?: unknown }
      if (typeof rec.id !== 'string') return
      handler({
        id: rec.id,
        exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : null
      })
    }
    ipcRenderer.on(IPC.ptyExit, listener)
    return () => {
      ipcRenderer.removeListener(IPC.ptyExit, listener)
    }
  },
  windowMinimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  windowMaximize: () => ipcRenderer.invoke(IPC.windowMaximize),
  windowClose: () => ipcRenderer.invoke(IPC.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
  onWindowMaximizedChanged: (handler) => {
    const listener = (_: IpcRendererEvent, maximized: boolean): void => handler(maximized)
    ipcRenderer.on(IPC.windowMaximizedChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.windowMaximizedChanged, listener)
    }
  },
  onBrowserState: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = AgentBrowserStateSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn('[vyotiq] Invalid browser state dropped', parsed.error.issues[0]?.message)
        return
      }
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.browserState, listener)
    return () => {
      ipcRenderer.removeListener(IPC.browserState, listener)
    }
  },
  browserGetState: () => ipcRenderer.invoke(IPC.browserGetState),
  browserFocus: () => ipcRenderer.invoke(IPC.browserFocus),
  browserClose: () => ipcRenderer.invoke(IPC.browserClose),
  browserSelectTab: (tabId: string) => ipcRenderer.invoke(IPC.browserSelectTab, { tabId }),
  browserBack: () => ipcRenderer.invoke(IPC.browserBack),
  browserForward: () => ipcRenderer.invoke(IPC.browserForward),
  browserSetBounds: (bounds) => ipcRenderer.invoke(IPC.browserSetBounds, bounds),
  browserNavigate: (url: string, workspacePath?: string) => ipcRenderer.invoke(IPC.browserNavigate, workspacePath ? { url, workspacePath } : url),
  browserReload: () => ipcRenderer.invoke(IPC.browserReload),
  browserTakeScreenshot: (payload) => ipcRenderer.invoke(IPC.browserTakeScreenshot, payload),
  browserClearBrowsingData: (payload) =>
    ipcRenderer.invoke(IPC.browserClearBrowsingData, payload),
  openLogsDir: () => ipcRenderer.invoke(IPC.logsOpenDir),
  getLogsPath: () => ipcRenderer.invoke(IPC.logsGetPath),
  getCrashDiagnostics: () => ipcRenderer.invoke(IPC.crashDiagnosticsGet),
  consumeCrashRecovery: () => ipcRenderer.invoke(IPC.crashRecoveryConsume),
  telemetryStatus: () => ipcRenderer.invoke(IPC.telemetryStatus),
  mcpStatus: (payload) => ipcRenderer.invoke(IPC.mcpStatus, payload ?? {}),
  mcpRefresh: (payload) => ipcRenderer.invoke(IPC.mcpRefresh, payload ?? {}),
  mcpSetAuthToken: (serverId, token) =>
    ipcRenderer.invoke(IPC.mcpSetAuthToken, { serverId, token }),
  mcpClearAuthToken: (serverId) => ipcRenderer.invoke(IPC.mcpClearAuthToken, { serverId }),
  mcpStartOAuth: (serverId) => ipcRenderer.invoke(IPC.mcpStartOAuth, { serverId }),
  marketplaceListInstalled: () => ipcRenderer.invoke(IPC.marketplaceListInstalled),
  marketplaceBrowse: (payload) => ipcRenderer.invoke(IPC.marketplaceBrowse, payload ?? {}),
  marketplaceRefreshCatalog: () => ipcRenderer.invoke(IPC.marketplaceRefreshCatalog),
  marketplaceInstall: (payload) => ipcRenderer.invoke(IPC.marketplaceInstall, payload),
  marketplaceDetectMcp: (payload) => ipcRenderer.invoke(IPC.marketplaceDetectMcp, payload),
  marketplaceApplyDetectedMcp: (payload) =>
    ipcRenderer.invoke(IPC.marketplaceApplyDetectedMcp, payload),
  marketplaceScanExternalMcp: (payload) =>
    ipcRenderer.invoke(IPC.marketplaceScanExternalMcp, payload ?? {}),
  marketplaceImportExternalMcp: (payload) =>
    ipcRenderer.invoke(IPC.marketplaceImportExternalMcp, payload),
  marketplaceUninstall: (id) => ipcRenderer.invoke(IPC.marketplaceUninstall, { id }),
  marketplaceSetEnabled: (id, enabled) =>
    ipcRenderer.invoke(IPC.marketplaceSetEnabled, { id, enabled }),
  marketplacePickLocal: () => ipcRenderer.invoke(IPC.marketplacePickLocal),
  marketplaceGetContents: (id) => ipcRenderer.invoke(IPC.marketplaceGetContents, { id }),
  marketplaceAckRemoteInstall: (acked) =>
    ipcRenderer.invoke(IPC.marketplaceAckRemoteInstall, { acked }),
  getSystemTheme: () => ipcRenderer.invoke(IPC.getSystemTheme),
  probeNetwork: () => ipcRenderer.invoke(IPC.networkProbe),
  slashCommandsList: (payload) => ipcRenderer.invoke(IPC.slashCommandsList, payload ?? {}),
  slashCommandsResolve: (payload) => ipcRenderer.invoke(IPC.slashCommandsResolve, payload),
  slashCommandsCreateRule: (payload) =>
    ipcRenderer.invoke(IPC.slashCommandsCreateRule, payload),
  slashCommandsOpenFile: (payload) => ipcRenderer.invoke(IPC.slashCommandsOpenFile, payload),
  workspaceSuggestPaths: (payload) => ipcRenderer.invoke(IPC.workspaceSuggestPaths, payload),
  workspaceReadText: (payload) => ipcRenderer.invoke(IPC.workspaceReadText, payload),
  workspaceReadImage: (payload) => ipcRenderer.invoke(IPC.workspaceReadImage, payload),
  workspaceListDocs: (payload) => ipcRenderer.invoke(IPC.workspaceListDocs, payload),
  workspaceListRules: (payload) => ipcRenderer.invoke(IPC.workspaceListRules, payload),
  workspaceDiagnostics: (payload) => ipcRenderer.invoke(IPC.workspaceDiagnostics, payload),
  onSystemThemeChanged: (handler) => {
    const listener = (_: IpcRendererEvent, prefersDark: boolean): void => handler(prefersDark)
    ipcRenderer.on(IPC.themeChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.themeChanged, listener)
    }
  }
}

contextBridge.exposeInMainWorld('vyotiq', api)
