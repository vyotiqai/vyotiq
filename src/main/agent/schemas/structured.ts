import type { LlmProvider, ProviderChatRequest } from '../providers/types'

export type StructuredParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error?: string }

export async function collectStructuredResponse<T>(
  provider: LlmProvider,
  req: ProviderChatRequest & {
    responseFormat: NonNullable<ProviderChatRequest['responseFormat']>
  },
  parse: (raw: string) => StructuredParseResult<T>
): Promise<
  | { ok: true; data: T; rawText: string }
  | { ok: false; rawText: string; error: string }
> {
  let rawText = ''
  for await (const chunk of provider.streamChat(req)) {
    if (req.signal.aborted) {
      return { ok: false, rawText, error: 'Request aborted' }
    }
    if (chunk.type === 'text' && chunk.text) rawText += chunk.text
    if (chunk.type === 'error') {
      return { ok: false, rawText, error: chunk.error ?? 'Provider error' }
    }
  }

  rawText = rawText.trim()
  const parsed = parse(rawText)
  if (parsed.ok) return { ok: true, data: parsed.data, rawText }
  return { ok: false, rawText, error: parsed.error ?? 'Failed to parse structured response' }
}
