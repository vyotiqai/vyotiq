import type { ProviderId } from '../../../shared/ipc'

type ProviderErrorJson = {
  error?: {
    message?: string
    code?: unknown
    metadata?: { raw?: unknown; provider_name?: unknown }
  }
  message?: string
}

function parseProviderErrorMessage(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as ProviderErrorJson
    const outer =
      typeof parsed.error?.message === 'string' && parsed.error.message.trim()
        ? parsed.error.message.trim()
        : typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message.trim()
          : undefined

    // OpenRouter often wraps upstream failures as "Provider returned error"
    // with the real message nested in error.metadata.raw (JSON string).
    const raw = parsed.error?.metadata?.raw
    if (typeof raw === 'string' && raw.trim()) {
      const nested = parseProviderErrorMessage(raw)
      if (nested && nested !== outer) return nested
      if (!outer || /^provider returned error$/i.test(outer)) {
        return nested ?? raw.trim().slice(0, 280)
      }
    }

    return outer
  } catch {
    return undefined
  }
}

/** OpenRouter 402 bodies include "can only afford N" when max_tokens exceeds credit budget. */
export function parseOpenRouterAffordableOutputTokens(body: string): number | undefined {
  const match = /can only afford (\d+)/i.exec(body)
  if (!match) return undefined
  const n = Number(match[1])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

const OPENROUTER_NO_ENDPOINTS_RE =
  /no endpoints?\s+(?:available\s+)?(?:found\s+)?matching|guardrail restrictions|data policy|routing requirements/i

/** True when OpenRouter reports zero matching endpoints (privacy/guardrails/params). */
export function isOpenRouterNoEndpointsError(status: number, body: string): boolean {
  if (status !== 404 && status !== 400) return false
  const message = parseProviderErrorMessage(body) ?? body
  return OPENROUTER_NO_ENDPOINTS_RE.test(message)
}

/**
 * Whether OpenRouter/OpenAI-compat should strip strict tools then reasoning and retry.
 * Always for HTTP 400; for 404 only when the body looks like a no-endpoints routing miss.
 */
export function shouldRetryOpenRouterCompatBody(status: number, body: string): boolean {
  if (status === 400) return true
  if (status === 404) return isOpenRouterNoEndpointsError(status, body)
  return false
}

const INCLUDE_USAGE_REJECT_RE =
  /stream_options|include_usage|unknown.*(field|parameter|property).*usage|extra.*(field|input|property).*stream_options/i

/**
 * Hosts (Mistral clones, older gateways) reject OpenAI `stream_options.include_usage`.
 * Retry once without that field when the 400/422 body points at it.
 */
export function shouldRetryOmitIncludeUsage(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false
  const message = parseProviderErrorMessage(body) ?? body
  return INCLUDE_USAGE_REJECT_RE.test(message)
}

const PROMPT_CACHE_KEY_REJECT_RE =
  /prompt[_-]?cache[_-]?key|unknown.*(field|parameter|property).*cache|extra.*(field|input|property).*cache/i

/**
 * Some OpenAI-compat hosts reject the OpenAI `prompt_cache_key` cache-affinity
 * field (GLM-family OpenCode Go models are known to reject cache instrumentation).
 * Retry once without the field when the 400/422 body points at it — the field is
 * inert for hosts that ignore it, so the retry only fires on real rejection.
 */
export function shouldRetryOmitCacheKey(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false
  const message = parseProviderErrorMessage(body) ?? body
  return PROMPT_CACHE_KEY_REJECT_RE.test(message)
}

const PROVIDER_SECRET_RE =
  /\b(?:sk-[a-zA-Z0-9_-]+|Bearer\s+[a-zA-Z0-9._/=+-]+|api[_-]?key["\s:=]+[a-zA-Z0-9._-]+)/gi

/** OpenAI often echoes a masked key fragment: "Incorrect API key provided: abcd…wxyz". */
const INCORRECT_API_KEY_RE =
  /Incorrect API key provided:\s*[A-Za-z0-9*_./+=-]{6,}/gi

/** Redact common provider secret shapes from error text. */
export function scrubProviderErrorText(text: string): string {
  return text
    .replace(INCORRECT_API_KEY_RE, 'Incorrect API key provided: [redacted]')
    .replace(PROVIDER_SECRET_RE, '[redacted]')
    .slice(0, 280)
}

/** Scrubbed ≤280-char snippet for logs / UI (no API keys). */
export function scrubProviderErrorSnippet(body: string): string {
  const formatted = parseProviderErrorMessage(body) ?? body.trim()
  return scrubProviderErrorText(formatted)
}

export function formatProviderHttpError(
  status: number,
  body: string,
  providerId?: ProviderId
): string {
  const providerMessage = parseProviderErrorMessage(body)
  const affordable = providerId === 'openrouter' ? parseOpenRouterAffordableOutputTokens(body) : undefined
  const scrubbedMessage = providerMessage ? scrubProviderErrorText(providerMessage) : undefined

  if (status === 402) {
    if (providerId === 'openrouter') {
      if (affordable) {
        return `OpenRouter credits are insufficient for the requested output budget. Add credits at https://openrouter.ai/settings/credits or retry with a lower output limit (balance covers ~${affordable.toLocaleString()} output tokens).`
      }
      return (
        scrubbedMessage ??
        'OpenRouter credits are insufficient for this request. Add credits at https://openrouter.ai/settings/credits.'
      )
    }
    if (providerId === 'custom') {
      return (
        scrubbedMessage ??
        'Insufficient credits on this custom OpenAI-compatible host for the request. Check your gateway balance or lower the output limit.'
      )
    }
    return scrubbedMessage ?? 'Insufficient provider credits for this request.'
  }

  if (
    providerId === 'openrouter' &&
    isOpenRouterNoEndpointsError(status, body)
  ) {
    return scrubProviderErrorText(
      'No OpenRouter endpoints match your privacy/guardrail settings for this model. Adjust https://openrouter.ai/settings/privacy (or try another model). Thinking or strict tool requirements can also shrink available endpoints.'
    )
  }

  if (status === 401 || status === 403) {
    if (providerId === 'openai' && status === 401) {
      return 'OpenAI authentication failed (HTTP 401). Update your API key in Settings → Providers.'
    }
    return (
      scrubbedMessage ??
      `Authentication failed (HTTP ${status}). Check your API key in Settings → Providers.`
    )
  }

  if (status === 429) {
    return scrubbedMessage ?? 'Rate limited (HTTP 429). Wait a moment and try again.'
  }

  if (scrubbedMessage) return scrubbedMessage

  const snippet = scrubProviderErrorText(body.trim())
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`
}
