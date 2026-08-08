import type { Settings, WorkspaceSettingsOverride } from '../ipc'

export type EffectiveChatSettings = Pick<
  Settings,
  | 'provider'
  | 'model'
  | 'ollamaBaseUrl'
  | 'customOpenAiBaseUrl'
  | 'compactionTriggerRatio'
  | 'keepRecentTurns'
  | 'thinkingEnabled'
  | 'thinkingEffort'
  | 'showThinking'
  | 'toolApproval'
>

export type ChatSettingsPatch = Partial<
  Omit<EffectiveChatSettings, 'provider' | 'model'>
>

/** Merge global settings with optional per-workspace overrides. */
export function resolveEffectiveSettings(
  global: Settings,
  override: WorkspaceSettingsOverride | null | undefined
): EffectiveChatSettings {
  if (!override?.useOverride) {
    return {
      provider: global.provider,
      model: global.model,
      ollamaBaseUrl: global.ollamaBaseUrl,
      customOpenAiBaseUrl: global.customOpenAiBaseUrl,
      compactionTriggerRatio: global.compactionTriggerRatio,
      keepRecentTurns: global.keepRecentTurns,
      thinkingEnabled: global.thinkingEnabled,
      thinkingEffort: global.thinkingEffort,
      showThinking: global.showThinking,
      toolApproval: global.toolApproval
    }
  }
  return {
    provider: override.provider ?? global.provider,
    model: override.model ?? global.model,
    ollamaBaseUrl: global.ollamaBaseUrl,
    customOpenAiBaseUrl: override.customOpenAiBaseUrl ?? global.customOpenAiBaseUrl,
    compactionTriggerRatio: override.compactionTriggerRatio ?? global.compactionTriggerRatio,
    keepRecentTurns: override.keepRecentTurns ?? global.keepRecentTurns,
    thinkingEnabled: override.thinkingEnabled ?? global.thinkingEnabled,
    thinkingEffort: override.thinkingEffort ?? global.thinkingEffort,
    showThinking: override.showThinking ?? global.showThinking,
    toolApproval: override.toolApproval ?? global.toolApproval
  }
}
