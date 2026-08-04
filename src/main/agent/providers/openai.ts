import type { ChatMessage, ContentPart, MessageContent, ModelInfo, ProviderId } from '../../../shared/ipc'
import { contentToText, providerContentParts } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { isOllamaCloudHost, ollamaNativeHost } from '../../../shared/providers'
import {
  parseProviderReasoningState,
  normalizeEffortForOpenAiCompatReasoning,
  normalizeEffortForDeepSeek,
  normalizeEffortForMistral,
  coerceEffortToAllowed,
  normalizeEffortForOllamaThink,
  normalizeModelIdForHeuristics,
  isDeepSeekNativeThinkingModel,
  type OpenAiCompatThinkChunk
} from '../../../shared/reasoning'
import { serviceTierForApiBody } from '../../../shared/domain/serviceTier'
import {
  baseModelInfo,
  looksLikeChatModel,
  normalizeOpenAiStyleModels,
  parseDataUrl,
  thinkingPartialFromCatalogRow,
  wireSupportedInputModalities,
  wireSupportedOutputModalities
} from './normalize'
import type {
  LlmProvider,
  ListModelsRequest,
  ProviderChatRequest,
  StopReason,
  StreamChunk,
  ToolCall,
  TokenUsage
} from './types'
import { streamOpenAiResponses } from './openaiResponses'
import { normalizeStopReason } from './stopReason'
import { iterateSseJson } from './sse'
import { logProviderFailure } from './log'
import { fetchWithRetry } from './fetchWithRetry'
import { assertAllowedUrl, fetchWithValidatedRedirects } from '@main/agent/tools/webFetch'
import {
  formatProviderHttpError,
  parseOpenRouterAffordableOutputTokens,
  scrubProviderErrorSnippet,
  shouldRetryOmitIncludeUsage,
  shouldRetryOpenRouterCompatBody
} from './httpErrors'
import {
  resolveSystemZones,
  volatileSessionMessage,
  supportsExplicitPromptCache,
  markOpenAiChatCacheBreakpoint,
  attachTrailingHistoryCacheBreakpoint
} from './systemZones'

/** Re-export for callers/tests that imported from openai. */
export { supportsExplicitPromptCache } from './systemZones'

export function openAiCompatMessageReasoningDelta(
  messageReasoning: string,
  accumulated: string
): string | null {
  if (!messageReasoning || messageReasoning.length <= accumulated.length) return null
  if (messageReasoning.startsWith(accumulated) && accumulated.length > 0) {
    return messageReasoning.slice(accumulated.length) || null
  }
  return accumulated ? messageReasoning : messageReasoning
}

export type OpenAiCompatDeltaContentParts = {
  text: string | null
  reasoning: string | null
  /** Structured ThinkChunks from this content payload (one per `type: "thinking"` row). */
  thinkChunks: OpenAiCompatThinkChunk[] | null
}

function cloneOpenAiCompatThinkInner(
  part: Record<string, unknown>
): Record<string, unknown> {
  return { ...part }
}

function cloneOpenAiCompatThinkChunk(chunk: OpenAiCompatThinkChunk): OpenAiCompatThinkChunk {
  return {
    ...chunk,
    thinking: chunk.thinking?.map(cloneOpenAiCompatThinkInner)
  }
}

/** Flatten + preserve structured inner thinking parts from a ThinkChunk.thinking field. */
function parseOpenAiCompatThinkingInners(thinking: unknown): {
  text: string
  parts: Record<string, unknown>[] | undefined
} {
  if (typeof thinking === 'string') {
    return { text: thinking, parts: undefined }
  }
  if (!Array.isArray(thinking)) return { text: '', parts: undefined }
  const parts: Record<string, unknown>[] = []
  let text = ''
  for (const inner of thinking) {
    if (typeof inner === 'string') {
      text += inner
      parts.push({ type: 'text', text: inner })
      continue
    }
    if (!inner || typeof inner !== 'object') continue
    const part = cloneOpenAiCompatThinkInner(inner as Record<string, unknown>)
    parts.push(part)
    if (typeof part.text === 'string' && (part.type === 'text' || part.type == null)) {
      text += part.text
    }
  }
  return { text, parts: parts.length ? parts : undefined }
}

/**
 * Merge streamed ThinkChunk deltas into accumulated chunks.
 * Continues the last open chunk across frames; within one delta, only the first
 * incoming row may continue — further thinking rows stay distinct chunks.
 */
export function absorbOpenAiCompatThinkChunks(
  existing: OpenAiCompatThinkChunk[],
  incoming: OpenAiCompatThinkChunk[]
): OpenAiCompatThinkChunk[] {
  const out = existing.map(cloneOpenAiCompatThinkChunk)
  if (incoming.length === 0) return out

  const mergeIntoLast = (chunk: OpenAiCompatThinkChunk) => {
    const last = out[out.length - 1]!
    last.text += chunk.text
    if (chunk.thinking?.length) {
      last.thinking = [
        ...(last.thinking ?? []),
        ...chunk.thinking.map(cloneOpenAiCompatThinkInner)
      ]
    } else if (chunk.text && last.thinking?.length) {
      // Continuation arrived as flat text while prior retained structured inners.
      last.thinking = [...last.thinking, { type: 'text', text: chunk.text }]
    }
    if (chunk.signature !== undefined) last.signature = chunk.signature
    if (chunk.closed !== undefined) last.closed = chunk.closed
  }

  let start = 0
  const last = out[out.length - 1]
  if (last && last.closed !== true) {
    mergeIntoLast(incoming[0]!)
    start = 1
  }
  for (let i = start; i < incoming.length; i++) {
    out.push(cloneOpenAiCompatThinkChunk(incoming[i]!))
  }
  return out
}

/** Mark any still-open ThinkChunks closed once the turn finishes. */
export function finalizeOpenAiCompatThinkChunks(
  chunks: OpenAiCompatThinkChunk[]
): OpenAiCompatThinkChunk[] {
  if (chunks.length === 0) return chunks
  return chunks.map((c) => {
    const copy = cloneOpenAiCompatThinkChunk(c)
    if (copy.closed !== true) copy.closed = true
    return copy
  })
}

