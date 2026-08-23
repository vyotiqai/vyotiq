import type { ChatMessage, MessageContent } from '../../../shared/ipc'
import { createHash } from 'crypto'
import { contentToText, providerContentParts } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import {
  normalizeEffortForOpenAiResponses,
  statefulContinuationMessages,
  type ProviderReasoningState
} from '../../../shared/reasoning'
import { parseServiceTier, serviceTierForApiBody } from '../../../shared/domain/serviceTier'
import type { ProviderChatRequest, StopReason, StreamChunk, ToolCall, TokenUsage } from './types'
import { billedCostFromUsage, cacheWriteTokensFromDetails } from './usageFields'
import { normalizeStopReason } from './stopReason'
import { iterateSseJson } from './sse'
import { logProviderFailure, providerFetchFailureChunk } from './log'
import { CHAT_FETCH_MAX_ATTEMPTS, fetchWithRetry } from './fetchWithRetry'
import { formatProviderHttpError } from './httpErrors'
import {
  resolveSystemZones,
  supportsExplicitPromptCache,
  volatileSessionMessage,
  markResponsesCacheBreakpoint,
  attachTrailingHistoryCacheBreakpoint
} from './systemZones'
import { mergeOpenAiCompatToolArgDelta, wireToolCallArguments } from '../toolArgWire'

export { supportsExplicitPromptCache } from './systemZones'

const continuationPromptKeys = new Map<string, string>()
const MAX_CONTINUATION_KEYS = 256

function stablePromptKey(req: ProviderChatRequest): string | undefined {
  if (req.systemStable === undefined) return undefined
  const stable = resolveSystemZones(req).stable ?? ''
  return createHash('sha256').update(req.model).update('\0').update(stable).digest('hex')
}

function rememberContinuationPrompt(responseId: string, key: string): void {
  continuationPromptKeys.delete(responseId)
  continuationPromptKeys.set(responseId, key)
  if (continuationPromptKeys.size > MAX_CONTINUATION_KEYS) {
    const oldest = continuationPromptKeys.keys().next().value
    if (oldest) continuationPromptKeys.delete(oldest)
  }
}

/** Exported for tests — parse Responses usage including cache write tokens. */
export function parseOpenAiResponsesUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined
  const cachedInputTokens =
    inputDetails && typeof inputDetails.cached_tokens === 'number'
      ? inputDetails.cached_tokens
      : typeof usage.prompt_cache_hit_tokens === 'number'
        ? usage.prompt_cache_hit_tokens
        : typeof usage.cached_tokens === 'number'
          ? usage.cached_tokens
          : inputDetails && typeof inputDetails.prompt_cache_hit_tokens === 'number'
            ? inputDetails.prompt_cache_hit_tokens
            : undefined
  const cacheCreationInputTokens = cacheWriteTokensFromDetails(
    inputDetails,
    usage.cache_write_tokens
  )
  const billed = billedCostFromUsage(usage)
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined
  const reasoningTokens =
    outputDetails && typeof outputDetails.reasoning_tokens === 'number'
      ? outputDetails.reasoning_tokens
      : undefined
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    reasoningTokens === undefined &&
    billed.billedCost === undefined &&
    billed.billedCostSaved === undefined
  ) {
    return undefined
  }
  return {
    inputTokens,
    inputTokensIncludesCache: true,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
    ...billed
  }
}

function appendResponsesMessageItems(
  out: Array<Record<string, unknown>>,
  messages: ChatMessage[]
): void {
  for (const m of messages) {
    if (m.role === 'tool') {
      // Orphan tool rows emit call_id: undefined and get an HTTP 400 — skip them.
      if (!m.toolCallId) continue
      out.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: typeof m.content === 'string' ? m.content : contentToText(m.content)
      })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const state = m.reasoningState as ProviderReasoningState | undefined
      if (state?.kind === 'openai_responses' && state.outputItems.length) {
        for (const item of state.outputItems) {
          if (!item || typeof item !== 'object') continue
          const rec = item as Record<string, unknown>
          if (rec.type === 'function_call' && typeof rec.name === 'string') {
            out.push({
              ...rec,
              arguments: wireToolCallArguments(
                rec.name,
                typeof rec.arguments === 'string' ? rec.arguments : ''
              )
            })
          } else {
            out.push(rec)
          }
        }
      } else {
        for (const tc of m.toolCalls) {
          out.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: wireToolCallArguments(tc.name, tc.arguments)
          })
        }
      }
      continue
    }
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
      if (text) out.push({ role: 'assistant', content: text })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: toResponsesUserContent(m.content) })
    }
  }
}

