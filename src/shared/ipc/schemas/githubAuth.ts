import { z } from 'zod'

export const GithubAuthStatusSchema = z.object({
  ghAvailable: z.boolean(),
  clientIdConfigured: z.boolean(),
  hasAppToken: z.boolean(),
  pending: z.boolean(),
  userCode: z.string().nullable(),
  verificationUri: z.string().nullable(),
  error: z.string().nullable()
})
export type GithubAuthStatus = z.infer<typeof GithubAuthStatusSchema>

export const ShellOpenExternalRequestSchema = z.object({
  url: z.string().min(1).max(2048)
})