/**
 * Mistral reasoning streams `delta.content` as ThinkChunk / TextChunk arrays
 * (`type: "thinking"` / `type: "text"`), then switches to plain strings for the answer.
 * Also accepts string content (OpenAI-compat default).
 */
export function parseOpenAiCompatDeltaContent(content: unknown): OpenAiCompatDeltaContentParts {
  if (typeof content === 'string') {
    return { text: content || null, reasoning: null, thinkChunks: null }
  }
  if (!Array.isArray(content)) {
    return { text: null, reasoning: null, thinkChunks: null }
  }

  let text = ''
  let reasoning = ''
  const thinkChunks: OpenAiCompatThinkChunk[] = []
  for (const chunk of content) {
    if (!chunk || typeof chunk !== 'object') continue
    const row = chunk as Record<string, unknown>
    if (row.type === 'thinking') {
      const { text: chunkText, parts } = parseOpenAiCompatThinkingInners(row.thinking)
      reasoning += chunkText
      const stored: OpenAiCompatThinkChunk = { text: chunkText }
      if (parts) stored.thinking = parts
      if (typeof row.signature === 'string') stored.signature = row.signature
      if (typeof row.closed === 'boolean') stored.closed = row.closed
      thinkChunks.push(stored)
    } else if (row.type === 'text' && typeof row.text === 'string') {
      text += row.text
    } else if (typeof row.text === 'string' && row.type == null) {
      text += row.text
    }
  }
  return {
    text: text || null,
    reasoning: reasoning || null,
    thinkChunks: thinkChunks.length ? thinkChunks : null
  }
}

export type OpenAiCompatOptions = {
  defaultBaseUrl: string
  extraHeaders?: Record<string, string>
  /** Relative to base, default `/models`. */
  listPath?: string
  /** Prefer language-models endpoint (xAI). */
  listLanguageModels?: boolean
  /** Ollama: only allow base64 data URLs for images. */
  ollamaVision?: boolean
  /** OpenRouter: filter models that advertise tools. */
  requireToolsParam?: boolean
  /** Request usage on final SSE chunk (OpenAI-compatible). */
  includeUsage?: boolean
  /** OpenAI: route related requests for better prompt-cache hit rate. */
  enablePromptCache?: boolean
  /** DeepSeek: enable thinking mode via extra_body fields. */
  deepseekThinking?: boolean
  /** OpenRouter: unified reasoning parameter. */
  openRouterReasoning?: boolean
  /** Allow chat/catalog without an API key (local custom gateways). */
  optionalApiKey?: boolean
  /** Allow loopback / private hosts (SSRF allowlist). */
  allowLocal?: boolean
}

/** Exported for tests — gate OpenAI `stream_options.include_usage` per provider. */
export function compatStreamOptions(
  opts: OpenAiCompatOptions
): { stream_options: { include_usage: true } } | Record<string, never> {
  if (opts.includeUsage === false || opts.ollamaVision) return {}
  return { stream_options: { include_usage: true } }
}

// eslint-disable-next-line no-control-regex
const URL_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/
const URL_HOST_CHARS = /^[\da-zA-Z\-_.:]+$/

/**
 * Synchronous structural check for provider base URLs: scheme, host,
 * credentials, fragments, query strings, and non-ASCII control characters.
 * Rejects values that should never reach a cache key or HTTP request.
 */
