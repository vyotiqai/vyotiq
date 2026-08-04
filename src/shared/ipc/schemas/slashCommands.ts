import { z } from 'zod'

export const SlashCommandKindSchema = z.enum([
  'builtin',
  'skill',
  'workspace',
  'rule',
  'mcp'
])
export type SlashCommandKind = z.infer<typeof SlashCommandKindSchema>

export const SlashCommandAvailabilitySchema = z.enum([
  'ready',
  'disabled',
  'not_installed',
  'needs_auth',
  'disconnected'
])
export type SlashCommandAvailability = z.infer<typeof SlashCommandAvailabilitySchema>

export const SlashCommandDescriptorSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
  kind: SlashCommandKindSchema,
  group: z.string().min(1),
  availability: SlashCommandAvailabilitySchema,
  packageId: z.string().min(1).optional(),
  mcpServerId: z.string().min(1).optional(),
  mcpToolName: z.string().min(1).optional()
})
export type SlashCommandDescriptor = z.infer<typeof SlashCommandDescriptorSchema>

export const BuiltinClientActionSchema = z.enum([
  'clear',
  'compact',
  'open_marketplace',
  'open_settings',
  'create_rule',
  'undo_writes',
  'set_mode_ask',
  'set_mode_plan',
  'set_mode_agent',
  'harness_apply'
])
export type BuiltinClientAction = z.infer<typeof BuiltinClientActionSchema>

export const SlashCommandResolveResultSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    message: z.string()
  }),
  z.object({
    action: z.literal('client'),
    clientAction: BuiltinClientActionSchema,
    trailingText: z.string().optional(),
    mcpServerId: z.string().min(1).optional()
  }),
  z.object({
    action: z.literal('marketplace'),
    packageId: z.string().min(1),
    intent: z.enum(['install', 'enable'])
  }),
  z.object({
    action: z.literal('open_file'),
    path: z.string().min(1)
  })
])
export type SlashCommandResolveResult = z.infer<typeof SlashCommandResolveResultSchema>

export const SlashCommandsListRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional()
})
export type SlashCommandsListRequest = z.infer<typeof SlashCommandsListRequestSchema>

export const SlashCommandsListResultSchema = z.object({
  commands: z.array(SlashCommandDescriptorSchema)
})
export type SlashCommandsListResult = z.infer<typeof SlashCommandsListResultSchema>

export const SlashCommandsResolveRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1).nullable().optional(),
  trailingText: z.string().optional()
})
export type SlashCommandsResolveRequest = z.infer<typeof SlashCommandsResolveRequestSchema>

export const SlashCommandsCreateRuleRequestSchema = z.object({
  workspacePath: z.string().min(1),
  title: z.string().optional()
})
export type SlashCommandsCreateRuleRequest = z.infer<typeof SlashCommandsCreateRuleRequestSchema>

export const SlashCommandsCreateRuleResultSchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1)
})
export type SlashCommandsCreateRuleResult = z.infer<typeof SlashCommandsCreateRuleResultSchema>

export const SlashCommandsOpenFileRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1)
})
export type SlashCommandsOpenFileRequest = z.infer<typeof SlashCommandsOpenFileRequestSchema>
