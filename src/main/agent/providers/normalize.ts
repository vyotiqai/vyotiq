import type { ModelInfo, ProviderId, ThinkingEffort } from '../../../shared/ipc'
import { ThinkingEffortSchema } from '../../../shared/ipc'
import {
  modelSupportsThinking,
  thinkingApiFor,
  anthropicUsesAdaptiveThinking,
  ollamaThinkingHeuristicFields
} from '../../../shared/reasoning'
import { inferSupportedServiceTiers } from '../../../shared/domain/serviceTier'

const NON_CHAT =
  /embed|embedding|tts|whisper|dall-e|dalle|imagen|veo|imagine|moderation|transcribe|realtime|audio|video|coding\.|computer-use/i

export function looksLikeChatModel(id: string): boolean {
  return !NON_CHAT.test(id)
}

export function idSuggestsVision(id: string): boolean {
  return /gpt-4o|gpt-5|vision|llava|llama3\.2-vision|llama3\.2:vision|claude|gemini|grok|pixtral|mistral-small|mistral-medium|mistral-large|bakllava|moondream/i.test(
    id
  )
}

/**
 * Modalities we can actually send on the wire for a provider.
 * Catalog APIs may advertise more; keep only what mappers implement.
 */
export function wireSupportedInputModalities(
  mods: readonly string[] | undefined,
  supportsVision: boolean,
  providerId?: ProviderId
): ModelInfo['inputModalities'] {
  const caps = wireCapsForProvider(providerId)
  const fromCatalog = (mods ?? []).filter(
    (m): m is 'text' | 'image' | 'audio' | 'file' =>
      m === 'text' || m === 'image' || m === 'audio' || m === 'file'
  )
  const kept: Array<'text' | 'image' | 'audio' | 'file'> = []
  if (fromCatalog.includes('text') || fromCatalog.length === 0) kept.push('text')
  if (supportsVision && caps.image) {
    if (fromCatalog.length === 0 || fromCatalog.includes('image')) kept.push('image')
  }
  if (caps.audio && fromCatalog.includes('audio')) kept.push('audio')
  if (caps.fileNative && (fromCatalog.includes('file') || providerAllowsNativeFileDefault(providerId))) {
    if (!kept.includes('file')) kept.push('file')
  }
  if (kept.length === 0) return supportsVision && caps.image ? ['text', 'image'] : ['text']
  return kept
}

function providerAllowsNativeFileDefault(providerId?: ProviderId): boolean {
  // Anthropic / Gemini / OpenAI Responses advertise file when wire path exists even if
  // the catalog list omitted it — still require explicit catalog audio.
  return providerId === 'anthropic' || providerId === 'gemini' || providerId === 'openai'
}

export function wireCapsForProvider(providerId?: ProviderId): {
  image: boolean
  audio: boolean
  fileNative: boolean
} {
  switch (providerId) {
    case 'anthropic':
      return { image: true, audio: false, fileNative: true }
    case 'gemini':
      return { image: true, audio: true, fileNative: true }
    case 'openai':
      // Chat Completions: audio when catalog lists it; native file via Responses path.
      return { image: true, audio: true, fileNative: true }
    case 'ollama':
    case 'mistral':
      return { image: true, audio: false, fileNative: false }
    default:
      return { image: true, audio: false, fileNative: false }
  }
}

/** Output is text-only in this app (no image generation path). */
export function wireSupportedOutputModalities(
  mods: readonly string[] | undefined
): ModelInfo['outputModalities'] {
  const kept = (mods ?? []).filter((m): m is 'text' => m === 'text')
  return kept.length > 0 ? kept : ['text']
}

export function inferStructuredOutputSupport(id: string, providerId?: ProviderId): boolean {
  if (providerId === 'ollama') {
    return /json|qwen2\.5|llama3|mistral|deepseek/i.test(id)
  }
  return looksLikeChatModel(id)
}

const PRODUCT_EFFORTS = new Set(ThinkingEffortSchema.options)

function parseEffortList(raw: unknown): ThinkingEffort[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ThinkingEffort[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    if (item === 'none') continue
    if (PRODUCT_EFFORTS.has(item as ThinkingEffort)) out.push(item as ThinkingEffort)
  }
  return out.length > 0 ? out : undefined
}

function supportedParamsList(row: Record<string, unknown>): string[] | undefined {
  const supported = row.supported_parameters
  if (Array.isArray(supported)) return supported.filter((p): p is string => typeof p === 'string')
  if (supported && typeof supported === 'object') return Object.keys(supported as Record<string, unknown>)
  return undefined
}

/**
 * Extract thinking capability fields from a provider catalog row.
 * Prefer OpenRouter-style `reasoning` object and `supported_parameters`.
 */
