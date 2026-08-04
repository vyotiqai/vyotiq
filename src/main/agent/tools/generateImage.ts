import { extname, posix } from 'path'
import type { AgentInteractionMode, Settings } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/ipc'
import { getSettings } from '@main/settings/settings'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '@main/workspace/workspaces'
import { resolveEffectiveSettings } from '../../../shared/effectiveSettings'
import { getWriteCheckpoint } from '../checkpoints'
import { slugPrompt, writeImageOutputs } from './imageOutput'
import {
  applyImagePreset,
  extForMime,
  generateImageBytes,
  getImageGenKey,
  hasImageGenKey,
  isImageGenProviderId,
  normalizeOutputFormat,
  resolveImageGenProvider,
  resolveImageModel,
  resolveModelWithPresetHint,
  type ImageBackground,
  type ImageGenProviderId,
  type ImageOutputFormat,
  type ImagePreset
} from '../providers/imageGen'
import { DEFAULT_IMAGE_MODELS } from '../providers/imageGen/types'

export const GENERATED_IMAGE_DIR = '.vyotiq/generated'

/** Merge global settings with workspace override (same pattern as agent loop). */
export function resolveImageToolSettings(workspacePath: string): Settings {
  const globalSettings = getSettings()
  const override = findWorkspaceSettingsOverride(readWorkspacesState(), workspacePath)
  const effective = resolveEffectiveSettings(globalSettings, override)
  return { ...DEFAULT_SETTINGS, ...globalSettings, ...effective }
}

export type GenerateImageArgs = {
  prompt: string
  path?: string
  provider?: string
  model?: string
  size?: string
  quality?: 'low' | 'medium' | 'high' | 'auto'
  aspect_ratio?: string
  resolution?: string
  /** draft = fast/cheap defaults; final = HQ defaults. Explicit quality/size/etc. win. */
  preset?: ImagePreset
  n?: number
  output_format?: ImageOutputFormat
  output_compression?: number
  background?: ImageBackground
}

export type GenerateImageToolResult = {
  ok: boolean
  summary: string
  content: string
}

/** Live status phases for the image tool card (no partial-image streaming). */
export type ImageToolProgress = (update: {
  kind: 'text' | 'thinking' | 'tool' | 'done'
  text: string
}) => void

export function emitImagePhase(
  onProgress: ImageToolProgress | undefined,
  text: string,
  kind: 'tool' | 'done' = 'tool'
): void {
  onProgress?.({ kind, text })
}

function defaultRelativePath(prompt: string, mimeType?: string): string {
  const ext = extForMime(mimeType ?? 'image/png')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return posix.join(GENERATED_IMAGE_DIR, `${slugPrompt(prompt, 'image')}-${stamp}${ext}`)
}

