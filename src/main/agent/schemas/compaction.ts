import { z } from 'zod'
import { zodToJsonSchema } from './zodToJsonSchema'

export const CompactionSchema = z.object({
  sessionIntent: z.string(),
  filesTouched: z.array(z.string()),
  keyDecisions: z.array(z.string()),
  constraints: z.array(z.string()),
  openBlockers: z.array(z.string()),
  nextSteps: z.array(z.string())
})

export type CompactionData = z.infer<typeof CompactionSchema>

export function toCompactionJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(CompactionSchema)
}

export function compactionToMarkdown(data: CompactionData): string {
  const section = (title: string, items: string[]): string => {
    if (!items.length) return `## ${title}\n(none)`
    return `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}`
  }
  return [
    `## Session Intent\n${data.sessionIntent}`,
    section('Files Touched', data.filesTouched),
    section('Key Decisions', data.keyDecisions),
    section('Constraints', data.constraints),
    section('Open Bugs/Blockers', data.openBlockers),
    section('Next Steps', data.nextSteps)
  ].join('\n\n')
}

export function parseCompactionJson(text: string): {
  structured: CompactionData | null
  markdown: string
} {
  const trimmed = text.trim()
  if (!trimmed) return { structured: null, markdown: '' }

  try {
    const json = JSON.parse(trimmed) as unknown
    const result = CompactionSchema.safeParse(json)
    if (result.success) {
      return { structured: result.data, markdown: compactionToMarkdown(result.data) }
    }
  } catch {
    // fall through to freeform
  }

  return { structured: null, markdown: trimmed }
}