export function thinkingPartialFromCatalogRow(
  row: Record<string, unknown>,
  providerId?: ProviderId
): Partial<ModelInfo> {
  const partial: Partial<ModelInfo> = {}
  const reasoning = row.reasoning
  const params = supportedParamsList(row)

  if (reasoning === true) {
    partial.supportsThinking = true
  } else if (reasoning && typeof reasoning === 'object') {
    const r = reasoning as Record<string, unknown>
    partial.supportsThinking = true
    const efforts = parseEffortList(r.supported_efforts)
    if (efforts) partial.supportedThinkingEfforts = efforts
    if (r.mandatory === true) partial.thinkingCanDisable = false
    else if (r.mandatory === false) partial.thinkingCanDisable = true
    if (typeof r.default_effort === 'string' && r.default_effort !== 'none') {
      const d = ThinkingEffortSchema.safeParse(r.default_effort)
      if (d.success) partial.thinkingDefaultEffort = d.data
    }
    if (r.supports_max_tokens === true) partial.thinkingSupportsTokenBudget = true
    partial.thinkingMode = r.supports_max_tokens === true ? 'manual' : 'effort'
  } else if (
    params &&
    (params.includes('reasoning') ||
      params.includes('reasoning_effort') ||
      params.includes('include_reasoning') ||
      params.includes('thinking') ||
      params.includes('think'))
  ) {
    partial.supportsThinking = true
    partial.thinkingMode = params.includes('think') && !params.includes('reasoning_effort')
      ? 'boolean'
      : 'effort'
  }

  const caps = row.capabilities as Record<string, unknown> | undefined
  if (caps) {
    if (caps.thinking === true || caps.extended_thinking === true || caps.adaptive_thinking === true) {
      partial.supportsThinking = true
    }
    // Do not overwrite adaptive_thinking true with thinking/extended false.
    if (
      caps.adaptive_thinking !== true &&
      caps.thinking === false &&
      caps.extended_thinking === false
    ) {
      partial.supportsThinking = false
    }
  }

  if (providerId === 'anthropic' && partial.supportsThinking !== false) {
    // Generation-band fallback applied later in baseModelInfo via model id when still unset.
  }

  if (providerId === 'xai' && partial.supportsThinking) {
    // grok-4.5 cannot disable; if catalog didn't say, leave undefined for heuristic.
  }

  return partial
}

/** True when a catalog row advertises reasoning even without tools support. */
export function catalogRowHasReasoningSignal(row: Record<string, unknown>): boolean {
  const reasoning = row.reasoning
  if (reasoning === true) return true
  if (reasoning && typeof reasoning === 'object') return true
  const params = supportedParamsList(row)
  if (!params) return false
  return (
    params.includes('reasoning') ||
    params.includes('reasoning_effort') ||
    params.includes('include_reasoning') ||
    params.includes('thinking') ||
    params.includes('think')
  )
}

function providerThinkingDefaults(
  id: string,
  providerId: ProviderId | undefined,
  supportsThinking: boolean
): Pick<
  ModelInfo,
  | 'thinkingApi'
  | 'thinkingMode'
  | 'thinkingCanDisable'
  | 'supportedThinkingEfforts'
  | 'thinkingDefaultEffort'
> {
  if (!supportsThinking || !providerId) return {}
  // Catalog already affirmed thinking — do not re-gate via modelSupportsThinking.
  const thinkingApi = thinkingApiFor(id, providerId, { affirmed: true })
  let thinkingMode: ModelInfo['thinkingMode']
  let thinkingCanDisable: boolean | undefined
  let supportedThinkingEfforts: ThinkingEffort[] | undefined
  let thinkingDefaultEffort: ThinkingEffort | undefined

  switch (providerId) {
    case 'anthropic':
      thinkingMode = anthropicUsesAdaptiveThinking(id) ? 'adaptive' : 'manual'
      break
    case 'openai':
      thinkingMode = 'effort'
      thinkingCanDisable = true
      supportedThinkingEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh']
      break
    case 'gemini':
      thinkingMode = 'effort'
      supportedThinkingEfforts = ['minimal', 'low', 'medium', 'high']
      break
    case 'xai':
      thinkingMode = 'effort'
      thinkingCanDisable = /grok-4\.5/i.test(id) ? false : true
      supportedThinkingEfforts = ['low', 'medium', 'high']
      thinkingDefaultEffort = 'high'
      break
    case 'deepseek':
      thinkingMode = 'effort'
      supportedThinkingEfforts = ['low', 'high', 'max']
      thinkingDefaultEffort = 'high'
      break
    case 'ollama': {
      const ollama = ollamaThinkingHeuristicFields(id)
      thinkingMode = ollama.thinkingMode
      thinkingCanDisable = ollama.thinkingCanDisable
      supportedThinkingEfforts = ollama.supportedThinkingEfforts
      thinkingDefaultEffort = ollama.thinkingDefaultEffort
      break
    }
    case 'custom': {
      const custom = ollamaThinkingHeuristicFields(id)
      thinkingMode = custom.thinkingMode === 'boolean' ? 'effort' : custom.thinkingMode
      thinkingCanDisable = custom.thinkingCanDisable
      supportedThinkingEfforts = custom.supportedThinkingEfforts
      thinkingDefaultEffort = custom.thinkingDefaultEffort
      break
    }
    case 'groq':
      thinkingMode = 'effort'
      break
    case 'mistral':
      thinkingMode = 'effort'
      thinkingCanDisable = true
      supportedThinkingEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh']
      thinkingDefaultEffort = 'high'
      break
    default:
      thinkingMode = 'effort'
  }

  return {
    thinkingApi,
    thinkingMode,
    thinkingCanDisable,
    supportedThinkingEfforts,
    thinkingDefaultEffort
  }
}