export function toResponsesInput(
  messages: ChatMessage[],
  system: string | undefined,
  priorState?: ProviderReasoningState,
  opts?: {
    explicitPromptCache?: boolean
    systemStable?: string
    systemVolatile?: string
  }
): Array<Record<string, unknown>> {
  const zones = resolveSystemZones({
    system,
    systemStable: opts?.systemStable,
    systemVolatile: opts?.systemVolatile
  })
  // Stateful continuation: server retains prior turn via previous_response_id.
  // Tool-only suffixes stay tool outputs; a newer user turn is the suffix after
  // the last reasoning assistant — not an empty trailing-tool list.
  if (priorState?.kind === 'openai_responses' && priorState.responseId) {
    const out: Array<Record<string, unknown>> = []
    appendResponsesMessageItems(out, statefulContinuationMessages(messages))
    if (zones.volatile) {
      const vol = volatileSessionMessage(zones.volatile)
      out.push({ role: 'user', content: vol.content })
    }
    return out
  }

  const out: Array<Record<string, unknown>> = []
  if (zones.stable) {
    if (opts?.explicitPromptCache) {
      out.push({
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: zones.stable,
            prompt_cache_breakpoint: { mode: 'explicit' }
          }
        ]
      })
    } else {
      out.push({ role: 'developer', content: zones.stable })
    }
  }

  appendResponsesMessageItems(out, messages)
  if (opts?.explicitPromptCache) {
    // Second breakpoint after history so volatile session context stays outside the cache prefix.
    // Avoid function_call_output breakpoints (accepted but do not write cache).
    attachTrailingHistoryCacheBreakpoint(out, markResponsesCacheBreakpoint)
  }
  if (zones.volatile) {
    const vol = volatileSessionMessage(zones.volatile)
    out.push({ role: 'user', content: vol.content })
  }
  return out
}

/**
 * Responses uses `input_text` / `input_image` / `input_file` parts rather than the chat
 * completions shape. Flattening to text here would silently drop rich attachments.
 */
export function toResponsesUserContent(
  content: MessageContent
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  const parts = providerContentParts(content, {
    image: true,
    fileNative: true,
    audio: false
  })
  const rich = parts.some((p) => p.type !== 'text')
  if (!rich) return contentToText(content)
  return parts.map((part) => {
    if (part.type === 'image_url') return { type: 'input_image', image_url: part.url }
    if (part.type === 'file_native') {
      const mime = part.mime || 'application/pdf'
      return {
        type: 'input_file',
        filename: part.name,
        file_data: `data:${mime};base64,${part.data}`
      }
    }
    if (part.type === 'audio') {
      return {
        type: 'input_text',
        text: '[audio omitted: OpenAI Responses does not accept input_audio]'
      }
    }
    return { type: 'input_text', text: part.text }
  })
}

function toResponsesTools(
  tools: ProviderChatRequest['tools']
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }))
}