export function assertValidProviderBaseUrl(raw: string | undefined): URL {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Provider base URL is empty')
  }
  if (URL_CONTROL_CHARS.test(raw)) {
    throw new Error('Provider base URL contains control characters')
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid provider base URL: ${raw}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Provider base URL must use http(s): ${raw}`)
  }
  if (url.username || url.password) {
    throw new Error(`Provider base URL must not contain credentials: ${raw}`)
  }
  if (url.hash) {
    throw new Error(`Provider base URL must not contain a fragment: ${raw}`)
  }
  if (url.search) {
    throw new Error(`Provider base URL must not contain a query string: ${raw}`)
  }

  const host = url.hostname
  if (!host) {
    throw new Error(`Provider base URL is missing a host: ${raw}`)
  }
  if (!URL_HOST_CHARS.test(host)) {
    throw new Error(`Provider base URL host contains invalid characters: ${host}`)
  }

  return url
}

/** Full base URL validation: structural checks plus DNS/SSRF via assertAllowedUrl. */
export async function validateProviderBaseUrl(raw: string, allowLocal = false): Promise<URL> {
  assertValidProviderBaseUrl(raw)
  return assertAllowedUrl(raw, allowLocal)
}

function toOpenAiContent(
  content: MessageContent,
  opts: { ollamaVision?: boolean }
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  const parts: Array<Record<string, unknown>> = []
  for (const p of providerContentParts(content, {
    image: true,
    audio: !opts.ollamaVision,
    fileNative: false
  })) {
    if (p.type === 'text') {
      parts.push({ type: 'text', text: p.text })
      continue
    }
    if (p.type === 'audio') {
      const data = parseDataUrl(p.url)
      if (!data) {
        parts.push({
          type: 'text',
          text: '[audio omitted: OpenAI requires a base64 data URL]'
        })
        continue
      }
      const format = data.mediaType.includes('wav')
        ? 'wav'
        : data.mediaType.includes('mpeg') || data.mediaType.includes('mp3')
          ? 'mp3'
          : 'wav'
      parts.push({
        type: 'input_audio',
        input_audio: { data: data.data, format }
      })
      continue
    }
    if (p.type === 'file_native') {
      parts.push({
        type: 'text',
        text: `[file omitted: use a Responses-capable model for native file "${p.name}"]`
      })
      continue
    }
    if (opts.ollamaVision && !p.url.startsWith('data:')) {
      parts.push({
        type: 'text',
        text: '[image omitted: Ollama requires a base64 data URL]'
      })
      continue
    }
    parts.push({ type: 'image_url', image_url: { url: p.url } })
  }
  return parts.length === 1 && parts[0].type === 'text'
    ? String(parts[0].text)
    : parts
}

export type OpenAiCompatReasoningReplayFormat = 'reasoning_content' | 'think_chunks'

function openAiCompatReasoningFromMessage(
  message: ChatMessage,
  opts: { stripReasoningReplay?: boolean }
): {
  reasoningContent?: string
  reasoningDetails?: unknown
  reasoningFormat?: OpenAiCompatReasoningReplayFormat
  thinkChunks?: OpenAiCompatThinkChunk[]
} {
  if (opts.stripReasoningReplay) return {}
  const state = parseProviderReasoningState(message.reasoningState)
  if (state?.kind !== 'openai_compat') return {}
  return {
    reasoningContent: state.reasoningContent,
    // Encrypted reasoning_details must not be replayed via OpenRouter — upstream
    // providers reject unverifiable rs_* blocks with HTTP 400 "Provider returned error".
    reasoningDetails: undefined,
    reasoningFormat: state.reasoningFormat,
    thinkChunks: state.thinkChunks
  }
}

/**
 * Mistral (and ThinkChunk-emitting custom hosts) expect reasoning inside
 * `content` as `{ type: "thinking", thinking: TextChunk[] }`, not a string
 * `reasoning_content` field. Prefer stored structured chunks when present;
 * fall back to one closed ThinkChunk from flattened reasoning text.
 * When a stored chunk has `thinking` inners, replay them verbatim.
 */
export function toOpenAiCompatThinkChunkContent(
  answerText: string | null,
  reasoning: string,
  thinkChunks?: readonly OpenAiCompatThinkChunk[]
): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = []
  if (thinkChunks && thinkChunks.length > 0) {
    for (const c of thinkChunks) {
      const thinkingInners =
        c.thinking && c.thinking.length > 0
          ? c.thinking.map(cloneOpenAiCompatThinkInner)
          : [{ type: 'text', text: c.text }]
      const part: Record<string, unknown> = {
        type: 'thinking',
        thinking: thinkingInners,
        closed: c.closed ?? true
      }
      if (c.signature != null && c.signature !== '') {
        part.signature = c.signature
      }
      chunks.push(part)
    }
  } else {
    chunks.push({
      type: 'thinking',
      thinking: [{ type: 'text', text: reasoning }],
      closed: true
    })
  }
  if (answerText) {
    chunks.push({ type: 'text', text: answerText })
  }
  return chunks
}

function resolveReasoningReplayFormat(
  opts: {
    stripReasoningReplay?: boolean
    reasoningReplayFormat?: OpenAiCompatReasoningReplayFormat
  },
  stateFormat: OpenAiCompatReasoningReplayFormat | undefined
): OpenAiCompatReasoningReplayFormat | 'omit' {
  if (opts.stripReasoningReplay) return 'omit'
  // Prefer provider default (Mistral → think_chunks); fall back to what the
  // model actually emitted so custom hosts that stream ThinkChunks replay safely.
  return opts.reasoningReplayFormat ?? stateFormat ?? 'reasoning_content'
}

function assistantAnswerText(
  message: ChatMessage,
  forToolCalls: boolean
): string | null {
  if (typeof message.content === 'string') {
    return forToolCalls ? message.content || null : message.content
  }
  const text = contentToText(message.content)
  return forToolCalls ? text || null : text
}

function assistantMessageWireFields(
  message: ChatMessage,
  opts: {
    stripReasoningReplay?: boolean
    reasoningReplayFormat?: OpenAiCompatReasoningReplayFormat
  },
  forToolCalls: boolean
): { content: unknown; reasoning_content?: string } {
  const answer = assistantAnswerText(message, forToolCalls)
  const { reasoningContent, reasoningFormat, thinkChunks } = openAiCompatReasoningFromMessage(
    message,
    opts
  )
  const format = resolveReasoningReplayFormat(opts, reasoningFormat)
  const hasReasoning =
    Boolean(reasoningContent) || (Array.isArray(thinkChunks) && thinkChunks.length > 0)
  if (format === 'omit' || !hasReasoning) {
    return { content: answer }
  }
  if (format === 'think_chunks') {
    return {
      content: toOpenAiCompatThinkChunkContent(answer, reasoningContent ?? '', thinkChunks)
    }
  }
  return { content: answer, reasoning_content: reasoningContent }
}

/** Exported for tests — map chat messages + system zones to OpenAI-compat wire shape. */
export function toOpenAiMessages(
  messages: ChatMessage[],
  system: string | undefined,
  opts: {
    ollamaVision?: boolean
    stripReasoningReplay?: boolean
    /**
     * Default replay shape when state has no `reasoningFormat`.
     * Mistral always uses ThinkChunks; other providers keep `reasoning_content`.
     */
    reasoningReplayFormat?: OpenAiCompatReasoningReplayFormat
    /** Prefer stable leading system + trailing volatile over a combined `system` string. */
    systemStable?: string
    systemVolatile?: string
    /** GPT-5.6+: mark the end of the stable system prefix for explicit cache mode. */
    explicitPromptCache?: boolean
  } = {}
) {
  const zones = resolveSystemZones({
    system,
    systemStable: opts.systemStable,
    systemVolatile: opts.systemVolatile
  })
  const out: Array<Record<string, unknown>> = []
  if (zones.stable) {
    if (opts.explicitPromptCache) {
      out.push({
        role: 'system',
        content: [
          {
            type: 'text',
            text: zones.stable,
            prompt_cache_breakpoint: { mode: 'explicit' }
          }
        ]
      })
    } else {
      out.push({ role: 'system', content: zones.stable })
    }
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!m.toolCallId) continue
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : contentToText(m.content)
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const wire = assistantMessageWireFields(m, opts, true)
      out.push({
        role: 'assistant',
        content: wire.content,
        ...(wire.reasoning_content ? { reasoning_content: wire.reasoning_content } : {}),
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments }
        }))
      })
    } else if (m.role === 'assistant') {
      const wire = assistantMessageWireFields(m, opts, false)
      out.push({
        role: 'assistant',
        content: wire.content,
        ...(wire.reasoning_content ? { reasoning_content: wire.reasoning_content } : {})
      })
    } else if (m.role === 'system') {
      // Rare in-loop system rows stay in history order (not re-merged into the prefix).
      out.push({
        role: 'system',
        content: typeof m.content === 'string' ? m.content : contentToText(m.content)
      })
    } else {
      out.push({
        role: m.role,
        content: toOpenAiContent(m.content, opts)
      })
    }
  }
  if (opts.explicitPromptCache) {
    // Second breakpoint: longest reusable prefix = stable system + history (before volatile).
    attachTrailingHistoryCacheBreakpoint(out, markOpenAiChatCacheBreakpoint)
  }
  if (zones.volatile) {
    out.push(volatileSessionMessage(zones.volatile))
  }
  return out
}

/** Exported for tests — parse OpenAI-compat usage including provider cache metrics. */
export function parseOpenAiCompatUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const input =
    typeof u.prompt_tokens === 'number'
      ? u.prompt_tokens
      : typeof u.input_tokens === 'number'
        ? u.input_tokens
        : undefined
  const output =
    typeof u.completion_tokens === 'number'
      ? u.completion_tokens
      : typeof u.output_tokens === 'number'
        ? u.output_tokens
        : undefined
  const total =
    typeof u.total_tokens === 'number'
      ? u.total_tokens
      : input !== undefined && output !== undefined
        ? input + output
        : undefined

  let cachedInput: number | undefined
  if (typeof u.prompt_cache_hit_tokens === 'number') {
    cachedInput = u.prompt_cache_hit_tokens
  }
  const details = u.prompt_tokens_details
  if (details && typeof details === 'object') {
    const d = details as Record<string, unknown>
    if (typeof d.cached_tokens === 'number') cachedInput = d.cached_tokens
  }

  let reasoningTokens: number | undefined
  const completionDetails = u.completion_tokens_details
  if (completionDetails && typeof completionDetails === 'object') {
    const d = completionDetails as Record<string, unknown>
    if (typeof d.reasoning_tokens === 'number') reasoningTokens = d.reasoning_tokens
  }

  if (
    input === undefined &&
    output === undefined &&
    total === undefined &&
    cachedInput === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined
  }
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: cachedInput,
    reasoningTokens
  }
}

/** GET JSON for model-catalog probes only (not chat streams). */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  providerId?: ProviderId,
  opts?: { quiet?: boolean; allowLocal?: boolean }
): Promise<unknown> {
  const logProvider = providerId ?? 'openai-compat'
  const allowLocal =
    providerId === 'ollama' || providerId === 'custom' || opts?.allowLocal === true
  let res: Response
  try {
    res = (
      await fetchWithValidatedRedirects(
        new URL(url),
        signal ?? new AbortController().signal,
        headers,
        allowLocal
      )
    ).response
  } catch (err) {
    if (signal?.aborted) throw err
    // Local Ollama (or any catalog host) being down is expected — warn, don't ERROR-spam startup.
    // Callers that try multiple endpoints (Ollama /v1 + /api/tags) pass quiet and log once.
    if (!opts?.quiet) {
      logProviderFailure(logProvider, 'network', {}, { soft: true })
    }
    throw new Error(formatError(err))
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (!opts?.quiet) {
      logProviderFailure(
        logProvider,
        'http',
        { status: res.status, message: scrubProviderErrorSnippet(text) || undefined },
        { soft: true }
      )
    }
    throw new Error(formatProviderHttpError(res.status, text, providerId))
  }
  return res.json()
}

function modelsFromOllamaTags(data: unknown): ModelInfo[] {
  const tags = data as { models?: Array<{ name?: string }> }
  const names = (tags.models ?? [])
    .map((m) => m.name)
    .filter((n): n is string => Boolean(n))
  return names.map((name) =>
    baseModelInfo(
      name,
      {
        supportsTools: true,
        supportsVision: /llava|vision/i.test(name)
      },
      'ollama'
    )
  )
}

function mergeOllamaTagNames(models: ModelInfo[], names: string[]): ModelInfo[] {
  const seen = new Set(models.map((m) => m.id))
  const out = [...models]
  for (const name of names) {
    if (seen.has(name)) continue
    out.push(
      baseModelInfo(
        name,
        {
          supportsTools: true,
          supportsVision: /llava|vision/i.test(name)
        },
        'ollama'
      )
    )
    seen.add(name)
  }
  return out
}

function normalizeXaiLanguageModels(data: unknown): ModelInfo[] {
  const root = data as { models?: unknown[]; data?: unknown[] }
  const list = Array.isArray(root.models)
    ? root.models
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(data)
        ? data
        : []
  const out: ModelInfo[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : null
    if (!id || !looksLikeChatModel(id)) continue
    const outputMods = Array.isArray(row.output_modalities)
      ? (row.output_modalities as string[])
      : ['text']
    if (!outputMods.includes('text')) continue
    const inputMods = Array.isArray(row.input_modalities)
      ? (row.input_modalities as string[])
      : ['text']
    const supportsVision = inputMods.includes('image')
    const thinkingPartial = thinkingPartialFromCatalogRow(row, 'xai')
    out.push(
      baseModelInfo(id, {
        displayName: typeof row.name === 'string' ? row.name : id,
        contextWindow:
          typeof row.context_window === 'number'
            ? row.context_window
            : typeof row.context_length === 'number'
              ? row.context_length
              : undefined,
        inputModalities: wireSupportedInputModalities(inputMods, supportsVision, 'xai'),
        outputModalities: wireSupportedOutputModalities(outputMods),
        supportsTools: true,
        supportsVision,
        ...thinkingPartial
      }, 'xai')
    )
  }
  return out
}

async function listOpenAiCompatModels(
  base: string,
  headers: Record<string, string>,
  opts: OpenAiCompatOptions,
  signal?: AbortSignal,
  providerId?: ProviderId
): Promise<ModelInfo[]> {
  const catalogProvider = providerId ?? (opts.ollamaVision ? 'ollama' : undefined)

  if (opts.listLanguageModels) {
    try {
      const data = await fetchJson(`${base}/language-models`, headers, signal, catalogProvider)
      const models = normalizeXaiLanguageModels(data)
      if (models.length) return models
    } catch {
      // fall through to /models
    }
  }

  // Ollama: prefer OpenAI /v1/models, fall back to native /api/tags when unreachable.
  if (opts.ollamaVision) {
    const host = ollamaNativeHost(base)
    const openAiBase = `${host}/v1`
    const ollamaId = catalogProvider ?? 'ollama'
    const cloud = isOllamaCloudHost(host)
    const quiet = { quiet: true as const }
    let openAiErr: unknown
    try {
      const data = await fetchJson(`${openAiBase}/models`, headers, signal, ollamaId, quiet)
      let models = normalizeOpenAiStyleModels(data, {
        requireToolsParam: opts.requireToolsParam,
        providerId: ollamaId
      })
      try {
        const tags = await fetchJson(`${host}/api/tags`, headers, signal, ollamaId, quiet)
        const names = modelsFromOllamaTags(tags).map((m) => m.id)
        models = mergeOllamaTagNames(models, names)
      } catch {
        // Tags enrich is best-effort when OpenAI list already succeeded.
      }
      if (models.length) return models
    } catch (err) {
      openAiErr = err
    }

    try {
      const tags = await fetchJson(`${host}/api/tags`, headers, signal, ollamaId, quiet)
      const models = modelsFromOllamaTags(tags)
      if (models.length) return models
      throw new Error('Ollama /api/tags returned no models')
    } catch (tagsErr) {
      // One soft catalog warn after both endpoints fail (not per attempt).
      const detail = openAiErr ?? tagsErr
      logProviderFailure(
        ollamaId,
        'network',
        { message: formatError(detail) },
        { soft: true }
      )
      if (openAiErr) {
        throw new Error(
          cloud
            ? `Cannot reach Ollama Cloud at ${host} (${formatError(openAiErr)}). Check the base URL and API key.`
            : `Cannot reach Ollama at ${host} (${formatError(openAiErr)}). Start the Ollama app, or save an Ollama API key in Settings to use Ollama Cloud automatically.`
        )
      }
      throw new Error(
        cloud
          ? `Ollama Cloud at ${host} returned no models (${formatError(tagsErr)}). Verify your API key at ollama.com/settings/keys.`
          : `Ollama at ${host} returned no models (${formatError(tagsErr)}). Pull a model with \`ollama pull\`, or save an Ollama API key to use Cloud.`
      )
    }
  }

  const listPath = opts.listPath ?? '/models'
  const url =
    opts.requireToolsParam && !opts.listPath
      ? `${base}${listPath}?supported_parameters=tools`
      : `${base}${listPath}`

  try {
    const data = await fetchJson(url, headers, signal, providerId, {
      allowLocal: opts.allowLocal
    })
    return normalizeOpenAiStyleModels(data, {
      requireToolsParam: opts.requireToolsParam,
      providerId
    })
  } catch (err) {
    if (providerId === 'custom') {
      const host = base.replace(/\/v1\/?$/i, '').replace(/\/$/, '')
      throw new Error(
        `Cannot reach custom OpenAI-compatible host at ${host} (${formatError(err)}). Check the base URL and that the server is running.`
      )
    }
    throw err
  }
}

