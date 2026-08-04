import type { ChatMessage, MessageContent } from '../../../shared/ipc'
import { contentToText, providerContentParts } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import {
  normalizeEffortForOpenAiResponses,
  trailingToolMessages,
  type ProviderReasoningState
} from '../../../shared/reasoning'
import { parseServiceTier, serviceTierForApiBody } from '../../../shared/domain/serviceTier'
import type { ProviderChatRequest, StopReason, StreamChunk, ToolCall, TokenUsage } from './types'
import { normalizeStopReason } from './stopReason'
import { iterateSseJson } from './sse'
import { logProviderFailure } from './log'
import { fetchWithRetry } from './fetchWithRetry'
import { formatProviderHttpError } from './httpErrors'
import {
  resolveSystemZones,
  supportsExplicitPromptCache,
  volatileSessionMessage,
  markResponsesCacheBreakpoint,
  attachTrailingHistoryCacheBreakpoint
} from './systemZones'

export { supportsExplicitPromptCache } from './systemZones'

function toolOutputsFromMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages
    .filter((m) => m.role === 'tool' && m.toolCallId)
    .map((m) => ({
      type: 'function_call_output',
      call_id: m.toolCallId,
      output: typeof m.content === 'string' ? m.content : contentToText(m.content)
    }))
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
  // Stateful continuation: server retains prior turn via previous_response_id.
  if (priorState?.kind === 'openai_responses' && priorState.responseId) {
    return toolOutputsFromMessages(trailingToolMessages(messages))
  }

  const zones = resolveSystemZones({
    system,
    systemStable: opts?.systemStable,
    systemVolatile: opts?.systemVolatile
  })
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
          if (item && typeof item === 'object') out.push(item as Record<string, unknown>)
        }
      } else {
        for (const tc of m.toolCalls) {
          out.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments
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
  tools: ProviderChatRequest['tools'],
  strictTools: boolean
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    ...(strictTools ? { strict: true } : {})
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

  const priorState =
    req.reasoningState?.kind === 'openai_responses' ? req.reasoningState : undefined
  // Omitted thinking means off (compaction callers leave it unset) —
  // match the OpenAI-compat body builder instead of silently paying reasoning tokens.
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
          tools: toResponsesTools(req.tools, req.strictTools !== false),
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
    res = await fetchWithRetry('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`
      },
      signal: req.signal,
      body: JSON.stringify(body)
    })
  } catch (err) {
    if (req.signal.aborted) throw err
    logProviderFailure('openai', 'network', {})
    yield { type: 'error', error: formatError(err) }
    return
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logProviderFailure('openai', 'http', { status: res.status })
    yield { type: 'error', error: formatProviderHttpError(res.status, text, 'openai') }
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
        existing.arguments += delta
        pending.set(callId, existing)
        yield {
          type: 'tool_call_delta',
          toolCallDelta: { index: indexForCall(callId), id: callId, arguments: delta }
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
        yield { type: 'error', error: message }
        return
      }
    }

    if (type === 'response.completed' || type === 'response.done') {
      const details = response?.incomplete_details as Record<string, unknown> | undefined
      // `incomplete_details` is present even on a terminal `completed` frame when the
      // response was cut short, so prefer it over the event name.
      stopReason = normalizeStopReason(details?.reason) ?? stopReason ?? 'stop'
      const usage = response?.usage as Record<string, unknown> | undefined
      if (usage) {
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
        lastUsage = {
          inputTokens:
            typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
          outputTokens:
            typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
          totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
          cachedInputTokens,
          reasoningTokens:
            outputDetails && typeof outputDetails.reasoning_tokens === 'number'
              ? outputDetails.reasoning_tokens
              : undefined
        }
      }
    }
  }

  if (thinkingText && !thinkingDoneEmitted) yield { type: 'thinking_done', text: thinkingText }

  // Flush tool calls that only received argument deltas (no output_item.done).
  for (const [callId, call] of pending) {
    if (yieldedToolCalls.has(callId) || !call.name) continue
    yield { type: 'tool_call', toolCall: call }
  }

  yield {
    type: 'done',
    usage: lastUsage,
    stopReason,
    malformedChunks: drops.dropped || undefined,
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
