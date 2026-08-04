import type { ImageGenProviderId } from './types'

export type ImagePreset = 'draft' | 'final'

export type ImageRequestFields = {
  quality?: 'low' | 'medium' | 'high' | 'auto'
  size?: string
  aspectRatio?: string
  resolution?: string
  /** Explicit tool/settings model; preset may fill a speed/quality default when empty. */
  model?: string | null
}

export type AppliedImagePreset = ImageRequestFields & {
  preset: ImagePreset
  /** Model hint applied only when caller had no explicit model. */
  modelHint?: string
}

const XAI_SPEED_MODEL = 'grok-imagine-image'
const XAI_QUALITY_MODEL = 'grok-imagine-image-quality'

/**
 * Expand `draft` | `final` into provider-aware defaults without overriding explicit fields.
 */
export function applyImagePreset(
  providerId: ImageGenProviderId,
  preset: ImagePreset | undefined,
  fields: ImageRequestFields
): AppliedImagePreset {
  if (!preset) {
    return { ...fields, preset: 'final' }
  }

  const out: AppliedImagePreset = {
    ...fields,
    preset,
    quality: fields.quality,
    size: fields.size,
    aspectRatio: fields.aspectRatio,
    resolution: fields.resolution,
    model: fields.model
  }

  if (preset === 'draft') {
    if ((providerId === 'openai' || providerId === 'custom') && !out.quality) {
      out.quality = 'low'
    }
    if (providerId === 'gemini' && !out.resolution) out.resolution = '1K'
    if (providerId === 'openrouter') {
      if (!out.quality) out.quality = 'low'
      if (!out.resolution) out.resolution = '1K'
    }
    if (providerId === 'xai') {
      if (!out.resolution) out.resolution = '1k'
      if (!fields.model?.trim()) {
        out.modelHint = XAI_SPEED_MODEL
      }
    }
    return out
  }

  // final
  if ((providerId === 'openai' || providerId === 'custom') && !out.quality) {
    out.quality = 'high'
  }
  if (providerId === 'gemini' && !out.resolution) out.resolution = '2K'
  if (providerId === 'openrouter') {
    if (!out.quality) out.quality = 'high'
    if (!out.resolution) out.resolution = '2K'
  }
  if (providerId === 'xai') {
    if (!out.resolution) out.resolution = '2k'
    if (!fields.model?.trim()) {
      out.modelHint = XAI_QUALITY_MODEL
    }
  }
  return out
}

export function resolveModelWithPresetHint(
  resolvedDefault: string,
  modelHint: string | undefined,
  explicitModel: string | null | undefined,
  settingsModel: string | null | undefined
): string {
  if (explicitModel?.trim()) return explicitModel.trim()
  if (settingsModel?.trim()) return settingsModel.trim()
  if (modelHint?.trim()) return modelHint.trim()
  return resolvedDefault
}
