import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/channels'
import type { VyotiqApi } from '@shared/vyotiqApi'

/** Invoke channels exposed on VyotiqApi (push listeners + sync send excluded). */
const VYOTIQ_INVOKE_MAP: Record<
  Exclude<
    keyof VyotiqApi,
    | 'platform'
    | 'onChatEvent'
    | 'onToolApprovalRequest'
    | 'onAgentQuestionRequest'
    | 'onWindowMaximizedChanged'
    | 'onSystemThemeChanged'
    | 'onBrowserState'
    | 'onPtyData'
    | 'onPtyExit'
    | 'updateWorkspaceUiStateSync'
  >,
  string
> = {
  pickWorkspace: IPC.pickWorkspace,
  getWorkspaces: IPC.workspacesGet,
  addWorkspace: IPC.workspacesAdd,
  removeWorkspace: IPC.workspacesRemove,
  setActiveWorkspace: IPC.workspacesSetActive,
  updateWorkspaceUiState: IPC.workspacesUpdateUiState,
  setWorkspaceSettingsOverride: IPC.workspacesSetSettingsOverride,
  getSettings: IPC.getSettings,
  setSettings: IPC.setSettings,
  setSecret: IPC.setSecret,
  clearSecret: IPC.clearSecret,
  secretStatus: IPC.secretStatus,
  listModels: IPC.listModels,
  chatStart: IPC.chatStart,
  chatRewindAndStart: IPC.chatRewindAndStart,
  chatCancel: IPC.chatCancel,
  chatFollowUp: IPC.chatFollowUp,
  chatFollowUpRemove: IPC.chatFollowUpRemove,
  chatCompact: IPC.chatCompact,
  undoWrites: IPC.runsUndoWrites,
  resolveWrites: IPC.runsResolveWrites,
  readRunArtifact: IPC.runsReadArtifact,
  harnessReview: IPC.harnessReview,
  harnessPreviewApply: IPC.harnessPreviewApply,
  harnessApply: IPC.harnessApply,
  respondToolApproval: IPC.toolApprovalResponse,
  listPendingToolApprovals: IPC.toolApprovalListPending,
  respondAgentQuestion: IPC.agentQuestionResponse,
  listPendingAgentQuestions: IPC.agentQuestionListPending,
  extractAttachment: IPC.attachmentExtract,
  listRuns: IPC.listRuns,
  loadRun: IPC.loadRun,
  loadRunEvents: IPC.loadRunEvents,
  loadToolResult: IPC.loadToolResult,
  deleteRun: IPC.runsDelete,
  renameRun: IPC.runsRename,
  listActiveRuns: IPC.runsActive,
  browserGetState: IPC.browserGetState,
  browserFocus: IPC.browserFocus,
  browserClose: IPC.browserClose,
  browserSelectTab: IPC.browserSelectTab,
  browserBack: IPC.browserBack,
  browserForward: IPC.browserForward,
  browserSetBounds: IPC.browserSetBounds,
  browserNavigate: IPC.browserNavigate,
  browserReload: IPC.browserReload,
  browserTakeScreenshot: IPC.browserTakeScreenshot,
  browserClearBrowsingData: IPC.browserClearBrowsingData,
  gitStatus: IPC.gitStatus,
  gitDiff: IPC.gitDiff,
  gitCommit: IPC.gitCommit,
  gitStageAll: IPC.gitStageAll,
  gitLog: IPC.gitLog,
  gitCommitFiles: IPC.gitCommitFiles,
  prView: IPC.prView,
  prMerge: IPC.prMerge,
  prDiff: IPC.prDiff,
  prClose: IPC.prClose,
  prEditTitle: IPC.prEditTitle,
  ptyCreate: IPC.ptyCreate,
  ptyList: IPC.ptyList,
  ptyWrite: IPC.ptyWrite,
  ptyResize: IPC.ptyResize,
  ptyKill: IPC.ptyKill,
  gitStagePaths: IPC.gitStagePaths,
  gitUnstagePaths: IPC.gitUnstagePaths,
  gitBranches: IPC.gitBranches,
  gitCheckout: IPC.gitCheckout,
  marketplaceAckRemoteInstall: IPC.marketplaceAckRemoteInstall,
  githubAuthStatus: IPC.githubAuthStatus,
  githubAuthStart: IPC.githubAuthStart,
  githubAuthCancel: IPC.githubAuthCancel,
  githubAuthLogout: IPC.githubAuthLogout,
  shellOpenExternal: IPC.shellOpenExternal,
  workspaceSuggestPaths: IPC.workspaceSuggestPaths,
  workspaceReadText: IPC.workspaceReadText,
  workspaceReadImage: IPC.workspaceReadImage,
  workspaceListDocs: IPC.workspaceListDocs,
  workspaceListRules: IPC.workspaceListRules,
  workspaceDiagnostics: IPC.workspaceDiagnostics,
  windowMinimize: IPC.windowMinimize,
  windowMaximize: IPC.windowMaximize,
  windowClose: IPC.windowClose,
  windowIsMaximized: IPC.windowIsMaximized,
  openLogsDir: IPC.logsOpenDir,
  getLogsPath: IPC.logsGetPath,
  getCrashDiagnostics: IPC.crashDiagnosticsGet,
  consumeCrashRecovery: IPC.crashRecoveryConsume,
  telemetryStatus: IPC.telemetryStatus,
  mcpStatus: IPC.mcpStatus,
  mcpRefresh: IPC.mcpRefresh,
  mcpSetAuthToken: IPC.mcpSetAuthToken,
  mcpClearAuthToken: IPC.mcpClearAuthToken,
  mcpStartOAuth: IPC.mcpStartOAuth,
  marketplaceListInstalled: IPC.marketplaceListInstalled,
  marketplaceBrowse: IPC.marketplaceBrowse,
  marketplaceRefreshCatalog: IPC.marketplaceRefreshCatalog,
  marketplaceInstall: IPC.marketplaceInstall,
  marketplaceDetectMcp: IPC.marketplaceDetectMcp,
  marketplaceApplyDetectedMcp: IPC.marketplaceApplyDetectedMcp,
  marketplaceScanExternalMcp: IPC.marketplaceScanExternalMcp,
  marketplaceImportExternalMcp: IPC.marketplaceImportExternalMcp,
  marketplaceUninstall: IPC.marketplaceUninstall,
  marketplaceSetEnabled: IPC.marketplaceSetEnabled,
  marketplacePickLocal: IPC.marketplacePickLocal,
  marketplaceGetContents: IPC.marketplaceGetContents,
  slashCommandsList: IPC.slashCommandsList,
  slashCommandsResolve: IPC.slashCommandsResolve,
  slashCommandsCreateRule: IPC.slashCommandsCreateRule,
  slashCommandsOpenFile: IPC.slashCommandsOpenFile,
  getSystemTheme: IPC.getSystemTheme
}

