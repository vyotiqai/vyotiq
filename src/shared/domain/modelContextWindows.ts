import type { ModelInfo, ProviderId } from '../ipc/schemas/providers'
import { ollamaIdWithoutCloudSuffix, ollamaModelFamily } from './reasoning'

/**
 * Provider `/models` endpoints often omit `context_length` (notably DeepSeek).
 * Use these known windows so budgeting does not silently fall back to 128k.
 *
 * Prefer exact ids; patterns cover versioned / OpenRouter-prefixed variants.
 */
const EXACT_CONTEXT_WINDOWS: Record<string, number> = {
  // DeepSeek V4 (+ legacy aliases that route to V4-Flash)
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
  'deepseek-v3': 128_000,
  // OpenAI GPT-5.6 family (1.05M class)
  'gpt-5.6': 1_048_576,
  'gpt-5.6-sol': 1_048_576,
  'gpt-5.6-terra': 1_048_576,
  'gpt-5.6-luna': 1_048_576,
  // Older OpenAI ids still referenced in favorites / tests
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_048_576,
  'gpt-4.1-mini': 1_048_576,
  'o3-mini': 200_000,
  // Anthropic
  'claude-opus-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
  // Gemini
  'gemini-3.6-flash': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-pro-preview': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  // Groq / xAI / Mistral seeds
  'llama-4-scout-17b-16e-instruct': 128_000,
  'llama-3.3-70b-versatile': 128_000,
  'grok-4-latest': 1_000_000,
  'grok-2-latest': 131_072,
  'mistral-large-latest': 128_000,
  'openrouter/auto': 128_000
}

/**
 * Ollama Cloud maxima after stripping `:cloud` / `-cloud`.
 * Live `/api/show` still wins via resolveModelContextWindow.
 * Seeded from Ollama `cmd/launch/models.go` plus current Cloud ids.
 */
const OLLAMA_CLOUD_CONTEXT_EXACT: Record<string, number> = {
  'gpt-oss:120b': 131_072,
  'gpt-oss:20b': 131_072,
  'glm-5.1': 202_752,
  'glm-4.6': 202_752,
  'glm-4.7': 202_752,
  'glm-5': 202_752,
  'glm-5.2': 976_000,
  'gemma4:31b': 262_144,
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  'kimi-k2:1t': 262_144,
  'kimi-k2-thinking': 262_144,
  'qwen3.5': 262_144,
  'qwen3-coder:480b': 262_144,
  'qwen3-coder-next': 262_144,
  'qwen3-next:80b': 262_144,
  'minimax-m2.7': 204_800,
  'minimax-m3': 512_000,
  'cogito-2.1:671b': 163_840,
  'deepseek-v3.1:671b': 163_840,
  'deepseek-v3.2': 163_840,
  'nemotron-3-nano:30b': 1_048_576
}

const OLLAMA_CLOUD_CONTEXT_FAMILY: Record<string, number> = {
  'gpt-oss': 131_072,
  'glm-5.1': 202_752,
  'glm-5.2': 976_000,
  gemma4: 262_144,
  'kimi-k2.6': 262_144,
  'qwen3.5': 262_144,
  'minimax-m3': 512_000,
  'kimi-k3': 1_048_576,
  'nemotron-3-nano': 1_048_576
}

function knownOllamaCloudContextWindow(modelId: string): number | undefined {
  const stripped = ollamaIdWithoutCloudSuffix(modelId).toLowerCase()
  const exact = OLLAMA_CLOUD_CONTEXT_EXACT[stripped]
  if (exact != null) return exact
  const family = ollamaModelFamily(stripped)
  const familyWin = OLLAMA_CLOUD_CONTEXT_FAMILY[family]
  if (familyWin != null) return familyWin
  if (/^deepseek-v4/i.test(stripped) || /^deepseek-v4/i.test(family)) return 1_048_576
  return undefined
}

/** Strip `vendor/` prefixes used by OpenRouter-style ids. */
export function coreModelId(modelId: string): string {
  const trimmed = modelId.trim()
  const slash = trimmed.lastIndexOf('/')
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase()
}

export function knownContextWindow(
  modelId: string,
  providerId?: ProviderId
): number | undefined {
  const core = coreModelId(modelId)
  const ollamaCloud =
    providerId === 'ollama' || /[:-]cloud$/i.test(core)
      ? knownOllamaCloudContextWindow(core)
      : undefined
  if (ollamaCloud != null) return ollamaCloud

  const exact = EXACT_CONTEXT_WINDOWS[core]
  if (exact != null) return exact

  if (/^deepseek-v4/i.test(core)) return 1_000_000
  if (providerId === 'deepseek' && /^deepseek/i.test(core)) return 1_000_000

  if (/^gpt-5\.6/i.test(core)) return 1_048_576
  if (/^gpt-5(\.|$|-)/i.test(core)) return 1_048_576
  if (/^gpt-4\.1/i.test(core)) return 1_048_576
  if (/^gpt-4o/i.test(core)) return 128_000
  if (/^o3/i.test(core)) return 200_000
  if (/^claude-(opus|sonnet|haiku|fable|mythos)/i.test(core)) return 200_000
  if (/^gemini-3/i.test(core)) return 1_048_576
  if (/^gemini-2\.5/i.test(core)) return 1_048_576
  if (/^gemini-2\.0/i.test(core)) return 1_048_576
  if (/^grok-4/i.test(core)) return 1_000_000
  if (/^grok/i.test(core)) return 131_072
  if (/^llama-4/i.test(core)) return 128_000

  return undefined
}

/**
 * Resolve the effective context window: live catalog/API value wins when valid;
 * known table backfills when omitted or when a gateway invents generic 128k for a
 * model we know is larger.
 */
export function resolveModelContextWindow(
  model: Pick<ModelInfo, 'id' | 'contextWindow'>,
  providerId?: ProviderId
): number | undefined {
  const known = knownContextWindow(model.id, providerId)
  const reported = model.contextWindow
  if (reported != null && reported > 0) {
    if (reported === 128_000 && known != null && known > 128_000) return known
    return reported
  }
  return known
}

/** Fill missing/invalid contextWindow from the known table; leave real API values intact. */
export function withResolvedContextWindow(
  model: ModelInfo,
  providerId?: ProviderId
): ModelInfo {
  const resolved = resolveModelContextWindow(model, providerId)
  if (resolved == null || resolved === model.contextWindow) return model
  return { ...model, contextWindow: resolved }
}