/** Exported for tests — build OpenAI-compat chat request body. */
export function buildOpenAiCompatBody(
  req: ProviderChatRequest,
  opts: OpenAiCompatOptions,
  providerId?: ProviderId,
  overrides?: { strictTools?: boolean; omitReasoning?: boolean; omitIncludeUsage?: boolean }
): Record<string, unknown> {
  const strictTools =
    overrides?.strictTools !== undefined
      ? overrides.strictTools
      : req.strictTools !== false && req.tools.length > 0 && !opts.ollamaVision
  const tools = req.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(strictTools ? { strict: true } : {})
    }
  }))
  const stripReasoningReplay =
    opts.openRouterReasoning ||
    providerId === 'openrouter' ||
    (providerId === 'custom' && req.thinking?.display === 'omitted')
  // Mistral requires ThinkChunk arrays in content on multi-turn replay.
  // Custom keeps reasoning_content unless stored state says think_chunks.
  const reasoningReplayFormat: OpenAiCompatReasoningReplayFormat | undefined =
    providerId === 'mistral' ? 'think_chunks' : undefined
  const explicitCache =
    Boolean(opts.enablePromptCache) && supportsExplicitPromptCache(req.model)
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req.messages, req.system, {
      ollamaVision: opts.ollamaVision,
      stripReasoningReplay,
      reasoningReplayFormat,
      systemStable: req.systemStable,
      systemVolatile: req.systemVolatile,
      explicitPromptCache: explicitCache
    }),
    tools: tools.length ? tools : undefined,
    ...(tools.length
      ? {
          tool_choice: req.toolChoice ?? 'auto',
          ...(opts.ollamaVision
            ? {}
            : { parallel_tool_calls: req.parallelToolCalls ?? true })
        }
      : {}),
    ...(req.responseFormat
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: req.responseFormat.name,
              strict: req.responseFormat.strict ?? true,
              schema: req.responseFormat.schema
            }
          }
        }
      : {}),
    stream: true,
    ...(req.maxOutputTokens && req.maxOutputTokens > 0 ? { max_tokens: req.maxOutputTokens } : {}),
    ...(opts.enablePromptCache && req.promptCacheKey
      ? {
          prompt_cache_key: req.promptCacheKey,
          ...(explicitCache ? { prompt_cache_options: { mode: 'explicit', ttl: '30m' } } : {})
        }
      : {}),
    ...(overrides?.omitIncludeUsage ? {} : compatStreamOptions(opts))
  }

  const useDeepSeekThinking =
    opts.deepseekThinking ||
    providerId === 'deepseek' ||
    (providerId === 'custom' && isDeepSeekNativeThinkingModel(req.model))

  if (req.thinking?.enabled && !overrides?.omitReasoning) {
    const allowed = req.modelInfo?.supportedThinkingEfforts
    const effort = coerceEffortToAllowed(req.thinking.effort, allowed)
    if (useDeepSeekThinking) {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = normalizeEffortForDeepSeek(effort)
    } else if (opts.openRouterReasoning || providerId === 'openrouter') {
      const reasoning: Record<string, unknown> = { effort }
      if (
        req.thinking.maxTokens &&
        (req.modelInfo?.thinkingSupportsTokenBudget || req.thinking.maxTokens)
      ) {
        reasoning.max_tokens = req.thinking.maxTokens
      }
      body.reasoning = reasoning
    } else if (providerId === 'groq') {
      body.reasoning_effort = normalizeEffortForOpenAiCompatReasoning(effort, 'groq')
      // include_reasoning and reasoning_format are mutually exclusive (Groq docs).
      if (req.thinking.display === 'omitted') {
        body.reasoning_format = 'hidden'
      } else {
        body.include_reasoning = true
      }
    } else if (providerId === 'xai') {
      body.reasoning_effort = normalizeEffortForOpenAiCompatReasoning(effort, 'xai')
    } else if (providerId === 'ollama') {
      const mode = req.modelInfo?.thinkingMode
      const efforts = req.modelInfo?.supportedThinkingEfforts
      if (mode === 'effort' || (efforts && efforts.length > 0)) {
        body.think = normalizeEffortForOllamaThink(effort, efforts)
      } else {
        body.think = true
      }
    } else if (providerId === 'custom') {
      // Widest OpenAI-compat overlap: reasoning_effort (+ optional include_reasoning).
      body.reasoning_effort = normalizeEffortForOpenAiCompatReasoning(effort, 'xai')
      if (req.thinking.display !== 'omitted') {
        body.include_reasoning = true
      }
    } else if (providerId === 'mistral') {
      // Mistral docs: reasoning_effort on chat completions (ThinkChunk in content).
      body.reasoning_effort = normalizeEffortForMistral(effort)
    }
  } else if (req.thinking?.enabled === false && providerId === 'ollama') {
    if (req.modelInfo?.thinkingCanDisable === false) {
      const efforts = req.modelInfo.supportedThinkingEfforts
      body.think = normalizeEffortForOllamaThink('low', efforts)
    } else {
      body.think = false
    }
  } else if (req.thinking?.enabled === false && useDeepSeekThinking) {
    body.thinking = { type: 'disabled' }
  } else if (
    req.thinking?.enabled === false &&
    (opts.openRouterReasoning || providerId === 'openrouter') &&
    req.modelInfo?.thinkingCanDisable !== false &&
    req.modelInfo?.supportsThinking
  ) {
    body.reasoning = { effort: 'none' }
  } else if (
    req.thinking?.enabled === false &&
    providerId === 'mistral' &&
    req.modelInfo?.thinkingCanDisable !== false &&
    req.modelInfo?.supportsThinking
  ) {
    body.reasoning_effort = 'none'
  }

  const tier = serviceTierForApiBody(req.serviceTier)
  if (tier) {
    const supported = req.modelInfo?.supportedServiceTiers
    if (!Array.isArray(supported) || supported.includes(tier)) {
      body.service_tier = tier
    }
  }

  return body
}

