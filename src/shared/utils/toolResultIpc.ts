import { contentToText, type AgentEvent, type ChatMessage } from '../ipc'

/** Matches ToolRow display cap — IPC should not ship more than the UI can show live. */
export const TOOL_RESULT_IPC_PREVIEW_CHARS = 4000

export function truncateToolResultContent(content: string | undefined): string | undefined {
  if (!content) return content
  if (content.length <= TOOL_RESULT_IPC_PREVIEW_CHARS) return content
  return `${content.slice(0, TOOL_RESULT_IPC_PREVIEW_CHARS)}\n…`
}

/** Shrink tool_result payloads before Structured Clone IPC; persistence keeps full content. */
export function toolResultEventForIpc(event: AgentEvent): AgentEvent {
  if (event.type !== 'tool_result') return event
  if (!event.content || event.content.length <= TOOL_RESULT_IPC_PREVIEW_CHARS) return event
  return {
    ...event,
    content: truncateToolResultContent(event.content),
    contentTruncated: true
  }
}

/** Bound persisted history sent to the renderer without changing on-disk history. */
export function toolMessageForIpc(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool') return message
  const content = contentToText(message.content)
  if (content.length <= TOOL_RESULT_IPC_PREVIEW_CHARS) return message
  return {
    ...message,
    content: truncateToolResultContent(content) ?? '',
    contentTruncated: true
  }
}

const PERSISTED_TOOL_RESULT_CONTENT_MAX = 200

/** Slim tool_result for events.jsonl — full output stays in messages.jsonl only. */
export function toolResultEventForPersistence(event: AgentEvent): AgentEvent {
  if (event.type !== 'tool_result') return event
  const { content, contentTruncated: _contentTruncated, ...rest } = event
  if (content && content.length <= PERSISTED_TOOL_RESULT_CONTENT_MAX) {
    return { ...rest, content }
  }
  return rest
}
