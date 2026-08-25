import type { ComponentType, CSSProperties } from 'react'
import Anthropic from '@lobehub/icons/es/Anthropic/components/Mono'
import { COLOR_PRIMARY as AnthropicColor } from '@lobehub/icons/es/Anthropic/style'
import Arcee from '@lobehub/icons/es/Arcee/components/Mono'
import { COLOR_PRIMARY as ArceeColor } from '@lobehub/icons/es/Arcee/style'
import Cohere from '@lobehub/icons/es/Cohere/components/Mono'
import { COLOR_PRIMARY as CohereColor } from '@lobehub/icons/es/Cohere/style'
import DeepSeek from '@lobehub/icons/es/DeepSeek/components/Mono'
import { COLOR_PRIMARY as DeepSeekColor } from '@lobehub/icons/es/DeepSeek/style'
import Gemini from '@lobehub/icons/es/Gemini/components/Mono'
import { COLOR_PRIMARY as GeminiColor } from '@lobehub/icons/es/Gemini/style'
import Google from '@lobehub/icons/es/Google/components/Mono'
import { COLOR_PRIMARY as GoogleColor } from '@lobehub/icons/es/Google/style'
import Groq from '@lobehub/icons/es/Groq/components/Mono'
import { COLOR_PRIMARY as GroqColor } from '@lobehub/icons/es/Groq/style'
import Meta from '@lobehub/icons/es/Meta/components/Mono'
import { COLOR_PRIMARY as MetaColor } from '@lobehub/icons/es/Meta/style'
import Microsoft from '@lobehub/icons/es/Microsoft/components/Mono'
import { COLOR_PRIMARY as MicrosoftColor } from '@lobehub/icons/es/Microsoft/style'
import Mistral from '@lobehub/icons/es/Mistral/components/Mono'
import { COLOR_PRIMARY as MistralColor } from '@lobehub/icons/es/Mistral/style'
import Nvidia from '@lobehub/icons/es/Nvidia/components/Mono'
import { COLOR_PRIMARY as NvidiaColor } from '@lobehub/icons/es/Nvidia/style'
import Ollama from '@lobehub/icons/es/Ollama/components/Mono'
import { COLOR_PRIMARY as OllamaColor } from '@lobehub/icons/es/Ollama/style'
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono'
import { COLOR_PRIMARY as OpenCodeColor } from '@lobehub/icons/es/OpenCode/style'
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono'
import { COLOR_PRIMARY as OpenAIColor } from '@lobehub/icons/es/OpenAI/style'
import OpenRouter from '@lobehub/icons/es/OpenRouter/components/Mono'
import { COLOR_PRIMARY as OpenRouterColor } from '@lobehub/icons/es/OpenRouter/style'
import Perplexity from '@lobehub/icons/es/Perplexity/components/Mono'
import { COLOR_PRIMARY as PerplexityColor } from '@lobehub/icons/es/Perplexity/style'
import Qwen from '@lobehub/icons/es/Qwen/components/Mono'
import { COLOR_PRIMARY as QwenColor } from '@lobehub/icons/es/Qwen/style'
import XAI from '@lobehub/icons/es/XAI/components/Mono'
import { COLOR_PRIMARY as XAIColor } from '@lobehub/icons/es/XAI/style'

export type ProviderBrandData = {
  Component: ComponentType<{
    size?: number | string
    style?: CSSProperties
    className?: string
  }>
  colorPrimary: string
}

export type ProviderBrandSlug = keyof typeof PROVIDER_BRAND_DATA

export const PROVIDER_BRAND_DATA = {
  anthropic: { Component: Anthropic, colorPrimary: AnthropicColor },
  arcee: { Component: Arcee, colorPrimary: ArceeColor },
  cohere: { Component: Cohere, colorPrimary: CohereColor },
  deepseek: { Component: DeepSeek, colorPrimary: DeepSeekColor },
  gemini: { Component: Gemini, colorPrimary: GeminiColor },
  google: { Component: Google, colorPrimary: GoogleColor },
  groq: { Component: Groq, colorPrimary: GroqColor },
  meta: { Component: Meta, colorPrimary: MetaColor },
  microsoft: { Component: Microsoft, colorPrimary: MicrosoftColor },
  mistral: { Component: Mistral, colorPrimary: MistralColor },
  nvidia: { Component: Nvidia, colorPrimary: NvidiaColor },
  ollama: { Component: Ollama, colorPrimary: OllamaColor },
  opencode: { Component: OpenCode, colorPrimary: OpenCodeColor },
  openai: { Component: OpenAI, colorPrimary: OpenAIColor },
  openrouter: { Component: OpenRouter, colorPrimary: OpenRouterColor },
  perplexity: { Component: Perplexity, colorPrimary: PerplexityColor },
  qwen: { Component: Qwen, colorPrimary: QwenColor },
  xai: { Component: XAI, colorPrimary: XAIColor }
} as const satisfies Record<string, ProviderBrandData>

export const PROVIDER_BRAND_ALIASES: Record<string, ProviderBrandSlug> = {
  'meta-llama': 'meta',
  'x-ai': 'xai'
}

export function resolveProviderBrandSlug(key: string): ProviderBrandSlug | undefined {
  const normalized = key.toLowerCase()
  if (normalized in PROVIDER_BRAND_DATA) return normalized as ProviderBrandSlug
  return PROVIDER_BRAND_ALIASES[normalized]
}