export function createOpenAiCompatibleProvider(
  id: LlmProvider['id'],
  options: OpenAiCompatOptions | string
): LlmProvider {
  const opts: OpenAiCompatOptions =
    typeof options === 'string' ? { defaultBaseUrl: options } : options

  return {
    id,
    async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
      // Local Ollama: no key required (Bearer can break some local proxies).
      // Ollama Cloud / other OpenAI-compat: require a key; omit Bearer only when unset.
      if (!opts.ollamaVision && !opts.optionalApiKey && !req.apiKey?.trim()) {
        throw new Error(`${id} API key not set`)
      }
      if (
        opts.ollamaVision &&
        isOllamaCloudHost(req.baseUrl || opts.defaultBaseUrl) &&
        !req.apiKey?.trim()
      ) {
        throw new Error('Ollama Cloud API key not set')
      }
      const raw = (req.baseUrl || opts.defaultBaseUrl).replace(/\/$/, '')
      const base = opts.ollamaVision ? `${ollamaNativeHost(raw)}/v1` : raw
      await validateProviderBaseUrl(base, opts.allowLocal === true || id === 'ollama')
      const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) }
      if (req.apiKey?.trim()) {
        headers.Authorization = `Bearer ${req.apiKey.trim()}`
      }
      return listOpenAiCompatModels(base, headers, opts, req.signal, id)
    },
    async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
      if (!opts.ollamaVision && !opts.optionalApiKey && !req.apiKey?.trim()) {
        yield { type: 'error', error: `${id} API key not set` }
        return
      }
      if (
        opts.ollamaVision &&
        isOllamaCloudHost(req.baseUrl || opts.defaultBaseUrl) &&
        !req.apiKey?.trim()
      ) {
        yield { type: 'error', error: 'Ollama Cloud API key not set' }
        return
      }
      const raw = (req.baseUrl || opts.defaultBaseUrl).replace(/\/$/, '')
      const base = opts.ollamaVision ? `${ollamaNativeHost(raw)}/v1` : raw
      const allowLocal = opts.allowLocal === true || id === 'ollama'
      await validateProviderBaseUrl(base, allowLocal)
      const url = `${base}/chat/completions`

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(opts.extraHeaders ?? {})
      }
      if (req.apiKey?.trim()) {
        headers.Authorization = `Bearer ${req.apiKey.trim()}`
      }

      let maxOutputTokens = req.maxOutputTokens
      let res: Response | undefined
      let bodyOverrides:
        | { strictTools?: boolean; omitReasoning?: boolean; omitIncludeUsage?: boolean }
        | undefined
      let lastHttpErrorText = ''

      for (let attempt = 0; attempt < 4; attempt++) {
        const body = buildOpenAiCompatBody(
          { ...req, maxOutputTokens },
          opts,
          id,
          bodyOverrides
        )
        try {
          res = await fetchWithRetry(url, {
            method: 'POST',
            headers,
            signal: req.signal,
            body: JSON.stringify(body)
          })
        } catch (err) {
          if (req.signal.aborted) throw err
          logProviderFailure(id, 'network', {})
          yield { type: 'error', error: formatError(err), errorCode: 'PROVIDER_NETWORK' }
          return
        }

        if (res.ok) break

        const text = await res.text().catch(() => '')
        lastHttpErrorText = text
        const affordable =
          id === 'openrouter' && res.status === 402
            ? parseOpenRouterAffordableOutputTokens(text)
            : undefined
        if (
          attempt === 0 &&
          affordable &&
          (maxOutputTokens === undefined || affordable < maxOutputTokens)
        ) {
          maxOutputTokens = affordable
          continue
        }

        // Some OpenAI-compat hosts reject stream_options.include_usage — retry without.
        if (
          !bodyOverrides?.omitIncludeUsage &&
          opts.includeUsage !== false &&
          !opts.ollamaVision &&
          shouldRetryOmitIncludeUsage(res.status, text)
        ) {
          bodyOverrides = { ...bodyOverrides, omitIncludeUsage: true }
          continue
        }

        // OpenRouter/OpenAI-compat: one fallback without strict tools, then
        // without reasoning — mirrors Anthropic's 400 field-stripping retries.
        // Also retry on 404 "no endpoints" (privacy/params often report as 404).
        if (
          (id === 'openrouter' || opts.openRouterReasoning) &&
          shouldRetryOpenRouterCompatBody(res.status, text)
        ) {
          if (req.tools.length > 0 && bodyOverrides?.strictTools !== false) {
            bodyOverrides = { ...bodyOverrides, strictTools: false }
            continue
          }
          if (!bodyOverrides?.omitReasoning && req.thinking?.enabled) {
            bodyOverrides = { ...bodyOverrides, strictTools: false, omitReasoning: true }
            continue
          }
        }

        const message = formatProviderHttpError(res.status, text, id)
        logProviderFailure(id, 'http', {
          status: res.status,
          message: scrubProviderErrorSnippet(text) || message,
          model: req.model
        })
        yield { type: 'error', error: message, errorCode: 'PROVIDER_HTTP' }
        return
      }

      if (!res?.ok) {
        const status = res?.status ?? 0
        const message = formatProviderHttpError(status, lastHttpErrorText, id)
        logProviderFailure(id, 'http', {
          status,
          message: scrubProviderErrorSnippet(lastHttpErrorText) || message,
          model: req.model
        })
        yield { type: 'error', error: message, errorCode: 'PROVIDER_HTTP' }
        return
      }

      const pending = new Map<number, ToolCall>()
      let lastUsage: TokenUsage | undefined
      let reasoningContent = ''
      let reasoningDetails: unknown
      let reasoningFormat: OpenAiCompatReasoningReplayFormat | undefined
      let thinkChunks: OpenAiCompatThinkChunk[] = []
      let stopReason: StopReason | undefined
      let thinkingDoneEmitted = false
      const drops = { dropped: 0 }

      const emitThinkingDoneIfNeeded = function* (): Generator<StreamChunk, void, unknown> {
        if (reasoningContent && !thinkingDoneEmitted) {
          thinkingDoneEmitted = true
          yield { type: 'thinking_done', text: reasoningContent }
        }
      }

      const noteReasoningFormat = (format: OpenAiCompatReasoningReplayFormat) => {
        // Prefer think_chunks once seen — mixed streams still need structured replay.
        if (reasoningFormat === 'think_chunks') return
        reasoningFormat = format
      }

      for await (const chunk of iterateSseJson(res, req.signal, drops)) {
        const usage = parseOpenAiCompatUsage(chunk.usage)
        if (usage) lastUsage = usage

        const choices = chunk.choices as Array<Record<string, unknown>> | undefined
        const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
        const message = choices?.[0]?.message as Record<string, unknown> | undefined

        // xAI often delivers whole tool_calls on message rather than delta args
        const wholeCalls =
          (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ??
          (message?.tool_calls as Array<Record<string, unknown>> | undefined)
        const contentParts = parseOpenAiCompatDeltaContent(delta?.content)
        const textContent = contentParts.text

        if (contentParts.reasoning) {
          noteReasoningFormat('think_chunks')
          reasoningContent += contentParts.reasoning
          if (contentParts.thinkChunks) {
            thinkChunks = absorbOpenAiCompatThinkChunks(thinkChunks, contentParts.thinkChunks)
          }
          yield { type: 'thinking_delta', text: contentParts.reasoning }
        } else {
          const reasoningDelta =
            (typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : undefined) ??
            (typeof delta?.reasoning === 'string' ? delta.reasoning : undefined)
          if (reasoningDelta) {
            noteReasoningFormat('reasoning_content')
            reasoningContent += reasoningDelta
            yield { type: 'thinking_delta', text: reasoningDelta }
          }
        }
        if (delta?.reasoning_details !== undefined) {
          reasoningDetails = delta.reasoning_details
        }

        const messageContentParts = parseOpenAiCompatDeltaContent(message?.content)
        if (messageContentParts.reasoning) {
          noteReasoningFormat('think_chunks')
          const deltaText = openAiCompatMessageReasoningDelta(
            messageContentParts.reasoning,
            reasoningContent
          )
          if (deltaText) {
            yield { type: 'thinking_delta', text: deltaText }
          }
          reasoningContent = messageContentParts.reasoning
          // Full message content replaces streamed ThinkChunk layout.
          if (messageContentParts.thinkChunks) {
            thinkChunks = messageContentParts.thinkChunks.map((c) => ({
              ...c,
              thinking: c.thinking?.map((p) => ({ ...p }))
            }))
          }
        } else {
          const messageReasoning =
            (typeof message?.reasoning_content === 'string' ? message.reasoning_content : undefined) ??
            (typeof message?.reasoning === 'string' ? message.reasoning : undefined)
          if (messageReasoning) {
            noteReasoningFormat('reasoning_content')
            const deltaText = openAiCompatMessageReasoningDelta(messageReasoning, reasoningContent)
            if (deltaText) {
              yield { type: 'thinking_delta', text: deltaText }
            }
            reasoningContent = messageReasoning
          }
        }
        if (message?.reasoning_details !== undefined) {
          reasoningDetails = message.reasoning_details
        }

        // Prefer tool deltas before text in the same SSE frame so the UI can
        // paint tool chrome without a text-first flash.
        if (wholeCalls) {
          yield* emitThinkingDoneIfNeeded()
          for (const tc of wholeCalls) {
            const index = typeof tc.index === 'number' ? tc.index : pending.size
            const fn = tc.function as { name?: string; arguments?: string } | undefined
            const existing = pending.get(index) ?? {
              id: typeof tc.id === 'string' ? tc.id : `call_${index}`,
              name: '',
              arguments: ''
            }
            if (typeof tc.id === 'string') existing.id = tc.id
            if (fn?.name) {
              // Prefer whole name when chunk includes id (xAI whole-chunk); else append deltas
              if (tc.id && fn.name) existing.name = fn.name
              else existing.name += fn.name
            }
            if (fn?.arguments) {
              if (tc.id && fn.name && fn.arguments.startsWith('{') && !existing.arguments) {
                existing.arguments = fn.arguments
              } else if (
                tc.id &&
                fn.name &&
                existing.arguments &&
                fn.arguments.length >= existing.arguments.length &&
                !fn.arguments.startsWith(existing.arguments.slice(0, 8))
              ) {
                existing.arguments = fn.arguments
              } else {
                existing.arguments += fn.arguments
              }
            }
            pending.set(index, existing)
            yield {
              type: 'tool_call_delta',
              toolCallDelta: {
                index,
                id: typeof tc.id === 'string' ? tc.id : undefined,
                name: fn?.name,
                arguments: fn?.arguments
              }
            }
          }
        }

        if (textContent) {
          yield* emitThinkingDoneIfNeeded()
          yield { type: 'text', text: textContent }
        }

        const finish = choices?.[0]?.finish_reason
        if (finish) stopReason = normalizeStopReason(finish)
        if (finish === 'tool_calls' && pending.size > 0) {
          for (const call of pending.values()) {
            yield { type: 'tool_call', toolCall: call }
          }
          pending.clear()
        }
      }

      for (const call of pending.values()) {
        yield { type: 'tool_call', toolCall: call }
      }
      if (reasoningContent && !thinkingDoneEmitted) {
        yield { type: 'thinking_done', text: reasoningContent }
      }
      const finalizedThinkChunks =
        thinkChunks.length > 0 ? finalizeOpenAiCompatThinkChunks(thinkChunks) : undefined
      yield {
        type: 'done',
        usage: lastUsage,
        stopReason,
        malformedChunks: drops.dropped || undefined,
        reasoningState:
          reasoningContent || reasoningDetails !== undefined || finalizedThinkChunks
            ? {
                kind: 'openai_compat' as const,
                reasoningContent: reasoningContent || undefined,
                reasoningDetails,
                ...(reasoningFormat ? { reasoningFormat } : {}),
                ...(finalizedThinkChunks ? { thinkChunks: finalizedThinkChunks } : {})
              }
            : undefined
      }
    }
  }
}

