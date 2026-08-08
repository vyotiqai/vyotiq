import { z } from 'zod'
import {
  ProviderIdSchema,
  ServiceTierSchema,
  ThinkingEffortSchema,
  type ThinkingEffort
} from './providers'
import {
  DEFAULT_MARKETPLACE_SETTINGS,
  MarketplaceSettingsSchema,
  McpTransportSchema
} from './marketplace'

export type { ThinkingEffort }

export const ImageGenProviderIdSchema = z.enum([
  'openai',
  'gemini',
  'xai',
  'openrouter',
  'custom'
])
export type ImageGenProviderId = z.infer<typeof ImageGenProviderIdSchema>

/** `auto` picks OpenAI → Gemini → xAI → OpenRouter → custom (if enabled) by available key. */
export const ImageProviderSettingSchema = z.union([
  z.literal('auto'),
  ImageGenProviderIdSchema
])
export type ImageProviderSetting = z.infer<typeof ImageProviderSettingSchema>

export const ThemeIdSchema = z.enum(['system', 'light', 'dark'])
export type ThemeId = z.infer<typeof ThemeIdSchema>

const McpServerIdSchema = z
  .string()
  .min(1)
  .refine((id) => !id.includes('__'), {
    message: 'MCP server id must not contain "__"'
  })

/**
 * MCP server config. Legacy entries without `transport` default to stdio.
 * stdio requires `command`; http/sse require `url`.
 */
export const McpServerSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const obj = { ...(raw as Record<string, unknown>) }
    if (obj.transport === undefined || obj.transport === null || obj.transport === '') {
      obj.transport = 'stdio'
    }
    return obj
  },
  z
    .object({
      id: McpServerIdSchema,
      name: z.string().min(1),
      transport: McpTransportSchema.default('stdio'),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      /**
       * When non-empty, only these bare MCP tool names are exposed/invokable.
       * Empty / omitted = all tools (minus deniedTools).
       */
      allowedTools: z.array(z.string().min(1)).optional(),
      /** Bare MCP tool names that are never exposed or invokable. */
      deniedTools: z.array(z.string().min(1)).optional(),
      enabled: z.boolean().default(true),
      source: z.enum(['manual', 'marketplace']).optional(),
      packageId: z.string().optional(),
      packageVersion: z.string().optional()
    })
    .superRefine((val, ctx) => {
      if (val.transport === 'stdio' && !(val.command ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'command is required for stdio transport',
          path: ['command']
        })
      }
      if ((val.transport === 'http' || val.transport === 'sse') && !(val.url ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'url is required for http/sse transport',
          path: ['url']
        })
      }
    })
)
export type McpServer = z.infer<typeof McpServerSchema>

const ThinkingPrefsSchema = z.object({
  thinkingEnabled: z.boolean(),
  thinkingEffort: ThinkingEffortSchema
})

/**
 * `mutating` gates only tools that change the workspace or run commands;
 * `all` gates every tool including reads. Default is `off` — approval is opt-in.
 */
export const ToolApprovalModeSchema = z.enum(['off', 'mutating', 'all'])
export type ToolApprovalMode = z.infer<typeof ToolApprovalModeSchema>

export const TerminalShellSchema = z.enum(['auto', 'cmd', 'powershell', 'bash'])
export type TerminalShell = z.infer<typeof TerminalShellSchema>

/** Composer interaction mode: Ask (read-only), Plan (plan artifacts), Agent (full). */
export const AgentInteractionModeSchema = z.enum(['ask', 'plan', 'agent'])
export type AgentInteractionMode = z.infer<typeof AgentInteractionModeSchema>

export const SearchEngineSchema = z.enum(['duckduckgo', 'bing', 'google'])
export type SearchEngineId = z.infer<typeof SearchEngineSchema>

export const ToolApprovalSettingsSchema = z.object({
  mode: ToolApprovalModeSchema.default('off'),
  /** Tool names the user chose to always allow, persisted per workspace. */
  allowlist: z.array(z.string()).default([])
})
export type ToolApprovalSettings = z.infer<typeof ToolApprovalSettingsSchema>

export const DEFAULT_TOOL_APPROVAL: ToolApprovalSettings = { mode: 'off', allowlist: [] }