const PUSH_CHANNELS = new Set<string>([
  IPC.chatEvent,
  IPC.toolApprovalRequest,
  IPC.agentQuestionRequest,
  IPC.windowMaximizedChanged,
  IPC.themeChanged,
  IPC.browserState,
  IPC.ptyData,
  IPC.ptyExit
])

const VYOTIQ_SYNC_SEND_MAP: Record<'updateWorkspaceUiStateSync', string> = {
  updateWorkspaceUiStateSync: IPC.workspacesUpdateUiStateSync
}

const VYOTIQ_PUSH_MAP: Record<
  | 'onChatEvent'
  | 'onToolApprovalRequest'
  | 'onAgentQuestionRequest'
  | 'onWindowMaximizedChanged'
  | 'onSystemThemeChanged'
  | 'onBrowserState'
  | 'onPtyData'
  | 'onPtyExit',
  string
> = {
  onChatEvent: IPC.chatEvent,
  onToolApprovalRequest: IPC.toolApprovalRequest,
  onAgentQuestionRequest: IPC.agentQuestionRequest,
  onWindowMaximizedChanged: IPC.windowMaximizedChanged,
  onSystemThemeChanged: IPC.themeChanged,
  onBrowserState: IPC.browserState,
  onPtyData: IPC.ptyData,
  onPtyExit: IPC.ptyExit
}

describe('main/renderer IPC contract', () => {
  it('maps every VyotiqApi invoke to a shared IPC channel', () => {
    const channels = new Set(Object.values(IPC))
    for (const channel of Object.values(VYOTIQ_INVOKE_MAP)) {
      expect(channels.has(channel)).toBe(true)
      expect(PUSH_CHANNELS.has(channel)).toBe(false)
    }
    expect(Object.keys(VYOTIQ_INVOKE_MAP)).toHaveLength(111)
  })

  it('maps every VyotiqApi push listener to a push channel', () => {
    const channels = new Set(Object.values(IPC))
    for (const channel of Object.values(VYOTIQ_PUSH_MAP)) {
      expect(channels.has(channel)).toBe(true)
      expect(PUSH_CHANNELS.has(channel)).toBe(true)
    }
    expect(Object.keys(VYOTIQ_PUSH_MAP)).toHaveLength(8)
  })

  it('accounts for every IPC channel as invoke or push', () => {
    const accounted = new Set([
      ...Object.values(VYOTIQ_INVOKE_MAP),
      ...Object.values(VYOTIQ_PUSH_MAP),
      ...Object.values(VYOTIQ_SYNC_SEND_MAP)
    ])
    for (const channel of Object.values(IPC)) {
      expect(accounted.has(channel)).toBe(true)
    }
    expect(accounted.size).toBe(Object.values(IPC).length)
  })

  it('registers ipcMain handlers for all invoke channels', () => {
    const registerSrc = readFileSync(
      join(process.cwd(), 'src/main/ipc/register.ts'),
      'utf8'
    )
    for (const channel of Object.values(VYOTIQ_INVOKE_MAP)) {
      const key = channelKey(channel)
      expect(registerSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*IPC\\.${key}`))
    }
  })

  it('preload wires invoke channels to ipcRenderer.invoke', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const [method, channel] of Object.entries(VYOTIQ_INVOKE_MAP)) {
      expect(preloadSrc).toContain(`${method}:`)
      expect(preloadSrc).toContain(`ipcRenderer.invoke(IPC.${channelKey(channel)}`)
    }
  })

  it('preload wires push channels to ipcRenderer.on', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const [method, channel] of Object.entries(VYOTIQ_PUSH_MAP)) {
      expect(preloadSrc).toContain(`${method}:`)
      expect(preloadSrc).toContain(`ipcRenderer.on(IPC.${channelKey(channel)}`)
    }
  })

  it('preload wires sync send channels to ipcRenderer.send', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const [method, channel] of Object.entries(VYOTIQ_SYNC_SEND_MAP)) {
      expect(preloadSrc).toContain(`${method}:`)
      expect(preloadSrc).toContain(`ipcRenderer.send(IPC.${channelKey(channel)}`)
    }
  })
})

function channelKey(channel: string): string {
  const entry = Object.entries(IPC).find(([, value]) => value === channel)
  if (!entry) throw new Error(`Unknown IPC channel: ${channel}`)
  return entry[0]
}
