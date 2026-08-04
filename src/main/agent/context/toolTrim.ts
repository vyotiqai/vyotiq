import type { ChatMessage } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'
import { KEEP_LAST_TOOL_RESULTS } from './types'
import {
  CLEARED_TOOL_RESULT_STUB,
  isDurableToolResultName
} from './durableToolResults'

const MAX_TOOL_CHARS = 8_000

export type TrimToolResultsOptions = Record<string, never>

/** Stub text for cleared ephemeral tool bodies. */
export function clearedToolStub(_text: string): string {
  return CLEARED_TOOL_RESULT_STUB
}

/**
 * Collapse old ephemeral tool bodies; never stub durable tools (ask_question,
 * todo_write, memory_*). File `read` is clearable. Oversized kept bodies are
 * head+tail truncated.
 */
export function trimToolResults(
  messages: ChatMessage[],
  keepLast = KEEP_LAST_TOOL_RESULTS,
  _opts: TrimToolResultsOptions = {}
): ChatMessage[] {
  const toolIndexes: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    // Durable results never count toward the clearable pool / keep window.
    if (isDurableToolResultName(m.toolName)) continue
    toolIndexes.push(i)
  }
  const keep = new Set(toolIndexes.slice(-Math.max(0, keepLast)))

  return messages.map((m, i) => {
    if (m.role !== 'tool') return m
    if (isDurableToolResultName(m.toolName)) {
      // Cap absurdly large durable bodies (e.g. memory dumps) so one result cannot blow the window.
      const text = contentToText(m.content)
      const maxChars = MAX_TOOL_CHARS
      if (text.length > maxChars) {
        const head = Math.floor(maxChars * 0.6)
        const tail = maxChars - head - 40
        return {
          ...m,
          content: `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`
        }
      }
      return m
    }
    const text = contentToText(m.content)
    const stub = clearedToolStub(text)
    if (!keep.has(i) && text && text !== stub && !text.endsWith(CLEARED_TOOL_RESULT_STUB)) {
      return { ...m, content: stub }
    }
    if (text.length > MAX_TOOL_CHARS) {
      const head = Math.floor(MAX_TOOL_CHARS * 0.6)
      const tail = MAX_TOOL_CHARS - head - 40
      return {
        ...m,
        content: `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`
      }
    }
    return m
  })
}