function normalizeRelativePath(pathArg: string): string {
  return pathArg.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function ensureImageExtension(relPath: string, mimeType: string): string {
  const ext = extname(relPath).toLowerCase()
  if (
    ext === '.png' ||
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.webp' ||
    ext === '.gif' ||
    ext === '.svg'
  ) {
    return relPath
  }
  return `${relPath}${extForMime(mimeType)}`
}

/** Sibling paths for n>1: foo.png → foo-2.png, foo-3.png, … */
export function additionalImagePaths(primaryRel: string, count: number): string[] {
  if (count <= 0) return []
  const ext = extname(primaryRel)
  const base = ext ? primaryRel.slice(0, -ext.length) : primaryRel
  const paths: string[] = []
  for (let i = 2; i < 2 + count; i++) {
    paths.push(`${base}-${i}${ext || '.png'}`)
  }
  return paths
}

function formatDryRun(args: {
  prompt: string
  path: string
  providerId: ImageGenProviderId | null
  model: string | null
  size?: string
  quality?: string
  aspectRatio?: string
  resolution?: string
  preset?: string
  n?: number
  outputFormat?: string
  background?: string
  providerError?: string
}): GenerateImageToolResult {
  const lines = [
    'dry_run: true',
    `path: ${args.path}`,
    `prompt: ${args.prompt}`,
    args.providerId ? `provider: ${args.providerId}` : 'provider: (unresolved)',
    args.model ? `model: ${args.model}` : 'model: (default)',
    args.preset ? `preset: ${args.preset}` : null,
    args.size ? `size: ${args.size}` : null,
    args.quality ? `quality: ${args.quality}` : null,
    args.aspectRatio ? `aspect_ratio: ${args.aspectRatio}` : null,
    args.resolution ? `resolution: ${args.resolution}` : null,
    args.n != null && args.n > 1 ? `n: ${args.n}` : null,
    args.outputFormat ? `output_format: ${args.outputFormat}` : null,
    args.background ? `background: ${args.background}` : null,
    args.providerError ? `note: ${args.providerError}` : null,
    '',
    'Ask/Plan mode: no API call and no file write.',
    'Switch to Agent mode to generate and save the image.'
  ].filter((line): line is string => line != null)

  return {
    ok: true,
    summary: `dry-run ${args.path}`,
    content: lines.join('\n')
  }
}

function formatSuccess(args: {
  path: string
  additionalPaths?: string[]
  providerId: ImageGenProviderId
  model: string
  mimeType: string
  byteLength: number
  prompt: string
  revisedPrompt?: string
  width?: number
  height?: number
  experimentalSize?: boolean
  preset?: string
  moderationPassed?: boolean
}): GenerateImageToolResult {
  const dims =
    args.width && args.height ? `\nwidth: ${args.width}\nheight: ${args.height}` : ''
  const revised = args.revisedPrompt ? `\nrevised_prompt: ${args.revisedPrompt}` : ''
  const extras =
    args.additionalPaths && args.additionalPaths.length > 0
      ? `\nadditional_paths: ${args.additionalPaths.join(', ')}`
      : ''
  const experimental = args.experimentalSize
    ? '\nnote: size is above OpenAI experimental threshold (>2560x1440); results may vary.'
    : ''
  const moderation =
    args.moderationPassed === false ? 'moderationPassed: false' : 'moderationPassed: true'
  return {
    ok: true,
    summary: args.path,
    content: [
      `ok: true`,
      `path: ${args.path}`,
      extras.trimStart(),
      `provider: ${args.providerId}`,
      `model: ${args.model}`,
      args.preset ? `preset: ${args.preset}` : '',
      `mimeType: ${args.mimeType}`,
      `byteLength: ${args.byteLength}`,
      moderation,
      `prompt: ${args.prompt}`,
      dims.trimStart(),
      revised.trimStart(),
      experimental.trimStart()
    ]
      .filter(Boolean)
      .join('\n')
  }
}

/**
 * Generate an image via OpenAI / Gemini / xAI / OpenRouter and write it under the workspace.
 * Ask/Plan: describe-only dry-run (no network, no write).
 */
export async function toolGenerateImage(
  workspaceRoot: string,
  args: GenerateImageArgs,
  options: {
    agentMode: AgentInteractionMode
    signal?: AbortSignal
    runDir?: string
    skipWriteCheckpoint?: boolean
    onProgress?: ImageToolProgress
  }
): Promise<GenerateImageToolResult> {
  const prompt = args.prompt?.trim()
  if (!prompt) {
    return { ok: false, summary: 'error', content: 'generate_image requires a non-empty prompt' }
  }

  const settings = resolveImageToolSettings(workspaceRoot)
  const customBase = { customOpenAiBaseUrl: settings.customOpenAiBaseUrl }
  const outputFormat = normalizeOutputFormat(args.output_format) ?? args.output_format
  const preferredMime = outputFormat ? extForMime(mimeGuess(outputFormat)) : undefined
  const explicitPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null
  const relPath = normalizeRelativePath(
    explicitPath ?? defaultRelativePath(prompt, preferredMime ? mimeGuess(outputFormat!) : undefined)
  )

  emitImagePhase(options.onProgress, 'Resolving image provider…')
  const resolved = resolveImageGenProvider({
    explicit: args.provider,
    settingsProvider: settings.imageProvider === 'auto' ? null : settings.imageProvider,
    chatProvider: settings.provider,
    hasKey: (id) => hasImageGenKey(id, customBase)
  })

  const mode = options.agentMode
  if (mode === 'ask' || mode === 'plan') {
    if ('error' in resolved) {
      emitImagePhase(options.onProgress, 'Dry-run ready (Ask/Plan)', 'done')
      return formatDryRun({
        prompt,
        path: relPath,
        providerId: null,
        model: args.model?.trim() || settings.imageModel?.trim() || null,
        size: args.size,
        quality: args.quality,
        aspectRatio: args.aspect_ratio,
        resolution: args.resolution,
        preset: args.preset,
        n: args.n,
        outputFormat,
        background: args.background,
        providerError: resolved.error
      })
    }
    const applied = applyImagePreset(resolved.providerId, args.preset, {
      quality: args.quality,
      size: args.size,
      aspectRatio: args.aspect_ratio,
      resolution: args.resolution,
      model: args.model
    })
    const model = resolveModelWithPresetHint(
      DEFAULT_IMAGE_MODELS[resolved.providerId],
      applied.modelHint,
      args.model,
      settings.imageModel || null
    )
    emitImagePhase(options.onProgress, 'Dry-run ready (Ask/Plan)', 'done')
    return formatDryRun({
      prompt,
      path: relPath,
      providerId: resolved.providerId,
      model,
      size: applied.size,
      quality: applied.quality,
      aspectRatio: applied.aspectRatio,
      resolution: applied.resolution,
      preset: args.preset,
      n: args.n,
      outputFormat,
      background: args.background
    })
  }

  if ('error' in resolved) {
    return {
      ok: false,
      summary: 'error',
      content: `${resolved.error} Set Settings → Providers (image provider / API key), or pass provider=openai|google|… when a key is configured.`
    }
  }

  const apiKey = getImageGenKey(resolved.providerId, customBase)
  if (apiKey == null) {
    return {
      ok: false,
      summary: 'error',
      content: `No API key configured for image provider "${resolved.providerId}". Add it in Settings → Providers, or set imageProvider to a provider that has a key.`
    }
  }

  const applied = applyImagePreset(resolved.providerId, args.preset, {
    quality: args.quality,
    size: args.size,
    aspectRatio: args.aspect_ratio,
    resolution: args.resolution,
    model: args.model
  })
  const model = resolveModelWithPresetHint(
    resolveImageModel(resolved.providerId, null, settings.imageModel || null),
    applied.modelHint,
    args.model,
    settings.imageModel || null
  )

  emitImagePhase(options.onProgress, `Calling ${resolved.providerId} (${model})…`)
  const gen = await generateImageBytes(
    resolved.providerId,
    apiKey,
    {
      prompt,
      model,
      size: applied.size,
      quality: applied.quality,
      aspectRatio: applied.aspectRatio,
      resolution: applied.resolution,
      n: args.n,
      outputFormat,
      outputCompression: args.output_compression,
      background: args.background,
      signal: options.signal,
      openAiBaseUrl: settings.customOpenAiBaseUrl
    },
    null
  )

  if (!gen.ok) {
    return { ok: false, summary: 'error', content: gen.error }
  }

  const outRel = ensureImageExtension(relPath, gen.mimeType)
  const extraRels = additionalImagePaths(outRel, gen.additionalImages?.length ?? 0)
  const allRels = [outRel, ...extraRels]

  if (!options.skipWriteCheckpoint) {
    for (const p of allRels) {
      getWriteCheckpoint(options.runDir)?.recordPrior(p, 'write')
    }
  }

  emitImagePhase(options.onProgress, `Writing ${outRel}…`)
  const extras = extraRels.flatMap((relPath, i) => {
    const bytes = gen.additionalImages?.[i]?.bytes
    return bytes ? [{ relPath, bytes }] : []
  })
  const write = writeImageOutputs(workspaceRoot, { relPath: outRel, bytes: gen.bytes }, extras)
  if (!write.ok) {
    return { ok: false, summary: 'error', content: write.error }
  }

  emitImagePhase(options.onProgress, `Saved ${outRel}`, 'done')
  return formatSuccess({
    path: outRel,
    additionalPaths: extraRels,
    providerId: gen.providerId,
    model: gen.model,
    mimeType: gen.mimeType,
    byteLength: gen.bytes.length,
    prompt,
    revisedPrompt: gen.revisedPrompt,
    width: gen.width,
    height: gen.height,
    experimentalSize: gen.experimentalSize,
    preset: args.preset,
    moderationPassed: gen.moderationPassed
  })
}

function mimeGuess(format: ImageOutputFormat): string {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'svg') return 'image/svg+xml'
  return 'image/png'
}

export function parseGenerateImageProviderArg(raw: unknown): ImageGenProviderId | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim().toLowerCase()
  return isImageGenProviderId(id) ? id : undefined
}
