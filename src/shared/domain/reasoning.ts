import { z } from 'zod'
import type { ChatMessage, ProviderId } from '../ipc'
import {
  ThinkingApiSchema,
  ThinkingEffortSchema,
  ThinkingModeSchema,
  type ThinkingApi,
  type ThinkingEffort,
  type ThinkingMode
} from '../ipc/schemas/providers'
import { normalizeModelIdForHeuristics } from './serviceTier'

export {
  ThinkingApiSchema,
  ThinkingEffortSchema,
  ThinkingModeSchema,
  type ThinkingApi,
  type ThinkingEffort,
  type ThinkingMode
}
export { normalizeModelIdForHeuristics }

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean(),
  effort: ThinkingEffortSchema.optional(),
  maxTokens: z.number().int().positive().optional(),
  display: z.enum(['summarized', 'omitted']).optional()
})
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>

const AnthropicThinkingBlockSchema = z.object({
  type: z.enum(['thinking', 'redacted_thinking']),
  thinking: z.string().optional(),
  data: z.string().optional()
})

const OpenAiResponsesStateSchema = z.object({
  kind: z.literal('openai_responses'),
  responseId: z.string().optional(),
  outputItems: z.array(z.unknown())
})

const GeminiInteractionsStateSchema = z.object({
  kind: z.literal('gemini_interactions'),
  interactionId: z.string().optional(),
  thoughtSteps: z.array(z.unknown()).optional()
})

const AnthropicReasoningStateSchema = z.object({
  kind: z.literal('anthropic'),
  blocks: z.array(AnthropicThinkingBlockSchema)
})

/**
 * Stored Mistral-style ThinkChunk for multi-turn replay.
 * `text` is flattened for UI / reasoningContent; `thinking` preserves full inner
 * parts (TextChunk / ToolReference / Reference) when the API sent them.
 */
export const OpenAiCompatThinkChunkSchema = z.object({
  text: z.string(),
  signature: z.string().optional(),
  closed: z.boolean().optional(),
  /** Full inner `thinking[]` parts; omit for legacy flat-only state. */
  thinking: z.array(z.record(z.string(), z.unknown())).optional()
})
export type OpenAiCompatThinkChunk = z.infer<typeof OpenAiCompatThinkChunkSchema>

const OpenAiCompatReasoningStateSchema = z.object({
  kind: z.literal('openai_compat'),
  reasoningContent: z.string().optional(),
  reasoningDetails: z.unknown().optional(),
  /**
   * Wire shape used when the model emitted reasoning.
   * `think_chunks` = Mistral-style ThinkChunk arrays in `content`.
   * `reasoning_content` = DeepSeek/OpenAI-compat string field.
   */
  reasoningFormat: z.enum(['think_chunks', 'reasoning_content']).optional(),
  /** Structured ThinkChunks when `reasoningFormat` is `think_chunks` (preserves signature / layout). */
  thinkChunks: z.array(OpenAiCompatThinkChunkSchema).optional()
})

export const ProviderReasoningStateSchema = z.discriminatedUnion('kind', [
  OpenAiResponsesStateSchema,
  GeminiInteractionsStateSchema,
  AnthropicReasoningStateSchema,
  OpenAiCompatReasoningStateSchema
])
export type ProviderReasoningState = z.infer<typeof ProviderReasoningStateSchema>

export type AnthropicThinkingBlock = z.infer<typeof AnthropicThinkingBlockSchema>

/**
 * Ollama model family without tag / cloud size suffix.
 * `gpt-oss:120b-cloud` → `gpt-oss`; `deepseek-v3.1:671b-cloud` → `deepseek-v3.1`.
 */
export function ollamaModelFamily(id: string): string {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  const colon = core.indexOf(':')
  return colon >= 0 ? core.slice(0, colon) : core
}

/** GPT-OSS on Ollama uses `think: "low"|"medium"|"high"` and cannot fully disable. */
export function isOllamaGptOssModel(id: string): boolean {
  return /^gpt-oss/i.test(ollamaModelFamily(id))
}

/**
 * Catalog-omitted Ollama thinking defaults (docs.ollama.com/capabilities/thinking).
 * Prefer live catalog fields when present; use these only as fallback.
 */
export function ollamaThinkingHeuristicFields(id: string): {
  thinkingMode: ThinkingMode
  thinkingCanDisable: boolean
  supportedThinkingEfforts?: ThinkingEffort[]
  thinkingDefaultEffort?: ThinkingEffort
} {
  if (isOllamaGptOssModel(id)) {
    return {
      thinkingMode: 'effort',
      thinkingCanDisable: false,
      supportedThinkingEfforts: ['low', 'medium', 'high'],
      thinkingDefaultEffort: 'medium'
    }
  }
  return {
    thinkingMode: 'boolean',
    thinkingCanDisable: true
  }
}