/** Stream chat via OpenAI Responses API for reasoning models. */
export async function* streamOpenAiResponses(
  req: ProviderChatRequest
): AsyncGenerator<StreamChunk> {
  if (!req.apiKey) {
    yield { type: 'error', error: 'OpenAI API key not set' }
    return
  }

  const candidatePriorState =
    req.reasoningState?.kind === 'openai_responses' ? req.reasoningState : undefined
  const promptKey = stablePromptKey(req)
  const priorState =
    candidatePriorState?.responseId &&
    (promptKey === undefined ||
      continuationPromptKeys.get(candidatePriorState.responseId) === promptKey)
      ? candidatePriorState
      : undefined
  // Omitted thinking means off; match the OpenAI-compat body builder instead
  // of silently paying reasoning tokens.
  const thinkingOn = req.thinking?.enabled === true
  const thinkingOff = req.thinking?.enabled === false
  const supportsThinking = req.modelInfo?.supportsThinking !== false
  const explicitCache = supportsExplicitPromptCache(req.model)

  const body: Record<string, unknown> = {
    model: req.model,
    input: toResponsesInput(req.messages, req.system, priorState, {
      explicitPromptCache: explicitCache,
      systemStable: req.systemStable,
      systemVolatile: req.systemVolatile
    }),
    stream: true,
    store: true,
    ...(req.tools.length
      ? {
          tools: toResponsesTools(req.tools),
          tool_choice: req.toolChoice ?? 'auto',
          parallel_tool_calls: req.parallelToolCalls ?? true
        }
      : {}),
    ...(thinkingOn
      ? {
          reasoning: {
            effort: normalizeEffortForOpenAiResponses(req.thinking?.effort, true),
            summary: 'auto',
            context: 'all_turns'
          }
        }
      : thinkingOff && supportsThinking
        ? {
            reasoning: {
              effort: 'none',
              summary: 'auto',
              context: 'all_turns'
            }
          }
        : {}),
    ...(priorState?.responseId ? { previous_response_id: priorState.responseId } : {}),
    ...(req.promptCacheKey ? { prompt_cache_key: req.promptCacheKey } : {}),
    ...(explicitCache
      ? { prompt_cache_options: { mode: 'explicit', ttl: '30m' } }
      : {})
  }

  const tier = serviceTierForApiBody(parseServiceTier(req.serviceTier))
  if (tier) {
    const supported = req.modelInfo?.supportedServiceTiers
    if (!Array.isArray(supported) || supported.includes(tier)) {
      body.service_tier = tier
    }
  }

  let res: Response
  try {
    res = await fetchWithRetry(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${req.apiKey}`
        },
        signal: req.signal,
        body: JSON.stringify(body)
      },
      { maxAttempts: CHAT_FETCH_MAX_ATTEMPTS }
    )
  } catch (err) {
    if (req.signal.aborted) throw err
    yield providerFetchFailureChunk('openai', err)
    return
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logProviderFailure('openai', 'http', { status: res.status })
    yield { type: 'error', error: formatProviderHttpError(res.status, text, 'openai'), errorCode: 'PROVIDER_HTTP' }
    return
  }

  const pending = new Map<string, ToolCall>()
  const yieldedToolCalls = new Set<string>()
  const itemIdToCallId = new Map<string, string>()
  const outputItems: unknown[] = []
  let responseId: string | undefined
  let thinkingText = ''
  let thinkingDoneEmitted = false
  let answerStarted = false
  let lastUsage: TokenUsage | undefined
  let stopReason: StopReason | undefined
  let toolCallIndex = 0
  const toolCallIndexes = new Map<string, number>()

  const indexForCall = (callId: string): number => {
    const existing = toolCallIndexes.get(callId)
    if (existing !== undefined) return existing
    const next = toolCallIndex++
    toolCallIndexes.set(callId, next)
    return next
  }

  const emitThinkingDoneIfNeeded = function* (): Generator<StreamChunk, void, unknown> {
    if (thinkingText && !thinkingDoneEmitted) {
      thinkingDoneEmitted = true
      yield { type: 'thinking_done', text: thinkingText }
    }
  }

  const drops = { dropped: 0 }

  for await (const event of iterateSseJson(res, req.signal, drops)) {
    const type = event.type as string | undefined
    const response = event.response as Record<string, unknown> | undefined
    if (response && typeof response.id === 'string') responseId = response.id

    if (type === 'response.output_text.delta') {
      const delta = event.delta as string | undefined
      if (delta) {
        answerStarted = true
        yield* emitThinkingDoneIfNeeded()
        yield { type: 'text', text: delta }
      }
    }

    if (type === 'response.reasoning_summary_text.delta') {
      const delta = event.delta as string | undefined
      if (delta) {
        thinkingText += delta
        yield { type: 'thinking_delta', text: delta }
      }
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') {
        const itemId = typeof item.id === 'string' ? item.id : ''
        const callId = String(item.call_id ?? item.id ?? `call_${pending.size}`)
        if (itemId) itemIdToCallId.set(itemId, callId)
        const call: ToolCall = {
          id: callId,
          name: String(item.name ?? ''),
          arguments: ''
        }
        pending.set(callId, call)
        // Emit immediately so UI can show tool chrome before argument deltas.
        yield* emitThinkingDoneIfNeeded()
        yield {
          type: 'tool_call_delta',
          toolCallDelta: {
            index: indexForCall(callId),
            id: callId,
            name: call.name || undefined,
            arguments: ''
          }
        }
      }
    }

    if (type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined
      if (item) {
        outputItems.push(item)
        if (item.type === 'function_call') {
          yield* emitThinkingDoneIfNeeded()
          const callId = String(item.call_id ?? item.id ?? `call_${pending.size}`)
          const call: ToolCall = {
            id: callId,
            name: String(item.name ?? ''),
            arguments: String(item.arguments ?? '')
          }
          pending.set(callId, call)
          yieldedToolCalls.add(callId)
          yield { type: 'tool_call', toolCall: call }
        }
        if (item.type === 'reasoning') {
          const summary = item.summary as Array<{ text?: string }> | undefined
          if (summary?.length) {
            const text = summary.map((s) => s.text ?? '').join('')
            if (text && !thinkingText && !answerStarted && !thinkingDoneEmitted) {
              thinkingText = text
              yield { type: 'thinking_delta', text }
            }
          }
        }
      }
    }

    if (type === 'response.function_call_arguments.delta') {
      const callId = String(
        event.call_id ?? itemIdToCallId.get(String(event.item_id ?? '')) ?? ''
      )
      const delta = event.delta as string | undefined
      if (callId && delta) {
        yield* emitThinkingDoneIfNeeded()
        const existing = pending.get(callId) ?? { id: callId, name: '', arguments: '' }
        const merged = mergeOpenAiCompatToolArgDelta(existing.arguments, delta)
        existing.arguments = merged.arguments
        pending.set(callId, existing)
        yield {
          type: 'tool_call_delta',
          toolCallDelta: { index: indexForCall(callId), id: callId, arguments: merged.yieldDelta }
        }
      }
    }

    if (type === 'response.incomplete' || type === 'response.failed') {
      const details = response?.incomplete_details as Record<string, unknown> | undefined
      stopReason = normalizeStopReason(details?.reason) ?? (type === 'response.failed' ? 'error' : 'unknown')
      if (type === 'response.failed') {
        const errObj = response?.error as { message?: string } | undefined
        const message = errObj?.message ?? 'OpenAI response failed'
        logProviderFailure('openai', 'stream', {})
        yield { type: 'error', error: message, errorCode: 'PROVIDER_STREAM' }
        return
      }
    }

    if (type === 'response.completed' || type === 'response.done') {
      const details = response?.incomplete_details as Record<string, unknown> | undefined
      // `incomplete_details` is present even on a terminal `completed` frame when the
      // response was cut short, so prefer it over the event name.
      stopReason = normalizeStopReason(details?.reason) ?? stopReason ?? 'stop'
      const parsed = parseOpenAiResponsesUsage(response?.usage)
      if (parsed) lastUsage = parsed
    }
  }

  if (thinkingText && !thinkingDoneEmitted) yield { type: 'thinking_done', text: thinkingText }

  // Flush tool calls that only received argument deltas (no output_item.done).
  for (const [callId, call] of pending) {
    if (yieldedToolCalls.has(callId) || !call.name) continue
    yield { type: 'tool_call', toolCall: call }
  }

  if (responseId && promptKey) rememberContinuationPrompt(responseId, promptKey)

  yield {
    type: 'done',
    usage: lastUsage,
    stopReason,
    reasoningState:
      outputItems.length || responseId
        ? {
            kind: 'openai_responses' as const,
            responseId,
            outputItems
          }
        : undefined
  }
}
