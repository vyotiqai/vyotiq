import type {
  ActiveRunsResult,
  AgentEvent,
  ChatMessage,
  ChatFollowUpRemoveRequest,
  ChatFollowUpRemoveResult,
  ChatFollowUpRequest,
  ChatFollowUpResult,
  ChatQueueModeRequest,
  ChatQueueModeResult,
  ChatStartRequest,
  ChatStartResult,
  ChatRewindAndStartRequest,
  CompactRunResult,
  UndoWritesResult,
  ResolveWritesResult,
  ReadRunArtifactResult,
  RunArtifactName,
  HarnessReviewResult,
  HarnessPreviewApplyResult,
  HarnessApplyResult,
  GitCommitResult,
  GitStatusResult,
  IpcResult,
  ListModelsResult,
  ListRunsResult,
  PersistedEvent,
  ProviderId,
  RunSummary,
  SecretProvider,
  SecretsStatus,
  Settings,
  TelemetryStatus,
  CrashDiagnosticsSnapshot,
  CrashRecoveryPending,
  ToolApprovalDecision,
  ToolApprovalRequest,
  AgentQuestionRequest,
  AgentQuestionAnswer,
  ExtractAttachmentRequest,
  ExtractAttachmentResult,
  McpStatusResult,
  MarketplaceIndex,
  MarketplaceCatalogEntry,
  MarketplaceInstallResult,
  MarketplaceInstallRequest,
  MarketplaceBrowseRequest,
  McpDetectRequest,
  McpDetectResult,
  McpApplyDetectedRequest,
  McpApplyDetectedResult,
  McpScanExternalRequest,
  McpImportExternalRequest,
  McpImportExternalResult,
  PackageContents,
  WorkspaceSettingsOverride,
  WorkspacesState,
  WorkspaceUiState,
  SlashCommandDescriptor,
  SlashCommandResolveResult,
  SlashCommandsCreateRuleResult
} from './ipc'

/** Host OS from preload `process.platform`. */
export type HostPlatform = 'darwin' | 'win32' | 'linux' | string

/**
 * Single source of truth for the contextBridge API.
 * Preload implements this; renderer `env.d.ts` types `window.vyotiq` from it.
 */