export const SettingsSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  ollamaBaseUrl: z.string().min(1),
  /** OpenAI-compatible base URL for the `custom` provider (must end with `/v1`). */
  customOpenAiBaseUrl: z.string().min(1).default('http://127.0.0.1:8080/v1'),
  theme: ThemeIdSchema,
  telemetryEnabled: z.boolean().default(false),
  mcpServers: z.array(McpServerSchema).default([]),
  compactionTriggerRatio: z.number().min(0.5).max(0.95).default(0.7),
  keepRecentTurns: z.number().int().min(4).max(50).default(12),
  thinkingEnabled: z.boolean().default(true),
  thinkingEffort: ThinkingEffortSchema.default('medium'),
  showThinking: z.boolean().default(true),
  favoriteModels: z.array(z.string()).default([]),
  recentModels: z.array(z.string()).max(5).default([]),
  thinkingPrefsByProvider: z.record(ProviderIdSchema, ThinkingPrefsSchema).default({}),
  serviceTierByModel: z.record(z.string(), ServiceTierSchema).default({}),
  serviceTier: ServiceTierSchema.default('default'),
  toolApproval: ToolApprovalSettingsSchema.default(DEFAULT_TOOL_APPROVAL),
  /** Default search engine for browser_search. */
  searchEngine: SearchEngineSchema.default('duckduckgo'),
  /** Set after first-send tool approval onboarding modal is shown or dismissed. */
  toolApprovalOnboardingDone: z.boolean().default(false),
  /** Shell used by the terminal tool. `auto` prefers PowerShell on Windows when available. */
  terminalShell: TerminalShellSchema.default('auto'),
  /**
   * Optional override for the diagnostics tool typecheck command.
   * Empty = auto-detect from package.json scripts / tsc.
   */
  diagnosticsCommand: z.string().default(''),
  /**
   * When true, `/harness-review` may one-shot rewrite the proposed harness body via the LLM.
   * Default off — rule-based notes-append only. Apply stays human-gated.
   */
  harnessProposalRewriter: z.boolean().default(false),
  /**
   * When true, the agent may call `switch_mode` mid-run as the task phase changes.
   * When false, only the user changes mode (composer picker or slash). Default off.
   */
  autoModeSwitch: z.boolean().default(false),
  /**
   * Default provider for the `generate_image` tool. `auto` = first available key
   * (prefer matching chat provider when it is openai/gemini/xai).
   */
  imageProvider: ImageProviderSettingSchema.default('auto'),
  /**
   * Optional default image model for `generate_image`. Empty = provider default
   * (gpt-image-2 / gemini-3.1-flash-image / grok-imagine-image-quality).
   */
  imageModel: z.string().default(''),
  /**
   * When true, image tools may use the Custom OpenAI-compatible base URL after a
   * capability probe. Off by default — chat Completions ≠ Images API.
   */
  customImageEnabled: z.boolean().default(false),
  /**
   * GitHub App / OAuth App client ID for in-app device-flow Connect.
   * Empty falls back to `VYOTIQ_GITHUB_CLIENT_ID` env.
   */
  githubClientId: z.string().default(''),
  marketplace: MarketplaceSettingsSchema.default(DEFAULT_MARKETPLACE_SETTINGS)
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  provider: 'ollama',
  model: 'qwen2.5',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1',
  theme: 'system',
  telemetryEnabled: false,
  mcpServers: [],
  compactionTriggerRatio: 0.7,
  keepRecentTurns: 12,
  thinkingEnabled: true,
  thinkingEffort: 'medium',
  showThinking: true,
  favoriteModels: [],
  recentModels: [],
  thinkingPrefsByProvider: {},
  serviceTierByModel: {},
  serviceTier: 'default',
  toolApproval: DEFAULT_TOOL_APPROVAL,
  searchEngine: 'duckduckgo',
  toolApprovalOnboardingDone: false,
  terminalShell: 'auto',
  diagnosticsCommand: '',
  harnessProposalRewriter: false,
  autoModeSwitch: false,
  imageProvider: 'auto',
  imageModel: '',
  customImageEnabled: false,
  githubClientId: '',
  marketplace: DEFAULT_MARKETPLACE_SETTINGS
}

export const SetSettingsRequestSchema = SettingsSchema.partial()
export type SetSettingsRequest = z.infer<typeof SetSettingsRequestSchema>

export const WindowMaximizedChangedSchema = z.boolean()

export const TelemetryStatusSchema = z.object({
  dsnConfigured: z.boolean(),
  telemetryEnabled: z.boolean()
})
export type TelemetryStatus = z.infer<typeof TelemetryStatusSchema>

export const CrashSnippetSchema = z.object({
  at: z.string().min(1),
  kind: z.enum(['renderer', 'child']),
  reason: z.string().min(1),
  exitCode: z.number().int().optional(),
  exitCodeHex: z.string().optional(),
  processType: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  crashDumpCount: z.number().int().min(0).optional()
})
export type CrashSnippet = z.infer<typeof CrashSnippetSchema>

export const CrashRecoveryPendingSchema = z.object({
  at: z.string().min(1),
  reason: z.string().min(1),
  exitCode: z.number().int().optional(),
  exitCodeHex: z.string().optional()
})
export type CrashRecoveryPending = z.infer<typeof CrashRecoveryPendingSchema>

export const CrashDiagnosticsSnapshotSchema = z.object({
  snippets: z.array(CrashSnippetSchema),
  pendingRecovery: CrashRecoveryPendingSchema.nullable()
})
export type CrashDiagnosticsSnapshot = z.infer<typeof CrashDiagnosticsSnapshotSchema>

export function parseSettings(data: unknown): Settings {
  return SettingsSchema.parse(data)
}