/** Map product effort → Ollama `think` string levels. */
export function normalizeEffortForOllamaThink(
  effort?: ThinkingEffort,
  allowed?: readonly ThinkingEffort[]
): 'low' | 'medium' | 'high' | 'max' {
  let candidate: ThinkingEffort
  switch (effort) {
    case 'minimal':
      candidate = 'low'
      break
    case 'xhigh':
    case 'max':
      candidate = allowed?.includes('max') ? 'max' : 'high'
      break
    case 'low':
    case 'medium':
    case 'high':
      candidate = effort
      break
    default:
      candidate = 'medium'
  }
  const e = coerceEffortToAllowed(candidate, allowed, 'medium')
  if (e === 'low' || e === 'medium' || e === 'high' || e === 'max') return e
  if (e === 'minimal') return 'low'
  return 'high'
}

/**
 * DeepSeek chat models that use first-party `thinking: { type }` + `reasoning_effort`
 * (also expected on OpenAI-compat hosts serving those SKUs, e.g. DeepInfra).
 */
export function isDeepSeekNativeThinkingModel(id: string): boolean {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  return /deepseek-v4|deepseek-reasoner|deepseek-r1|deepseek-v3(\.\d+)?/i.test(core)
}

/**
 * Shared reasoner id families (OpenAI / Anthropic / Gemini / DeepSeek / xAI / local compat).
 * Used by custom + first-party providers; mistral keeps a narrower allowlist.
 */
export function sharedThinkingModelMatch(id: string): boolean {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  const family = ollamaModelFamily(id)
  // OpenAI-family (incl. o1 Responses)
  if (/^o1(-|$)|^o[34](-|$)|^gpt-5|^gpt-5\.|gpt-4\.1-mini.*high/i.test(core)) return true
  // Anthropic: covers claude-sonnet-* and legacy claude-3-7-sonnet-*
  if (/claude-.*(opus|sonnet|haiku|fable|mythos)/i.test(core)) return true
  // Gemini
  if (/gemini-(2\.5|3(\.\d+)?|3-pro|3\.5)/i.test(core)) return true
  // DeepSeek (v4 / reasoner / r1 / v3.x)
  if (isDeepSeekNativeThinkingModel(id)) return true
  // xAI
  if (/grok-[34]/i.test(core)) return true
  // Local / OpenAI-compat reasoners
  if (/gpt-oss|qwen3|qwq|magistral|kimi/i.test(core)) return true
  if (/(^|[^a-z])r1([^a-z]|$)|reason|think/i.test(core)) return true
  if (/^gpt-oss|^qwen3|^qwq|^magistral|^kimi/i.test(family)) return true
  if (/(r1|reason|think|qwq)/i.test(family)) return true
  // Mistral reasoning SKUs (also used by shared / openrouter paths)
  if (/^mistral-small|^magistral|mistral-medium-3/i.test(core)) return true
  return false
}

function mistralThinkingModelMatch(id: string): boolean {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  // Docs: reasoning_effort on mistral-small / mistral-medium-3.5; magistral (deprecated native).
  if (/^magistral/i.test(core)) return true
  if (/^mistral-small/i.test(core)) return true
  if (/mistral-medium-3/i.test(core)) return true
  return false
}

/** Heuristic: whether a model id likely supports extended thinking. */
export function modelSupportsThinking(id: string, providerId?: ProviderId): boolean {
  const lower = id.toLowerCase()
  switch (providerId) {
    case 'custom':
      // Prefer catalog `supportsThinking`; shared families only for known reasoners.
      return sharedThinkingModelMatch(id)
    case 'openrouter':
      return sharedThinkingModelMatch(id) || /thinking|reason/i.test(lower)
    case 'groq':
      return sharedThinkingModelMatch(id)
    case 'mistral':
      return mistralThinkingModelMatch(id)
    case 'ollama':
      // Shared families + documented Ollama think tags (v3.2+ covered by deepseek-v3(\.\d+)?).
      return sharedThinkingModelMatch(id)
    case 'openai':
    case 'anthropic':
    case 'gemini':
    case 'deepseek':
    case 'xai':
    case undefined:
      return sharedThinkingModelMatch(id)
    default: {
      const _exhaustive: never = providerId
      void _exhaustive
      return sharedThinkingModelMatch(id)
    }
  }
}

/** Map provider + model to the official thinking API surface. */
export function thinkingApiFor(
  id: string,
  providerId: ProviderId,
  opts?: { affirmed?: boolean }
): ThinkingApi | undefined {
  // When catalog already set supportsThinking, skip the second heuristic gate.
  if (!opts?.affirmed && !modelSupportsThinking(id, providerId)) return undefined
  switch (providerId) {
    case 'openai':
      return 'responses'
    case 'gemini':
      return 'interactions'
    case 'anthropic':
      return 'messages'
    case 'deepseek':
    case 'openrouter':
    case 'groq':
    case 'xai':
    case 'mistral':
    case 'ollama':
    case 'custom':
      return 'chat_completions'
    default: {
      const _exhaustive: never = providerId
      void _exhaustive
      return undefined
    }
  }
}

