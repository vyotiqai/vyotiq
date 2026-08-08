import { z } from 'zod'
import { ProviderIdSchema, ThinkingEffortSchema } from './providers'
import { MarketplaceOverridesSchema } from './marketplace'
import {
  AgentInteractionModeSchema,
  ToolApprovalSettingsSchema
} from './settings'

export const WorkspaceUiStateSchema = z.object({
  activeRunId: z.string().nullable(),
  openRunIds: z.array(z.string()),
  scrollTop: z.number(),
  scrollTopByRunId: z.record(z.string(), z.number()).default({}),
  composerDraft: z.string(),
  composerDraftByRunId: z.record(z.string(), z.string()).default({}),
  /** Per-workspace composer Ask / Plan / Agent mode. */
  agentMode: AgentInteractionModeSchema.default('agent'),
  /**
   * Monotonic client write generation. Main ignores updates with a lower
   * generation than the last accepted write for that path (out-of-order IPC).
   */
  writeGeneration: z.number().int().nonnegative().optional()
})
export type WorkspaceUiState = z.infer<typeof WorkspaceUiStateSchema>

export const WorkspaceSettingsOverrideSchema = z.object({
  provider: ProviderIdSchema.optional(),
  model: z.string().min(1).optional(),
  ollamaBaseUrl: z.string().min(1).optional(),
  customOpenAiBaseUrl: z.string().min(1).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.95).optional(),
  keepRecentTurns: z.number().int().min(4).max(50).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingEffort: ThinkingEffortSchema.optional(),
  showThinking: z.boolean().optional(),
  toolApproval: ToolApprovalSettingsSchema.optional(),
  /** Per-id enable overrides for marketplace MCP / skills / plugins. */
  marketplaceOverrides: MarketplaceOverridesSchema.optional(),
  useOverride: z.boolean()
})
export type WorkspaceSettingsOverride = z.infer<typeof WorkspaceSettingsOverrideSchema>

export const WorkspacesStateSchema = z.object({
  version: z.literal(2),
  workspaceIdsByPath: z.record(z.string(), z.string()).optional(),
  legacySessionsMigrated: z.boolean(),
  needsWorkspaceForMigration: z.boolean().optional(),
  pendingMigrationCount: z.number().int().nonnegative().optional(),
  openPaths: z.array(z.string()),
  activePath: z.string().nullable(),
  recentPaths: z.array(z.string()),
  uiStateByPath: z.record(z.string(), WorkspaceUiStateSchema),
  settingsOverridesByPath: z.record(z.string(), WorkspaceSettingsOverrideSchema)
})
export type WorkspacesState = z.infer<typeof WorkspacesStateSchema>

export const WorkspacesAddRequestSchema = z.object({
  path: z.string().min(1).optional()
})
export type WorkspacesAddRequest = z.infer<typeof WorkspacesAddRequestSchema>

export const WorkspacesRemoveRequestSchema = z.object({
  path: z.string().min(1),
  stopActiveRuns: z.boolean().optional().default(false)
})
export type WorkspacesRemoveRequest = z.infer<typeof WorkspacesRemoveRequestSchema>

export const WorkspacesSetActiveRequestSchema = z.object({
  path: z.string().min(1)
})
export type WorkspacesSetActiveRequest = z.infer<typeof WorkspacesSetActiveRequestSchema>

export const WorkspacesUpdateUiStateRequestSchema = z.object({
  path: z.string().min(1),
  ui: WorkspaceUiStateSchema
})
export type WorkspacesUpdateUiStateRequest = z.infer<typeof WorkspacesUpdateUiStateRequestSchema>

export const WorkspacesSetSettingsOverrideRequestSchema = z.object({
  path: z.string().min(1),
  override: WorkspaceSettingsOverrideSchema.nullable()
})
export type WorkspacesSetSettingsOverrideRequest = z.infer<
  typeof WorkspacesSetSettingsOverrideRequestSchema
>
