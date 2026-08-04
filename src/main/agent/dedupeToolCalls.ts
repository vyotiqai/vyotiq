/** Shared last-wins-by-id tool call dedupe (Gemini re-emits mid-stream updates). */
import type { ToolCall } from './providers/types'

export function dedupeToolCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Map<string, ToolCall>()
  calls.forEach((call, index) => {
    // Without an id there is nothing that reliably identifies a call, and two
    // genuine calls can share name+arguments — key on position so they survive.
    const key = call.id?.trim() || `@${index}:${call.name}`
    seen.set(key, call)
  })
  return [...seen.values()]
}
