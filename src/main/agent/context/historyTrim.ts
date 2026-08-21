import type { ChatMessage } from '../../../shared/ipc'
import type { ModelInfo } from '../../../shared/ipc/schemas/providers'
import { estimateMessagesTokens, estimateMessagesTokensAsync } from './estimate'

/**
 * Drop leading `tool` rows that are not preceded by a matching `assistant.tool_calls`
 * turn in the working set. Prevents OpenAI-compat HTTP 400 from orphan tool messages
 * after watermark / budget slices that leave a lone `[tool]` remainder.
 *
 * When the window is entirely orphan tools, returns `[]` so callers can rewind.
 */
export function stripLeadingOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages
  let kept = messages
  while (kept.length > 0 && kept[0].role === 'tool') {
    kept = kept.slice(1)
  }
  return kept
}

/**
 * Drop tool rows no provider can pair anywhere in the set: missing `toolCallId`,
 * or a result whose assistant tool call is absent (stale rows, partial slices).
 */
export function stripOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m.role === 'tool')) return messages
  const callIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const call of m.toolCalls) callIds.add(call.id)
    }
  }
  return messages.filter((m) => {
    if (m.role !== 'tool') return true
    return m.toolCallId != null && callIds.has(m.toolCallId)
  })
}

/**
 * Apply a compaction `foldedMessages` watermark without leaving a leading orphan
 * `tool` row (including the sole-message case).
 */
export function applyFoldedMessagesWatermark(
  messages: ChatMessage[],
  foldedMessages: number
): { messages: ChatMessage[]; foldedMessages: number } {
  if (foldedMessages <= 0 || messages.length === 0) {
    return { messages, foldedMessages: 0 }
  }
  let fold = Math.min(foldedMessages, Math.max(0, messages.length - 1))
  for (;;) {
    let kept = stripLeadingOrphanToolMessages(messages.slice(fold))
    if (kept.length > 0) {
      return { messages: kept, foldedMessages: fold + (messages.length - fold - kept.length) }
    }
    if (fold <= 0) {
      // Entire history is orphan tools — keep last non-tool if any, else last message.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'tool') {
          return { messages: messages.slice(i), foldedMessages: i }
        }
      }
      return {
        messages: messages.slice(-1),
        foldedMessages: Math.max(0, messages.length - 1)
      }
    }
    fold--
  }
}

/**
 * Drop a complete prefix turn so we never orphan tool results
 * (assistant+toolCalls without their tool messages, or tools without the call).
 */
export function dropOldestTurn(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 2) return stripOrphanToolMessages(messages)

  const first = messages[0]
  let i = 1

  if (first.role === 'user') {
    while (i < messages.length) {
      const m = messages[i]
      if (m.role === 'user') break
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const ids = new Set(m.toolCalls.map((t) => t.id))
        i++
        while (
          i < messages.length &&
          messages[i].role === 'tool' &&
          ids.has(messages[i].toolCallId ?? '')
        ) {
          i++
        }
        continue
      }
      if (m.role === 'assistant') {
        i++
        continue
      }
      if (m.role === 'tool') {
        i++
        continue
      }
      break
    }
  } else if (first.role === 'assistant' && first.toolCalls?.length) {
    const ids = new Set(first.toolCalls.map((t) => t.id))
    while (
      i < messages.length &&
      messages[i].role === 'tool' &&
      ids.has(messages[i].toolCallId ?? '')
    ) {
      i++
    }
  } else if (first.role === 'tool') {
    while (i < messages.length && messages[i].role === 'tool') i++
  }

  let next = messages.slice(Math.max(i, 1))
  next = stripLeadingOrphanToolMessages(next)
  return next.length >= 1 ? next : messages.slice(-2)
}

/** Fit history under a token budget without breaking tool-call pairs. */
export function trimHistoryToBudget(
  messages: ChatMessage[],
  historyBudget: number,
  model?: ModelInfo
): ChatMessage[] {
  let msgs = stripOrphanToolMessages(messages)
  while (msgs.length > 2 && estimateMessagesTokens(msgs, model) > historyBudget) {
    const trimmed = dropOldestTurn(msgs)
    if (trimmed.length >= msgs.length) break
    msgs = trimmed
  }
  return stripLeadingOrphanToolMessages(msgs)
}

/** Async variant — BPE for uncached strings runs off the main thread when workers are available. */
export async function trimHistoryToBudgetAsync(
  messages: ChatMessage[],
  historyBudget: number,
  model?: ModelInfo
): Promise<ChatMessage[]> {
  let msgs = stripOrphanToolMessages(messages)
  while (msgs.length > 2 && (await estimateMessagesTokensAsync(msgs, model)) > historyBudget) {
    const trimmed = dropOldestTurn(msgs)
    if (trimmed.length >= msgs.length) break
    msgs = trimmed
  }
  return stripLeadingOrphanToolMessages(msgs)
}
