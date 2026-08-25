import type { ModelInfo } from '../ipc/schemas/providers'

/**
 * OpenCode Go (`opencode`) model metadata.
 *
 * Endpoints per model follow https://opencode.ai/docs/go/ (Endpoints table):
 * `/responses` for OpenAI Responses models, `/messages` for Anthropic Messages
 * models, and `/chat/completions` for everything else. Ids the docs do not list
 * inherit the endpoint of their documented family (qwen* → messages).
 *
 * Context/output limits and input modalities mirror the models.dev registry
 * entry `opencode-go` (https://models.dev/api.json), which publishes
 * `limit.context`, `limit.output`, and modalities for this provider. The live
 * Go `/v1/models` catalog returns bare ids only, so this table backfills what
 * the wire omits.
 */

export type OpenCodeTransport = 'responses' | 'messages' | 'chat'

const RESPONSES_MODELS = new Set(['grok-4.5', 'gpt-5.6-luna', 'muse-spark-1.2-contributor'])

const MESSAGES_MODELS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  // Undocumented in the endpoints table but served alongside the qwen-plus family.
  'qwen3.5-plus'
])

/** Strip an `opencode-go/` config-style prefix; lowercase for lookups. */
export function normalizeOpenCodeGoModelId(id: string): string {
  return id.replace(/^opencode-go\//i, '').trim().toLowerCase()
}

export function opencodeGoTransportFor(modelId: string): OpenCodeTransport {
  const core = normalizeOpenCodeGoModelId(modelId)
  if (RESPONSES_MODELS.has(core)) return 'responses'
  if (MESSAGES_MODELS.has(core)) return 'messages'
  if (/^minimax-/.test(core) || /^qwen/.test(core)) return 'messages'
  return 'chat'
}

type OpenCodeModelMeta = {
  contextWindow: number
  maxOutputTokens: number
  /** Wire-sendable input modalities (video is not representable on our schema). */
  inputModalities: ModelInfo['inputModalities']
}

/**
 * Values transcribed from models.dev `opencode-go` (Aug 2026). Pdf → file;
 * video entries are trimmed because the app cannot send video parts.
 */
const OPENCODE_GO_MODEL_META: Record<string, OpenCodeModelMeta> = {
  // Responses API
  'grok-4.5': { contextWindow: 500_000, maxOutputTokens: 500_000, inputModalities: ['text', 'image'] },
  'gpt-5.6-luna': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputModalities: ['text', 'image', 'file']
  },
  'muse-spark-1.2-contributor': {
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image', 'audio', 'file']
  },
  // Anthropic Messages API
  'minimax-m3': { contextWindow: 1_000_000, maxOutputTokens: 131_072, inputModalities: ['text', 'image'] },
  'minimax-m2.7': { contextWindow: 204_800, maxOutputTokens: 131_072, inputModalities: ['text'] },
  'minimax-m2.5': { contextWindow: 204_800, maxOutputTokens: 65_536, inputModalities: ['text'] },
  'qwen3.8-max': { contextWindow: 1_000_000, maxOutputTokens: 131_072, inputModalities: ['text', 'image'] },
  'qwen3.7-max': { contextWindow: 1_000_000, maxOutputTokens: 65_536, inputModalities: ['text'] },
  'qwen3.7-plus': { contextWindow: 1_000_000, maxOutputTokens: 65_536, inputModalities: ['text', 'image'] },
  'qwen3.6-plus': { contextWindow: 1_000_000, maxOutputTokens: 65_536, inputModalities: ['text', 'image'] },
  'qwen3.5-plus': { contextWindow: 262_144, maxOutputTokens: 65_536, inputModalities: ['text', 'image'] },
  // Chat Completions
  'kimi-k3': { contextWindow: 1_048_576, maxOutputTokens: 131_072, inputModalities: ['text', 'image'] },
  'kimi-k2.7-code': {
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    inputModalities: ['text', 'image']
  },
  'kimi-k2.6': { contextWindow: 262_144, maxOutputTokens: 65_536, inputModalities: ['text', 'image'] },
  'kimi-k2.5': { contextWindow: 262_144, maxOutputTokens: 65_536, inputModalities: ['text', 'image'] },
  'glm-5.3': { contextWindow: 1_000_000, maxOutputTokens: 131_072, inputModalities: ['text'] },
  'glm-5.2': { contextWindow: 1_000_000, maxOutputTokens: 131_072, inputModalities: ['text'] },
  'glm-5.1': { contextWindow: 202_752, maxOutputTokens: 32_768, inputModalities: ['text'] },
  'glm-5': { contextWindow: 204_800, maxOutputTokens: 32_768, inputModalities: ['text'] },
  'longcat-2.0': { contextWindow: 1_000_000, maxOutputTokens: 131_072, inputModalities: ['text'] },
  'deepseek-v4-pro': {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: ['text']
  },
  'deepseek-v4-flash': {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: ['text']
  },
  'deepseek-v4-flash-vision-exp': {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    inputModalities: ['text', 'image']
  },
  'mimo-v2.5': {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: ['text', 'image', 'audio']
  },
  'mimo-v2.5-pro': { contextWindow: 1_048_576, maxOutputTokens: 128_000, inputModalities: ['text'] },
  'mimo-v2-pro': { contextWindow: 1_048_576, maxOutputTokens: 128_000, inputModalities: ['text'] },
  'mimo-v2-omni': {
    contextWindow: 262_144,
    maxOutputTokens: 128_000,
    inputModalities: ['text', 'image', 'audio', 'file']
  },
  hy3: { contextWindow: 256_000, maxOutputTokens: 64_000, inputModalities: ['text'] },
  'ox-alpha-free': {
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image']
  }
}

export function lookupOpenCodeGoModelMeta(modelId: string): OpenCodeModelMeta | undefined {
  return OPENCODE_GO_MODEL_META[normalizeOpenCodeGoModelId(modelId)]
}

/** Thinking effort ladder allowed by each transport's request normalizer. */
export function opencodeGoEffortsFor(
  transport: OpenCodeTransport
): NonNullable<ModelInfo['supportedThinkingEfforts']> {
  switch (transport) {
    case 'responses':
      // normalizeEffortForOpenAiResponses: none | minimal | low | medium | high | xhigh.
      return ['minimal', 'low', 'medium', 'high', 'xhigh']
    case 'messages':
      // normalizeEffortForAnthropic: minimal maps to low; low..max pass through.
      return ['low', 'medium', 'high', 'xhigh', 'max']
    case 'chat':
      // OpenAI-compat reasoning_effort (xai-style mapping used by the opencode branch).
      return ['low', 'medium', 'high']
  }
}

/** Merge registry metadata into a catalog/seed row when fields are missing. */
export function withOpenCodeGoMeta<T extends Partial<ModelInfo>>(model: T): T {
  const meta = lookupOpenCodeGoModelMeta(model.id ?? '')
  if (!meta) return model
  return {
    ...model,
    contextWindow: model.contextWindow ?? meta.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? meta.maxOutputTokens,
    // Registry modalities are authoritative; neither seeds nor Go catalog rows
    // carry real modality data (the wire returns bare ids only).
    inputModalities: [...meta.inputModalities]
  }
}
