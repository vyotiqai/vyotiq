import type {
  LlmProvider,
  ListModelsRequest,
  ProviderChatRequest,
  StreamChunk
} from './types'
import type { ModelInfo } from '../../../shared/ipc'
import { createOpenAiCompatibleProvider } from './openai'
import { streamOpenAiResponses } from './openaiResponses'
import { streamAnthropicMessages } from './anthropic'
import {
  clampEffortToOpenCodeGoLadder,
  getCachedOpenCodeGoEffortLadder,
  mergeOpenCodeGoMeta,
  normalizeOpenCodeGoModelId,
  opencodeGoEffortLadderFor,
  opencodeGoFloorEffort,
  opencodeGoTransportFor,
  loadOpenCodeGoCatalog,
  type OpenCodeTransport
} from '../../../shared/domain/opencodeGoCatalog'

const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1'

/**
 * Chat-completions transport opts. `enablePromptCache` forwards the loop's
 * promptCacheKey (runId) as `prompt_cache_key` so the gateway keeps cache
 * affinity across steps — without it live runs bounce between cache shards
 * (measured 2026-08-31: 3.8–10% overall hit rate, binary 0%/100% alternation,
 * run 72d5df60). Hosts that reject the field retry once without it
 * (shouldRetryOmitCacheKey).
 */
export const OPENCODE_CHAT_OPTS = {
  defaultBaseUrl: OPENCODE_GO_BASE,
  enablePromptCache: true
} as const

const opencodeChat = createOpenAiCompatibleProvider('opencode', OPENCODE_CHAT_OPTS)

/** Endpoint family for a model id — shared with reasoning/thinking wiring. */
export function opencodeEndpointFor(model: string): OpenCodeTransport {
  return opencodeGoTransportFor(model)
}

/**
 * Exported for tests — merge live catalog rows with runtime registry thinking
 * ladders. The registry (models.dev `opencode-go`) is fetched live, so this is
 * async; callers await it.
 */
export async function mergeGoMeta(m: ModelInfo): Promise<ModelInfo> {
  await loadOpenCodeGoCatalog()
  const bare: ModelInfo = { ...m, id: normalizeOpenCodeGoModelId(m.id) }
  const merged = mergeOpenCodeGoMeta(bare)
  // Registry ladders are authoritative where declared (models.dev
  // reasoning_options). These models reject unlisted reasoning_effort levels,
  // and every one with a declared ladder also rejects a disable (the mount
  // still thinks when the field is omitted) — so clamp UI choices to the
  // ladder and mark disable unsupported.
  const ladder = await opencodeGoEffortLadderFor(merged.id)
  if (!ladder || merged.supportsThinking !== true) return merged
  return {
    ...merged,
    thinkingMode: merged.thinkingMode ?? 'effort',
    thinkingCanDisable: false,
    supportedThinkingEfforts: [...ladder]
  }
}

/**
 * Resolve the outgoing ThinkingConfig for a Go request. Chat-mount ladders
 * apply where declared (models.dev reasoning_options); Responses/Messages
 * request normalizers own the mapping for their transports. On ladder-declared
 * models an explicit disable is impossible — the mount rejects unlisted effort
 * levels ("[1210] cannot be disabled") and still thinks when the field is
 * omitted (live-verified) — so a disable request becomes the model's floor
 * effort with display omitted.
 */
export function opencodeThinkingFor(
  model: string,
  thinking: ProviderChatRequest['thinking']
): ProviderChatRequest['thinking'] {
  const shape = opencodeEndpointFor(model)
  const ladder = shape === 'chat' ? getCachedOpenCodeGoEffortLadder(model) : undefined
  if (thinking?.enabled === false) {
    return ladder
      ? { enabled: true, effort: opencodeGoFloorEffort(ladder), display: 'omitted' }
      : thinking
  }
  return {
    enabled: true,
    effort: ladder
      ? clampEffortToOpenCodeGoLadder(thinking?.effort ?? 'medium', ladder)
      : (thinking?.effort ?? 'medium'),
    display: thinking?.display ?? 'summarized'
  }
}

export const opencodeProvider: LlmProvider = {
  id: 'opencode',
  async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    if (!req.apiKey) {
      yield { type: 'error', error: 'OpenCode Go API key not set' }
      return
    }
    const reqWithThinking: ProviderChatRequest = {
      ...req,
      thinking: opencodeThinkingFor(req.model, req.thinking)
    }
    const shape = opencodeEndpointFor(req.model)
    if (shape === 'responses') {
      yield* streamOpenAiResponses(reqWithThinking, `${OPENCODE_GO_BASE}/responses`)
      return
    }
    if (shape === 'messages') {
      yield* streamAnthropicMessages(reqWithThinking, `${OPENCODE_GO_BASE}/messages`)
      return
    }
    yield* opencodeChat.streamChat(reqWithThinking)
  },
  async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
    // Errors propagate so listProviderModels surfaces actionable warnings and
    // applies its generic seed fallback instead of failing silently here.
    const live = await opencodeChat.listModels(req)
    return Promise.all(live.map((m) => mergeGoMeta(m)))
  }
}