/**
 * Anthropic adaptive thinking + output_config.effort (4.6+, 5.x, Fable/Mythos).
 * Prefer ModelInfo.thinkingMode === 'adaptive' when catalog provides it.
 */
export function anthropicUsesAdaptiveThinking(modelId: string): boolean {
  const m = modelId.toLowerCase()
  if (/claude-(fable-5|mythos|opus-5|sonnet-5)/i.test(m)) return true
  // Opus/Sonnet 4.6, 4.7, 4.8 (hyphen or dotted)
  if (/claude-(opus|sonnet)-4[.-]([6-9]|\d{2,})/i.test(m)) return true
  if (/claude-(opus|sonnet)-4-[6-9]/i.test(m)) return true
  return false
}

/** Anthropic manual budget_tokens mode for older Claude models (pre-4.6). */
export function anthropicUsesManualThinking(modelId: string): boolean {
  if (!modelSupportsThinking(modelId, 'anthropic')) return false
  return !anthropicUsesAdaptiveThinking(modelId)
}

/** Clamp product effort to Anthropic output_config.effort (no minimal). */
export function normalizeEffortForAnthropic(effort?: ThinkingEffort): string {
  if (!effort || effort === 'minimal') return 'low'
  return effort
}

/** Map product effort → legacy Anthropic budget_tokens. */
export function anthropicBudgetTokensForEffort(effort?: ThinkingEffort): number {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 2_048
    case 'high':
      return 16_384
    case 'xhigh':
    case 'max':
      return 32_768
    case 'medium':
    default:
      return 8_192
  }
}

/** DeepSeek reasoning_effort: low | high | max (+ none via thinking disabled). */
export function normalizeEffortForDeepSeek(effort?: ThinkingEffort): string {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'xhigh':
    case 'max':
      return 'max'
    case 'medium':
    case 'high':
    default:
      return 'high'
  }
}

/** Pick effort allowed by catalog; fall back to preferred then medium. */
export function coerceEffortToAllowed(
  effort: ThinkingEffort | undefined,
  allowed: readonly ThinkingEffort[] | undefined,
  fallback: ThinkingEffort = 'medium'
): ThinkingEffort {
  const preferred = effort ?? fallback
  if (!allowed || allowed.length === 0) return preferred
  if (allowed.includes(preferred)) return preferred
  const order: ThinkingEffort[] = ['medium', 'high', 'low', 'minimal', 'xhigh', 'max']
  for (const e of order) {
    if (allowed.includes(e)) return e
  }
  return allowed[0]!
}

export function parseProviderReasoningState(value: unknown): ProviderReasoningState | undefined {
  const parsed = ProviderReasoningStateSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** OpenAI Responses API: supports none, minimal, low, medium, high, xhigh (not max). */
export function normalizeEffortForOpenAiResponses(
  effort?: ThinkingEffort,
  enabled = true
): string {
  if (!enabled) return 'none'
  if (!effort || effort === 'medium') return 'medium'
  if (effort === 'max') return 'xhigh'
  return effort
}

/** Gemini Interactions API: minimal, low, medium, high only. */
export function normalizeEffortForGeminiInteractions(effort?: ThinkingEffort): string {
  switch (effort) {
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
    default:
      return 'medium'
  }
}

/** Groq / xAI OpenAI-compat chat effort normalization. */
export function normalizeEffortForOpenAiCompatReasoning(
  effort: ThinkingEffort | undefined,
  providerId: 'groq' | 'xai'
): string {
  const e = effort ?? 'medium'
  if (providerId === 'xai') {
    if (e === 'minimal' || e === 'low') return 'low'
    if (e === 'xhigh' || e === 'max') return 'high'
    if (e === 'medium' || e === 'high') return e
    return 'medium'
  }
  // Groq
  if (e === 'minimal') return 'none'
  if (e === 'xhigh' || e === 'max') return 'high'
  if (e === 'low' || e === 'medium' || e === 'high') return e
  return 'default'
}

/**
 * Mistral chat `reasoning_effort`: none | minimal | low | medium | high | xhigh.
 * Product `max` maps to `xhigh`. Use `none` when thinking is disabled.
 */
export function normalizeEffortForMistral(effort?: ThinkingEffort): string {
  if (!effort || effort === 'medium') return 'medium'
  if (effort === 'max') return 'xhigh'
  return effort
}

/** Rough token estimate for opaque reasoning replay blobs. */
export function estimateReasoningStateTokens(state: unknown): number {
  if (state == null) return 0
  try {
    const json = JSON.stringify(state)
    return Math.ceil(json.length / 4)
  } catch {
    return 0
  }
}

/** Collect trailing tool results for provider continuation turns. */
export function trailingToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const trailing: ChatMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool') break
    trailing.unshift(m)
  }
  return trailing
}
