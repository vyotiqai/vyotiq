import type { ModelInfo, ProviderId } from '../../../shared/ipc'
import { contentWindow } from './budget'

/**
 * Anthropic native context options. Server-side clear_tool_uses and compact
 * edits are disabled — LLM summarization is the only shrink path. Prompt
 * caching still uses enableContextManagement=false so no context edits are sent.
 */
export function anthropicNativeOptions(
  providerId: ProviderId,
  model: ModelInfo | number
): {
  enableContextManagement: boolean
} {
  const enable = providerId === 'anthropic'
  void (typeof model === 'number' ? model : contentWindow(model))
  return {
    enableContextManagement: false
  }
}
