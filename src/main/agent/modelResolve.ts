import type { ModelInfo, ProviderId } from '../../shared/ipc'
import {
  knownContextWindow,
  withResolvedContextWindow
} from '../../shared/domain/modelContextWindows'
import { seedModelsFor } from '../../shared/providers'
import { baseModelInfo } from './providers/normalize'
import { listProviderModels } from './providers'

/**
 * Resolve model metadata, falling back to seeds and finally to conservative
 * defaults so an unlisted model still runs instead of failing the turn.
 *
 * Live catalogs that omit `context_length` are backfilled from known windows /
 * seeds before the 128k default — otherwise DeepSeek (and similar) silently
 * budget against the wrong window.
 */
export async function resolveModelInfo(
  providerId: ProviderId,
  modelId: string,
  apiKey: string | null,
  baseUrl: string | undefined,
  signal: AbortSignal
): Promise<ModelInfo> {
  const listed = await listProviderModels({
    provider: providerId,
    apiKey,
    baseUrl,
    signal
  })
  const found = listed.models.find((m) => m.id === modelId)
  if (found) {
    const enriched = withResolvedContextWindow(found, providerId)
    if (enriched.contextWindow != null && enriched.contextWindow > 0) return enriched
    const seed = seedModelsFor(providerId).find((m) => m.id === modelId)
    if (seed?.contextWindow != null && seed.contextWindow > 0) {
      return { ...enriched, contextWindow: seed.contextWindow }
    }
    return enriched
  }
  const seed = seedModelsFor(providerId).find((m) => m.id === modelId)
  if (seed) return withResolvedContextWindow(seed, providerId)
  return baseModelInfo(
    modelId,
    {
      contextWindow: knownContextWindow(modelId, providerId) ?? 128_000,
      supportsTools: providerId !== 'ollama' || /tool|coder|qwen|llama3|mistral/i.test(modelId)
    },
    providerId
  )
}
