import type {
  LlmProvider,
  ListModelsRequest,
  ProviderChatRequest,
  StreamChunk
} from './types'
import type { ModelInfo } from '../../../shared/ipc'
import { createOpenAiCompatibleProvider } from './openai'
import { streamOpenAiResponses } from './openaiResponses'
import { streamAnthropicMessages } from './anthropic'
import {
  normalizeOpenCodeGoModelId,
  opencodeGoTransportFor,
  withOpenCodeGoMeta,
  type OpenCodeTransport
} from '../../../shared/domain/opencodeGoModels'

const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1'

const opencodeChat = createOpenAiCompatibleProvider('opencode', {
  defaultBaseUrl: OPENCODE_GO_BASE
})

/** Endpoint family for a model id — shared with reasoning/thinking wiring. */
export function opencodeEndpointFor(model: string): OpenCodeTransport {
  return opencodeGoTransportFor(model)
}

function mergeGoMeta(m: ModelInfo): ModelInfo {
  const bare: ModelInfo = { ...m, id: normalizeOpenCodeGoModelId(m.id) }
  return withOpenCodeGoMeta(bare)
}

export const opencodeProvider: LlmProvider = {
  id: 'opencode',
  async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    if (!req.apiKey) {
      yield { type: 'error', error: 'OpenCode Go API key not set' }
      return
    }
    const shape = opencodeEndpointFor(req.model)
    if (shape === 'responses') {
      yield* streamOpenAiResponses(req, `${OPENCODE_GO_BASE}/responses`)
      return
    }
    if (shape === 'messages') {
      yield* streamAnthropicMessages(req, `${OPENCODE_GO_BASE}/messages`)
      return
    }
    yield* opencodeChat.streamChat(req)
  },
  async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
    // Errors propagate so listProviderModels surfaces actionable warnings and
    // applies its generic seed fallback instead of failing silently here.
    const live = await opencodeChat.listModels(req)
    return live.map(mergeGoMeta)
  }
}
