import type { ChatMessage, ModelInfo } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'
import { logger } from '../../../shared/logger'
import type { LlmProvider } from '../providers/types'
import {
  parseCompactionJson,
  toCompactionJsonSchema,
  type CompactionData
} from '../schemas/compaction'
import { collectStructuredResponse } from '../schemas/structured'
import {
  estimateMessagesTokens,
  estimateMessagesTokensAsync,
  estimateTextTokensAsync
} from './estimate'
import { stripLeadingOrphanToolMessages } from './historyTrim'
import { KEEP_RECENT_TURNS, type CompactionRecord } from './types'

const COMPACTION_PROMPT = `Summarize this coding-agent session for future context. Be concise and factual. Do not invent files or decisions.`

const COMPACTION_FREEFORM_PROMPT = `Summarize this coding-agent session for future context. Use exactly these sections:

## Session Intent
## Files Touched
## Key Decisions
## Constraints
## Open Bugs/Blockers
## Next Steps

Be concise and factual. Do not invent files or decisions.`

function capRollingSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const tail = text.slice(-maxChars)
  const firstNewline = tail.indexOf('\n')
  return firstNewline > 0 ? `…${tail.slice(firstNewline)}` : `… ${tail}`
}

async function streamFreeformSummary(input: {
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  historyText: string
}): Promise<string> {
  let summary = ''
  for await (const chunk of input.provider.streamChat({
    model: input.model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    signal: input.signal,
    tools: [],
    system: COMPACTION_FREEFORM_PROMPT,
    messages: [{ role: 'user', content: input.historyText }]
  })) {
    if (input.signal.aborted) return ''
    if (chunk.type === 'text' && chunk.text) summary += chunk.text
    if (chunk.type === 'error') {
      logger.warn('Compaction freeform stream error', {
        scope: 'agent',
        code: 'COMPACTION_STREAM'
      })
      return ''
    }
  }
  return summary.trim()
}

function formatMessagesForCompaction(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const body = contentToText(m.content)
      const tools = m.toolCalls?.map((t) => `${t.name}(${t.arguments})`).join(', ')
      return `${m.role}${tools ? ` tools=${tools}` : ''}: ${body}`
    })
    .join('\n\n')
}

