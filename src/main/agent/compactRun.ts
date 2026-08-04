import type { ChatMessage, CompactRunResult, ProviderId } from '../../shared/ipc'
import { providerNeedsKey, resolveProviderChatBaseUrl } from '../../shared/domain/providers'
import { DEFAULT_SETTINGS } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { resolveEffectiveSettings } from '../../shared/effectiveSettings'
import { getSecret, hasStoredSecretBlob, secretStatus } from '@main/settings/secrets'
import { getSettings } from '@main/settings/settings'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '@main/workspace/workspaces'
import { allocateBudget, contentWindow, contextWindowFor } from './context/budget'
import { compactMessages, preserveRecentMessagesAsync } from './context/compact'
import { estimateMessagesTokensAsync } from './context/estimate'
import { applyFoldedMessagesWatermark } from './context/historyTrim'
import { isTrimWatermarkCompaction, KEEP_RECENT_TURNS } from './context/types'
import { resolveModelInfo } from './modelResolve'
import { getProvider } from './providers'
import { loadCompaction, loadMessages, runExists, saveCompaction } from './state'
import { resolveRunDir } from '@main/storage/paths'

/** A manual compaction should not hang the UI on an unresponsive provider. */
const COMPACT_TIMEOUT_MS = 120_000

/** Below this there is nothing meaningful to summarize. */
const MIN_MESSAGES_TO_COMPACT = 4

export class CompactionUnavailableError extends Error {}

/**
 * Summarize a run's history on demand. Unlike automatic compaction this ignores
 * the trigger threshold, but it still only folds the prefix — the recent turns
 * the user is actively working with stay verbatim.
 */
export async function compactRunNow(input: {
  workspacePath: string
  runId: string
}): Promise<CompactRunResult> {
  if (!runExists(input.workspacePath, input.runId)) {
    throw new CompactionUnavailableError('Run not found')
  }
  const runDir = resolveRunDir(input.workspacePath, input.runId)

  const globalSettings = getSettings()
  const override = findWorkspaceSettingsOverride(readWorkspacesState(), input.workspacePath)
  const settings = {
    ...DEFAULT_SETTINGS,
    ...globalSettings,
    ...resolveEffectiveSettings(globalSettings, override)
  }

  const providerId: ProviderId = settings.provider
  const apiKey = getSecret(providerId)
  const baseUrl = resolveProviderChatBaseUrl(providerId, settings, apiKey)
  if (providerNeedsKey(providerId, baseUrl ?? settings.ollamaBaseUrl) && !apiKey) {
    const status = secretStatus()
    const storedBlob = hasStoredSecretBlob(providerId)
    const message = !status.encryptionAvailable
      ? 'OS secure storage is unavailable. API keys cannot be decrypted on this system.'
      : storedBlob
        ? `API key for ${providerId} is stored but cannot be decrypted. Re-enter it in Settings or restore OS keychain access.`
        : `API key for ${providerId} is not set.`
    throw new CompactionUnavailableError(message)
  }

  const existing = loadCompaction(runDir)
  const folded = existing?.foldedMessages ?? 0
  const all = loadMessages(input.workspacePath, input.runId)
  // Same watermark helper as resume — avoids orphan leading tool rows.
  const applied = applyFoldedMessagesWatermark(all, folded)
  const working = applied.messages
  const baseFolded = applied.foldedMessages

  if (working.length < MIN_MESSAGES_TO_COMPACT) {
    throw new CompactionUnavailableError('Not enough history to compact yet.')
  }

  const keepRecent = settings.keepRecentTurns ?? KEEP_RECENT_TURNS
  const signal = AbortSignal.timeout(COMPACT_TIMEOUT_MS)
  const provider = getProvider(providerId)
  const model = await resolveModelInfo(providerId, settings.model, apiKey, baseUrl, signal)

  const kept = await preserveRecentMessagesAsync(
    working,
    keepRecent,
    allocateBudget(model).history,
    model
  )
  const toSummarize = working.slice(0, working.length - kept.length)
  if (!toSummarize.length) {
    throw new CompactionUnavailableError(
      'All of the current history is recent enough to keep verbatim.'
    )
  }

  const record = await compactMessages({
    provider,
    model: model.id,
    apiKey,
    baseUrl,
    signal,
    messages: toSummarize.map(({ thinking: _thinking, ...rest }) => rest),
    supportsStructuredOutput: model.supportsStructuredOutput,
    contextWindow: contentWindow(model),
    priorSummary: isTrimWatermarkCompaction(existing) ? undefined : existing?.summary
  })

  if (!record) throw new CompactionUnavailableError('The model returned no summary.')

  const foldedMessages = baseFolded + toSummarize.length
  const compactionRecord = { ...record, foldedMessages }
  if (!saveCompaction(runDir, compactionRecord)) {
    throw new CompactionUnavailableError('Failed to persist compaction record.')
  }

  logger.info('Manual compaction complete', {
    scope: 'agent',
    correlationId: input.runId,
    provider: providerId,
    messagesBefore: working.length,
    keptMessages: kept.length
  })

  const remainingEstimate =
    (await estimateMessagesTokensAsync(kept, model)) + (record.tokenEstimate ?? 0)

  return {
    summary: record.summary,
    tokenEstimate: record.tokenEstimate,
    keptMessages: kept.length,
    messagesBefore: working.length,
    estimatedTokens: remainingEstimate,
    contextWindow: contextWindowFor(model),
    contentWindow: contentWindow(model)
  }
}
