import { z } from 'zod'

export const UpdaterStateSchema = z.enum([
  'idle',
  'checking',
  'available',
  'none',
  'downloading',
  'ready',
  'error',
  'dev'
])
export type UpdaterState = z.infer<typeof UpdaterStateSchema>

export const UpdaterStatusSchema = z.object({
  state: UpdaterStateSchema,
  version: z.string().optional(),
  message: z.string().optional(),
  progress: z.number().min(0).max(1).optional()
})
export type UpdaterStatus = z.infer<typeof UpdaterStatusSchema>
