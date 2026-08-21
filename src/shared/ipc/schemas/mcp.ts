import { z } from 'zod'

export const McpServerStatusSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  connected: z.boolean(),
  toolCount: z.number().int().min(0),
  /** True when a Bearer token is stored in OS secure storage for this server. */
  hasAuthToken: z.boolean().optional(),
  error: z.string().optional()
})
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>

export const McpStatusResultSchema = z.object({
  servers: z.array(McpServerStatusSchema)
})
export type McpStatusResult = z.infer<typeof McpStatusResultSchema>

/** Omitted/null workspacePath = active workspace scope; a string scopes to that workspace. */
export const McpStatusRequestSchema = z.object({
  workspacePath: z.string().nullish()
})
export type McpStatusRequest = z.infer<typeof McpStatusRequestSchema>

export const McpRefreshRequestSchema = McpStatusRequestSchema
export type McpRefreshRequest = McpStatusRequest

export const McpSetAuthTokenRequestSchema = z.object({
  serverId: z.string().min(1),
  token: z.string().min(1)
})
export type McpSetAuthTokenRequest = z.infer<typeof McpSetAuthTokenRequestSchema>

export const McpClearAuthTokenRequestSchema = z.object({
  serverId: z.string().min(1)
})
export type McpClearAuthTokenRequest = z.infer<typeof McpClearAuthTokenRequestSchema>

export const McpStartOAuthRequestSchema = z.object({
  serverId: z.string().min(1)
})
export type McpStartOAuthRequest = z.infer<typeof McpStartOAuthRequestSchema>
