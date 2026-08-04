import { getSettings } from '@main/settings/settings'
import { getSecret } from '@main/settings/secrets'
import { resolveProviderChatBaseUrl } from '../../shared/providers'
import { getProvider } from './providers'
import { runHarnessReview, type WeaknessSummary } from './harnessReview'
import { rewriteHarnessProposalBody } from './harnessRewrite'
import type { HarnessReviewResult } from '../../shared/ipc'

/** Run harness review using current settings (optional LLM rewriter). */
export async function runHarnessReviewWithSettings(
  workspacePath: string,
  opts?: { limit?: number }
): Promise<HarnessReviewResult> {
  const settings = getSettings()
  const rewriteBody = settings.harnessProposalRewriter
    ? async ({
        currentHarness,
        summary
      }: {
        currentHarness: string
        summary: WeaknessSummary
      }) => {
        const provider = getProvider(settings.provider)
        const apiKey = getSecret(settings.provider)
        const baseUrl = resolveProviderChatBaseUrl(settings.provider, settings, apiKey)
        return rewriteHarnessProposalBody({
          currentHarness,
          summary,
          provider,
          model: settings.model,
          apiKey,
          baseUrl
        })
      }
    : undefined

  return runHarnessReview(workspacePath, {
    limit: opts?.limit,
    rewriteBody
  })
}