export const openaiProvider: LlmProvider = {
  ...createOpenAiCompatibleProvider('openai', {
    defaultBaseUrl: 'https://api.openai.com/v1',
    enablePromptCache: true
  }),
  async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    // Responses-first for reasoning-family models (better cache + tool loops).
    const modelCore = normalizeModelIdForHeuristics(req.model)
    const useResponses =
      req.modelInfo?.thinkingApi === 'responses' ||
      /^(o1(?:-|$)|o[34](?:-|$)|gpt-5(?:\.|-|$))/i.test(modelCore)
    if (useResponses) {
      yield* streamOpenAiResponses(req)
      return
    }
    const base = createOpenAiCompatibleProvider('openai', {
      defaultBaseUrl: 'https://api.openai.com/v1',
      enablePromptCache: true
    })
    yield* base.streamChat(req)
  }
}
export const deepseekProvider = createOpenAiCompatibleProvider(
  'deepseek',
  {
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    deepseekThinking: true
  }
)
export const ollamaProvider = createOpenAiCompatibleProvider('ollama', {
  defaultBaseUrl: 'http://127.0.0.1:11434/v1',
  ollamaVision: true
})
export const groqProvider = createOpenAiCompatibleProvider('groq', {
  defaultBaseUrl: 'https://api.groq.com/openai/v1'
})
export const openrouterProvider = createOpenAiCompatibleProvider('openrouter', {
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'https://vyotiq.com',
    'X-Title': 'Vyotiq'
  },
  requireToolsParam: true,
  openRouterReasoning: true
})
export const xaiProvider = createOpenAiCompatibleProvider('xai', {
  defaultBaseUrl: 'https://api.x.ai/v1',
  listLanguageModels: true
})
export const mistralProvider = createOpenAiCompatibleProvider('mistral', {
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  /** Mistral rejects OpenAI `stream_options.include_usage`. */
  includeUsage: false
})

/** Bring-your-own OpenAI-compatible host (Cerebras, Fireworks, Together, vLLM, …). */
export const customProvider = createOpenAiCompatibleProvider('custom', {
  defaultBaseUrl: 'http://127.0.0.1:8080/v1',
  optionalApiKey: true,
  allowLocal: true,
  /** Hosts that ignore unknown fields still benefit when OpenAI-like. */
  enablePromptCache: true
})

/** Exported for tests / multimodal mapping checks. */
export function mapOpenAiContentParts(
  parts: ContentPart[],
  ollamaVision?: boolean
): string | Array<Record<string, unknown>> {
  return toOpenAiContent(parts, { ollamaVision })
}
