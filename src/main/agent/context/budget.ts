import type { ModelInfo } from '../../../shared/ipc'
import { knownContextWindow } from '../../../shared/domain/modelContextWindows'
import {
  allocateBudgetShares,
  contentWindowFromRaw,
  compactionTriggerFromRaw,
  toolsBudgetFromRaw,
  DEFAULT_CONTEXT_WINDOW,
  type BudgetLayerShares
} from '../../../shared/domain/contextBudget'
import { COMPACTION_TRIGGER_RATIO } from './types'
import type { BudgetLayers } from './types'

export function contextWindowFor(model: ModelInfo): number {
  if (model.contextWindow && model.contextWindow > 0) return model.contextWindow
  return knownContextWindow(model.id) ?? DEFAULT_CONTEXT_WINDOW
}

export function allocateBudget(model: ModelInfo): Record<keyof BudgetLayers, number> {
  return allocateBudgetShares(contextWindowFor(model)) as Record<keyof BudgetLayerShares, number>
}

export function effectiveWindow(model: ModelInfo): number {
  return contentWindowFromRaw(contextWindowFor(model))
}

/**
 * Window available for content after reserving the buffer layer.
 * Equals the non-buffer budget shares (85% of the raw model window).
 */
export function contentWindow(model: ModelInfo): number {
  return effectiveWindow(model)
}

export function compactionTriggerTokens(
  model: ModelInfo,
  triggerRatio = COMPACTION_TRIGGER_RATIO
): number {
  return compactionTriggerFromRaw(contextWindowFor(model), triggerRatio)
}

/** Soft-capped tools budget for provider catalogs (not the raw 18% share). */
export function toolsBudgetTokens(model: ModelInfo): number {
  return toolsBudgetFromRaw(contextWindowFor(model))
}
