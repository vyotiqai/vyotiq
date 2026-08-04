import type { ChatMessage, ModelInfo, ProviderId } from '../../../shared/ipc'
import type { ProviderReasoningState, ThinkingConfig } from '../../../shared/reasoning'
import type { ServiceTier } from '../../../shared/ipc/schemas/providers'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** Input tokens served from provider prompt cache (OpenAI, DeepSeek, Groq, Anthropic, Gemini). */
  cachedInputTokens?: number
  /** Input tokens written into the prompt cache this step (Anthropic cache_creation). */
  cacheCreationInputTokens?: number
  /** Reasoning / thinking tokens billed as output (provider-specific). */
  reasoningTokens?: number
}

/**
 * Why the provider stopped generating. `length` means the output token limit cut
 * the turn short, which is otherwise indistinguishable from a clean finish.
 */
export type StopReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown'

export interface StreamChunk {
  type:
    | 'text'
    | 'thinking_delta'
    | 'thinking_done'
    | 'tool_call_delta'
    | 'tool_call'
    | 'done'
    | 'error'
  text?: string
  toolCall?: ToolCall
  toolCallDelta?: { index: number; id?: string; name?: string; arguments?: string }
  error?: string
  /** Structured failure code for `error` chunks (e.g. PROVIDER_HTTP vs PROVIDER_STREAM). */
  errorCode?: string
  usage?: TokenUsage
  /** Anthropic server-side compaction summary (not user-visible assistant text). */
  compaction?: string
  /** Provider reasoning replay state captured during the stream. */
  reasoningState?: ProviderReasoningState
  /** Set on `done` chunks so the loop can tell a truncated turn from a finished one. */
  stopReason?: StopReason
  /** Count of SSE frames dropped because they were not parseable JSON. */
  malformedChunks?: number
}

export interface ListModelsRequest {
  apiKey?: string | null
  baseUrl?: string
  signal?: AbortSignal
}

export interface ResponseFormat {
  type: 'json_schema'
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

export interface ProviderChatRequest {
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  system?: string
  /**
   * Stable/volatile system split for prompt caching.
   * - Anthropic: stable gets `cache_control`; volatile is unmarked in system blocks.
   * - OpenAI-compat / Gemini / DeepSeek: stable is the leading system/developer
   *   instruction; volatile is appended *after* history so the clock/snapshot do
   *   not bust the cacheable tools+system+history prefix.
   * When set, preferred over a single combined `system` string.
   */
  systemStable?: string
  systemVolatile?: string
  signal: AbortSignal
  apiKey?: string | null
  baseUrl?: string
  /** Optional max output tokens from model metadata. */
  maxOutputTokens?: number
  /** Anthropic-native context management / caching. */
  anthropicNative?: {
    enableContextManagement: boolean
    clearToolUsesKeep: number
    compactTriggerTokens?: number
    /** Server clear_tool_uses input_tokens trigger (Anthropic context editing). */
    clearToolUsesTriggerTokens?: number
    /** Min tokens cleared per activation — avoids cache-busting micro-clears. */
    clearToolUsesAtLeastTokens?: number
    /** Tool names whose uses/results are never server-cleared. */
    clearToolUsesExcludeTools?: string[]
  }
  responseFormat?: ResponseFormat
  toolChoice?: 'auto' | 'none' | 'required'
  parallelToolCalls?: boolean
  /** When tools are present, default true. */
  strictTools?: boolean
  /** OpenAI prompt-cache routing key (stable per run). */
  promptCacheKey?: string
  /** Extended thinking configuration from user settings. */
  thinking?: ThinkingConfig
  /** Prior-step reasoning replay state for multi-turn tool loops. */
  reasoningState?: ProviderReasoningState
  /** Resolved model metadata for routing (Responses vs Completions, etc.). */
  modelInfo?: ModelInfo
  /** API service tier (`flex` / `priority`). UI labels `priority` as Fast (OpenAI Fast mode). */
  serviceTier?: ServiceTier
}

export interface LlmProvider {
  id: ProviderId
  streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk>
  listModels(req: ListModelsRequest): Promise<ModelInfo[]>
}
