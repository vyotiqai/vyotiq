import { z } from 'zod'

export const PrMergeMethodSchema = z.enum(['squash', 'merge', 'rebase'])
export type PrMergeMethod = z.infer<typeof PrMergeMethodSchema>

export const PrChangeTypeSchema = z.enum([
  'ADDED',
  'DELETED',
  'MODIFIED',
  'RENAMED',
  'COPIED',
  'CHANGED',
  'UNKNOWN'
])
export type PrChangeType = z.infer<typeof PrChangeTypeSchema>

export const PrFileSchema = z.object({
  path: z.string(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  changeType: PrChangeTypeSchema
})
export type PrFile = z.infer<typeof PrFileSchema>

export const PrCommitSchema = z.object({
  oid: z.string(),
  messageHeadline: z.string(),
  authors: z.array(z.string())
})

export const PrCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
  conclusion: z.string().nullable()
})

export const PrReviewSchema = z.object({
  author: z.string(),
  state: z.string(),
  body: z.string(),
  submittedAt: z.string().nullable()
})
export type PrReview = z.infer<typeof PrReviewSchema>

export const PrViewSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  baseRefOid: z.string(),
  headRefOid: z.string(),
  body: z.string(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  files: z.array(PrFileSchema),
  commits: z.array(PrCommitSchema),
  checks: z.array(PrCheckSchema),
  reviews: z.array(PrReviewSchema),
  latestReviews: z.array(PrReviewSchema),
  reviewDecision: z.string(),
  reviewRequests: z.array(z.string())
})
export type PrView = z.infer<typeof PrViewSchema>

export const PrViewRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const PrMergeRequestSchema = z.object({
  workspacePath: z.string().min(1),
  method: PrMergeMethodSchema
})

export const PrMergeResultSchema = z.object({
  detail: z.string()
})
export type PrMergeResult = z.infer<typeof PrMergeResultSchema>

export const PrDiffRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1).optional(),
  ignoreWhitespace: z.boolean().optional()
})

export const PrDiffResultSchema = z.object({
  content: z.string()
})

export const PrCloseRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const PrCloseResultSchema = z.object({
  detail: z.string()
})

export const PrEditTitleRequestSchema = z.object({
  workspacePath: z.string().min(1),
  title: z.string().min(1)
})

export const PrEditTitleResultSchema = z.object({
  title: z.string()
})
