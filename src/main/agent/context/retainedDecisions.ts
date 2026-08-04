import type { ChatMessage } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'

const USER_ANSWERED_RE = /^User answered:\s*(.+)$/im

/**
 * Pull user decisions (ask_question answers) out of a message set so they can
 * survive trim-without-LLM-summary folds. AppData ba335d72: step 73→74 dropped
 * ~51k history tokens with only a trim watermark — no summary — then the model
 * re-explored instead of executing the answered choice.
 */
export function extractAskQuestionDecisions(messages: readonly ChatMessage[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool' || m.toolName !== 'ask_question') continue
    const text = contentToText(m.content).trim()
    if (!text) continue
    const match = text.match(USER_ANSWERED_RE)
    const line = match?.[1]?.trim() || text.slice(0, 240)
    if (!line || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/** System/loop notice that keeps answered decisions after history trim. */
export function loopHintForRetainedDecisions(decisions: readonly string[]): string | undefined {
  if (decisions.length === 0) return undefined
  const lines = decisions.slice(0, 8).map((d) => `- ${d}`)
  const more = decisions.length > 8 ? `\n- (+${decisions.length - 8} more)` : ''
  return [
    'Retained user decisions (do not re-ask; execute these next — do not stop at inspecting files):',
    ...lines
  ].join('\n') + more
}