export function baseModelInfo(
  id: string,
  partial?: Partial<ModelInfo>,
  providerId?: ProviderId
): ModelInfo {
  const supportsVision = partial?.supportsVision ?? idSuggestsVision(id)
  const supportsThinking = partial?.supportsThinking ?? modelSupportsThinking(id, providerId)
  const supportedServiceTiers =
    partial?.supportedServiceTiers ?? inferSupportedServiceTiers(id, providerId)
  const defaults = providerThinkingDefaults(id, providerId, supportsThinking)

  const thinkingApi = supportsThinking
    ? (partial?.thinkingApi ?? defaults.thinkingApi)
    : undefined

  return {
    id,
    displayName: partial?.displayName ?? id,
    contextWindow: partial?.contextWindow,
    maxOutputTokens: partial?.maxOutputTokens,
    inputModalities: wireSupportedInputModalities(
      partial?.inputModalities,
      supportsVision,
      providerId
    ),
    outputModalities: wireSupportedOutputModalities(partial?.outputModalities),
    supportsTools: partial?.supportsTools ?? looksLikeChatModel(id),
    supportsVision,
    supportsStructuredOutput:
      partial?.supportsStructuredOutput ?? inferStructuredOutputSupport(id, providerId),
    supportsThinking,
    thinkingApi,
    supportedThinkingEfforts:
      partial?.supportedThinkingEfforts ?? defaults.supportedThinkingEfforts,
    thinkingCanDisable: partial?.thinkingCanDisable ?? defaults.thinkingCanDisable,
    thinkingDefaultEffort: partial?.thinkingDefaultEffort ?? defaults.thinkingDefaultEffort,
    thinkingSupportsTokenBudget: partial?.thinkingSupportsTokenBudget,
    thinkingMode: partial?.thinkingMode ?? defaults.thinkingMode,
    supportedServiceTiers:
      supportedServiceTiers.length > 0 ? supportedServiceTiers : undefined
  }
}

export function normalizeOpenAiStyleModels(
  data: unknown,
  opts?: { requireToolsParam?: boolean; providerId?: ProviderId }
): ModelInfo[] {
  const root = data as { data?: unknown[] }
  const list = Array.isArray(root?.data) ? root.data : Array.isArray(data) ? data : []
  const out: ModelInfo[] = []
  const providerId = opts?.providerId

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : null
    if (!id || !looksLikeChatModel(id)) continue

    const supportedParams = supportedParamsList(row)
    if (opts?.requireToolsParam && supportedParams && !supportedParams.includes('tools')) {
      // Keep reasoners that omit tools so Think UI can still list them.
      if (!catalogRowHasReasoningSignal(row)) continue
    }

    const arch = row.architecture as Record<string, unknown> | undefined
    const inputMods = Array.isArray(arch?.input_modalities)
      ? (arch.input_modalities as string[])
      : Array.isArray(row.input_modalities)
        ? (row.input_modalities as string[])
        : undefined
    const outputMods = Array.isArray(arch?.output_modalities)
      ? (arch.output_modalities as string[])
      : Array.isArray(row.output_modalities)
        ? (row.output_modalities as string[])
        : undefined

    const supportsVision = inputMods
      ? inputMods.includes('image')
      : idSuggestsVision(id)
    const supportsTools = supportedParams
      ? supportedParams.includes('tools')
      : looksLikeChatModel(id)

    const contextWindow =
      typeof row.context_length === 'number'
        ? row.context_length
        : typeof row.context_window === 'number'
          ? row.context_window
          : undefined

    const serviceTiers = inferSupportedServiceTiers(id, providerId, supportedParams)
    const thinkingPartial = thinkingPartialFromCatalogRow(row, providerId)

    out.push(
      baseModelInfo(
        id,
        {
          displayName: typeof row.name === 'string' ? row.name : id,
          contextWindow,
          maxOutputTokens:
            typeof row.max_output_tokens === 'number' ? row.max_output_tokens : undefined,
          inputModalities: wireSupportedInputModalities(inputMods, supportsVision, providerId),
          outputModalities: wireSupportedOutputModalities(outputMods),
          supportsTools,
          supportsVision,
          supportedServiceTiers: serviceTiers.length > 0 ? serviceTiers : undefined,
          ...thinkingPartial
        },
        providerId
      )
    )
  }

  return out
}

export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(url)
  if (!m) return null
  return { mediaType: m[1], data: m[2] }
}