export interface VyotiqApi {
  platform: HostPlatform
  pickWorkspace: () => Promise<IpcResult<string | null>>
  getWorkspaces: () => Promise<IpcResult<WorkspacesState>>
  addWorkspace: (path?: string) => Promise<IpcResult<WorkspacesState>>
  removeWorkspace: (path: string, stopActiveRuns?: boolean) => Promise<IpcResult<WorkspacesState>>
  setActiveWorkspace: (path: string) => Promise<IpcResult<WorkspacesState>>
  updateWorkspaceUiState: (path: string, ui: WorkspaceUiState) => Promise<IpcResult<true>>
  /** Fire-and-forget UI state flush (e.g. beforeunload). */
  updateWorkspaceUiStateSync: (path: string, ui: WorkspaceUiState) => void
  setWorkspaceSettingsOverride: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<IpcResult<WorkspacesState>>
  getSettings: () => Promise<IpcResult<Settings>>
  setSettings: (partial: Partial<Settings>) => Promise<IpcResult<Settings>>
  setSecret: (provider: SecretProvider, key: string) => Promise<IpcResult<true>>
  clearSecret: (provider: SecretProvider) => Promise<IpcResult<true>>
  secretStatus: () => Promise<IpcResult<SecretsStatus>>
  listModels: (payload: {
    provider: ProviderId
    baseUrl?: string
    forceRefresh?: boolean
  }) => Promise<IpcResult<ListModelsResult>>
  chatStart: (payload: ChatStartRequest) => Promise<IpcResult<ChatStartResult>>
  chatRewindAndStart: (payload: ChatRewindAndStartRequest) => Promise<IpcResult<ChatStartResult>>
  chatCancel: (runId: string) => Promise<IpcResult<true>>
  chatFollowUp: (payload: ChatFollowUpRequest) => Promise<IpcResult<ChatFollowUpResult>>
  chatFollowUpRemove: (
    payload: ChatFollowUpRemoveRequest
  ) => Promise<IpcResult<ChatFollowUpRemoveResult>>
  chatQueueMode: (payload: ChatQueueModeRequest) => Promise<IpcResult<ChatQueueModeResult>>
  chatCompact: (workspacePath: string, runId: string) => Promise<IpcResult<CompactRunResult>>
  undoWrites: (
    workspacePath: string,
    runId: string,
    checkpointId?: string
  ) => Promise<IpcResult<UndoWritesResult>>
  resolveWrites: (payload: {
    workspacePath: string
    runId: string
    checkpointId?: string
    action: 'keep' | 'discard'
    paths?: string[]
  }) => Promise<IpcResult<ResolveWritesResult>>
  readRunArtifact: (payload: {
    workspacePath: string
    runId: string
    name: RunArtifactName
  }) => Promise<IpcResult<ReadRunArtifactResult>>
  harnessReview: (payload: {
    workspacePath: string
    limit?: number
  }) => Promise<IpcResult<HarnessReviewResult>>
  harnessPreviewApply: (payload: {
    workspacePath: string
    proposalPath?: string
  }) => Promise<IpcResult<HarnessPreviewApplyResult>>
  harnessApply: (payload: {
    workspacePath: string
    proposalPath?: string
    confirm: true
  }) => Promise<IpcResult<HarnessApplyResult>>
  onChatEvent: (handler: (event: AgentEvent) => void) => () => void
  onToolApprovalRequest: (handler: (request: ToolApprovalRequest) => void) => () => void
  respondToolApproval: (
    requestId: string,
    decision: ToolApprovalDecision,
    runId: string
  ) => Promise<IpcResult<boolean>>
  listPendingToolApprovals: (runId: string) => Promise<IpcResult<ToolApprovalRequest[]>>
  onAgentQuestionRequest: (handler: (request: AgentQuestionRequest) => void) => () => void
  respondAgentQuestion: (
    requestId: string,
    answers: AgentQuestionAnswer[],
    runId: string
  ) => Promise<IpcResult<boolean>>
  listPendingAgentQuestions: (runId: string) => Promise<IpcResult<AgentQuestionRequest[]>>
  extractAttachment: (
    payload: ExtractAttachmentRequest
  ) => Promise<IpcResult<ExtractAttachmentResult>>
  listRuns: (workspacePath: string) => Promise<IpcResult<ListRunsResult>>
  loadRun: (
    workspacePath: string,
    runId: string
  ) => Promise<IpcResult<{ messages: ChatMessage[]; runId: string }>>
  loadRunEvents: (
    workspacePath: string,
    runId: string
  ) => Promise<IpcResult<PersistedEvent[]>>
  loadToolResult: (
    workspacePath: string,
    runId: string,
    toolCallId: string
  ) => Promise<IpcResult<{ content: string }>>
  deleteRun: (workspacePath: string, runId: string) => Promise<IpcResult<true>>
  renameRun: (
    workspacePath: string,
    runId: string,
    goal: string
  ) => Promise<IpcResult<RunSummary>>
  listActiveRuns: () => Promise<IpcResult<ActiveRunsResult>>
  /** Discriminated: ok | not_repo | unavailable (git missing from PATH). */
  gitStatus: (workspacePath: string) => Promise<IpcResult<GitStatusResult>>
  gitCommit: (
    workspacePath: string,
    message: string,
    push: boolean,
    mode?: 'all' | 'staged'
  ) => Promise<IpcResult<GitCommitResult>>
  gitStageAll: (workspacePath: string) => Promise<IpcResult<{ staged: boolean; detail: string }>>
  gitStagePaths: (payload: {
    workspacePath: string
    paths: string[]
  }) => Promise<IpcResult<{ staged: boolean; detail: string }>>
  gitUnstagePaths: (payload: {
    workspacePath: string
    paths: string[]
  }) => Promise<IpcResult<{ unstaged: boolean; detail: string }>>
  gitBranches: (
    workspacePath: string
  ) => Promise<IpcResult<import('./ipc').GitBranchEntry[]>>
  gitCheckout: (
    workspacePath: string,
    branch: string
  ) => Promise<IpcResult<{ detail: string }>>
  gitLog: (payload: {
    workspacePath: string
    limit?: number
  }) => Promise<IpcResult<import('./ipc').GitLogEntry[]>>
  gitCommitFiles: (payload: {
    workspacePath: string
    sha: string
  }) => Promise<IpcResult<{ files: import('./ipc').GitChangedFile[] }>>
  gitDiff: (payload: {
    workspacePath: string
    path?: string
    staged?: boolean
    ignoreWhitespace?: boolean
    sha?: string
  }) => Promise<IpcResult<{ content: string }>>
  prView: (workspacePath: string) => Promise<IpcResult<import('./ipc').PrView | null>>
  prMerge: (
    workspacePath: string,
    method: import('./ipc').PrMergeMethod
  ) => Promise<IpcResult<{ detail: string }>>
  prDiff: (payload: {
    workspacePath: string
    path?: string
    ignoreWhitespace?: boolean
  }) => Promise<IpcResult<{ content: string }>>
  prClose: (workspacePath: string) => Promise<IpcResult<{ detail: string }>>
  prEditTitle: (
    workspacePath: string,
    title: string
  ) => Promise<IpcResult<{ title: string }>>
  githubAuthStatus: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  githubAuthStart: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  githubAuthCancel: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  githubAuthLogout: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  shellOpenExternal: (url: string) => Promise<IpcResult<true>>
  ptyCreate: (payload: {
    workspacePath: string
    cols?: number
    rows?: number
  }) => Promise<IpcResult<import('./ipc').PtySessionInfo>>
  ptyList: (workspacePath?: string) => Promise<IpcResult<import('./ipc').PtySessionInfo[]>>
  ptyWrite: (id: string, data: string, workspacePath: string) => Promise<IpcResult<boolean>>
  ptyResize: (
    id: string,
    cols: number,
    rows: number,
    workspacePath: string
  ) => Promise<IpcResult<boolean>>
  ptyKill: (id: string, workspacePath: string) => Promise<IpcResult<boolean>>
  onPtyData: (handler: (event: { id: string; data: string }) => void) => () => void
  onPtyExit: (handler: (event: { id: string; exitCode: number | null }) => void) => () => void
  windowMinimize: () => Promise<IpcResult<true>>
  windowMaximize: () => Promise<IpcResult<boolean>>
  windowClose: () => Promise<IpcResult<true>>
  windowIsMaximized: () => Promise<IpcResult<boolean>>
  onWindowMaximizedChanged: (handler: (maximized: boolean) => void) => () => void
  onBrowserState: (handler: (state: import('./ipc').AgentBrowserState) => void) => () => void
  browserGetState: () => Promise<IpcResult<import('./ipc').AgentBrowserState>>
  browserFocus: () => Promise<IpcResult<boolean>>
  browserClose: () => Promise<IpcResult<true>>
  browserSelectTab: (tabId: string) => Promise<IpcResult<boolean>>
  browserBack: () => Promise<IpcResult<boolean>>
  browserForward: () => Promise<IpcResult<boolean>>
  browserSetBounds: (
    bounds: { x: number; y: number; width: number; height: number } | null
  ) => Promise<IpcResult<true>>
  browserNavigate: (url: string) => Promise<IpcResult<boolean>>
  browserReload: () => Promise<IpcResult<boolean>>
  browserTakeScreenshot: (payload: {
    workspacePath: string
    runId: string
    tabId?: string
  }) => Promise<IpcResult<{ path: string }>>
  browserClearBrowsingData: (payload: {
    kind: 'history' | 'cookies' | 'cache' | 'all'
  }) => Promise<IpcResult<{ cleared: 'history' | 'cookies' | 'cache' | 'all' }>>
  openLogsDir: () => Promise<IpcResult<true>>
  getLogsPath: () => Promise<IpcResult<string>>
  getCrashDiagnostics: () => Promise<IpcResult<CrashDiagnosticsSnapshot>>
  consumeCrashRecovery: () => Promise<IpcResult<CrashRecoveryPending | null>>
  telemetryStatus: () => Promise<IpcResult<TelemetryStatus>>
  mcpStatus: (payload?: { workspacePath?: string | null }) => Promise<IpcResult<McpStatusResult>>
  mcpRefresh: (payload?: { workspacePath?: string | null }) => Promise<IpcResult<McpStatusResult>>
  mcpSetAuthToken: (serverId: string, token: string) => Promise<IpcResult<true>>
  mcpClearAuthToken: (serverId: string) => Promise<IpcResult<true>>
  mcpStartOAuth: (serverId: string) => Promise<IpcResult<McpStatusResult>>
  marketplaceListInstalled: () => Promise<IpcResult<MarketplaceIndex>>
  marketplaceBrowse: (
    payload?: MarketplaceBrowseRequest
  ) => Promise<IpcResult<{ packages: MarketplaceCatalogEntry[] }>>
  marketplaceRefreshCatalog: () => Promise<
    IpcResult<{ packages: MarketplaceCatalogEntry[]; remoteCount: number }>
  >
  marketplaceInstall: (
    payload: MarketplaceInstallRequest
  ) => Promise<IpcResult<MarketplaceInstallResult>>
  marketplaceDetectMcp: (
    payload: McpDetectRequest
  ) => Promise<IpcResult<McpDetectResult>>
  marketplaceApplyDetectedMcp: (
    payload: McpApplyDetectedRequest
  ) => Promise<IpcResult<McpApplyDetectedResult>>
  marketplaceScanExternalMcp: (
    payload?: McpScanExternalRequest
  ) => Promise<IpcResult<McpImportExternalResult>>
  marketplaceImportExternalMcp: (
    payload: McpImportExternalRequest
  ) => Promise<IpcResult<McpImportExternalResult>>
  marketplaceUninstall: (id: string) => Promise<IpcResult<MarketplaceIndex>>
  marketplaceSetEnabled: (
    id: string,
    enabled: boolean
  ) => Promise<IpcResult<MarketplaceIndex>>
  marketplacePickLocal: () => Promise<IpcResult<string | null>>
  marketplaceGetContents: (id: string) => Promise<IpcResult<PackageContents>>
  marketplaceAckRemoteInstall: (acked: boolean) => Promise<IpcResult<Settings>>
  slashCommandsList: (payload?: {
    workspacePath?: string | null
  }) => Promise<IpcResult<{ commands: SlashCommandDescriptor[] }>>
  slashCommandsResolve: (payload: {
    id: string
    workspacePath?: string | null
    trailingText?: string
  }) => Promise<IpcResult<SlashCommandResolveResult>>
  slashCommandsCreateRule: (payload: {
    workspacePath: string
    title?: string
  }) => Promise<IpcResult<SlashCommandsCreateRuleResult>>
  slashCommandsOpenFile: (payload: {
    workspacePath: string
    path: string
  }) => Promise<IpcResult<true>>
  workspaceSuggestPaths: (payload: {
    workspacePath: string
    query?: string
    maxResults?: number
  }) => Promise<IpcResult<{ paths: string[]; total: number }>>
  workspaceReadText: (payload: {
    workspacePath: string
    path: string
  }) => Promise<IpcResult<{ name: string; mime: string; text: string; truncated: boolean }>>
  workspaceReadImage: (payload: {
    workspacePath: string
    path: string
  }) => Promise<
    IpcResult<{ path: string; mime: string; dataUrl: string; byteLength: number }>
  >
  workspaceListDocs: (payload: {
    workspacePath: string
    query?: string
    maxResults?: number
  }) => Promise<IpcResult<{ paths: string[] }>>
  workspaceListRules: (payload: {
    workspacePath: string
  }) => Promise<
    IpcResult<{ rules: Array<{ path: string; description?: string; alwaysApply: boolean }> }>
  >
  workspaceDiagnostics: (payload: {
    workspacePath: string
    kind?: 'typecheck' | 'lint'
  }) => Promise<IpcResult<{ ok: boolean; content: string; kind: 'typecheck' | 'lint' }>>
  getSystemTheme: () => Promise<IpcResult<boolean>>
  /** Main-process connectivity probe (1.1.1.1 HEAD) — matches agent retry logic. */
  probeNetwork: () => Promise<IpcResult<boolean>>
  onSystemThemeChanged: (handler: (prefersDark: boolean) => void) => () => void
}