/** Split messages into chunks that fit under charCap (greedy by message). */
function chunkMessagesForCap(messages: ChatMessage[], charCap: number): ChatMessage[][] {
  if (messages.length === 0) return []
  const chunks: ChatMessage[][] = []
  let current: ChatMessage[] = []
  let currentChars = 0
  for (const message of messages) {
    const piece = formatMessagesForCompaction([message])
    const pieceLen = piece.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && currentChars + pieceLen > charCap) {
      chunks.push(current)
      current = [message]
      currentChars = piece.length
    } else {
      current.push(message)
      currentChars += pieceLen
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

async function summarizeHistoryChunk(input: {
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  historyText: string
  supportsStructuredOutput?: boolean
}): Promise<string> {
  let summary = ''
  const useStructured = input.supportsStructuredOutput !== false

  if (useStructured) {
    try {
      const result = await collectStructuredResponse<CompactionData>(
        input.provider,
        {
          model: input.model,
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          signal: input.signal,
          tools: [],
          system: COMPACTION_PROMPT,
          messages: [{ role: 'user', content: input.historyText }],
          responseFormat: {
            type: 'json_schema',
            name: 'compaction_summary',
            schema: toCompactionJsonSchema(),
            strict: true
          }
        },
        (raw) => {
          const parsed = parseCompactionJson(raw)
          if (parsed.structured) return { ok: true, data: parsed.structured }
          return { ok: false, error: 'invalid compaction schema' }
        }
      )
      const parsed = parseCompactionJson(result.rawText)
      if (result.ok || parsed.markdown) {
        summary = parsed.markdown
      }
    } catch (err) {
      logger.warn('Structured compaction failed, falling back to freeform', {
        scope: 'agent',
        code: 'COMPACTION',
        err
      })
    }
  }

  if (!summary) {
    if (input.signal.aborted) return ''
    summary = await streamFreeformSummary({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal: input.signal,
      historyText: input.historyText
    })
  }
  return summary.trim()
}

export async function compactMessages(input: {
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  messages: ChatMessage[]
  supportsStructuredOutput?: boolean
  contextWindow?: number
  /** Previous compaction summary to retain across successive folds. */
  priorSummary?: string
}): Promise<CompactionRecord | null> {
  if (input.signal.aborted) return null

  const tokenCap = Math.max(
    4000,
    Math.floor((input.contextWindow ?? 128_000) * 0.25)
  )
  const charCap = tokenCap * 4

  const prior = capRollingSummary(input.priorSummary?.trim() ?? '', charCap)
  const chunks = chunkMessagesForCap(input.messages, Math.max(2000, charCap - 500))
  if (chunks.length === 0) {
    return prior
      ? {
          summary: prior,
          createdAt: new Date().toISOString(),
          tokenEstimate: await estimateTextTokensAsync(prior)
        }
      : null
  }

  let mergedPrior = prior
  const parts: string[] = []

  for (const chunk of chunks) {
    if (input.signal.aborted) return null
    const historyText = formatMessagesForCompaction(chunk).slice(0, charCap)
    if (!historyText.trim()) continue

    const summary = await summarizeHistoryChunk({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal: input.signal,
      historyText,
      supportsStructuredOutput: input.supportsStructuredOutput
    })
    if (!summary) continue
    parts.push(summary)
    mergedPrior = mergedPrior
      ? capRollingSummary(`${mergedPrior}\n\n---\n\n${summary}`, charCap)
      : capRollingSummary(summary, charCap)
  }

  if (parts.length === 0) {
    logger.warn('Compaction produced no summary despite eligible history', {
      scope: 'agent',
      code: 'COMPACTION',
      messageCount: input.messages.length
    })
    return null
  }

  const merged = capRollingSummary(parts.length === 1 && !prior ? parts[0]! : mergedPrior, charCap)
  return {
    summary: merged,
    createdAt: new Date().toISOString(),
    tokenEstimate: await estimateTextTokensAsync(merged)
  }
}

/** Keep the last ~N user/assistant turns (tool pairs included). */
export function preserveRecentMessages(
  messages: ChatMessage[],
  keepTurns = KEEP_RECENT_TURNS,
  historyBudgetTokens?: number,
  model?: ModelInfo
): ChatMessage[] {
  let userTurns = 0
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userTurns++
      if (userTurns >= keepTurns) {
        start = i
        break
      }
    }
  }

  if (userTurns < keepTurns) {
    if (!historyBudgetTokens || !model) return messages
    if (estimateMessagesTokens(messages, model) <= historyBudgetTokens) return messages
    start = Math.min(start + 2, messages.length - 1)
  }

  let kept = stripLeadingOrphanToolMessages(messages.slice(start))
  // Budget/index trim landed inside a tool turn — rewind to include the owner.
  while (kept.length === 0 && start > 0) {
    start--
    kept = stripLeadingOrphanToolMessages(messages.slice(start))
  }
  if (kept.length === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'tool') return messages.slice(i)
    }
    return messages.slice(-1)
  }

  if (historyBudgetTokens && model) {
    while (
      kept.length > 2 &&
      estimateMessagesTokens(kept, model) > historyBudgetTokens
    ) {
      const dropIdx = kept.findIndex((m) => m.role === 'user')
      if (dropIdx < 0) break
      const nextUser = kept.findIndex((m, idx) => idx > dropIdx && m.role === 'user')
      const end = nextUser >= 0 ? nextUser : kept.length
      let next = stripLeadingOrphanToolMessages(kept.slice(end))
      if (next.length === 0) break
      kept = next
    }
  }

  return kept
}

/** Async variant — BPE for uncached strings runs off the main thread when workers are available. */
export async function preserveRecentMessagesAsync(
  messages: ChatMessage[],
  keepTurns = KEEP_RECENT_TURNS,
  historyBudgetTokens?: number,
  model?: ModelInfo
): Promise<ChatMessage[]> {
  let userTurns = 0
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userTurns++
      if (userTurns >= keepTurns) {
        start = i
        break
      }
    }
  }

  if (userTurns < keepTurns) {
    if (!historyBudgetTokens || !model) return messages
    if ((await estimateMessagesTokensAsync(messages, model)) <= historyBudgetTokens) return messages
    start = Math.min(start + 2, messages.length - 1)
  }

  let kept = stripLeadingOrphanToolMessages(messages.slice(start))
  while (kept.length === 0 && start > 0) {
    start--
    kept = stripLeadingOrphanToolMessages(messages.slice(start))
  }
  if (kept.length === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'tool') return messages.slice(i)
    }
    return messages.slice(-1)
  }

  if (historyBudgetTokens && model) {
    while (
      kept.length > 2 &&
      (await estimateMessagesTokensAsync(kept, model)) > historyBudgetTokens
    ) {
      const dropIdx = kept.findIndex((m) => m.role === 'user')
      if (dropIdx < 0) break
      const nextUser = kept.findIndex((m, idx) => idx > dropIdx && m.role === 'user')
      const end = nextUser >= 0 ? nextUser : kept.length
      const next = stripLeadingOrphanToolMessages(kept.slice(end))
      if (next.length === 0) break
      kept = next
    }
  }

  return kept
}
