import type { UiToolRow } from '@shared/transcript'

export type GenerateImageCardData = {
  path: string
  provider?: string
  model?: string
  mimeType?: string
  byteLength?: number
  dryRun: boolean
  prompt?: string
  revisedPrompt?: string
  action?: string
  references?: string
  maskPath?: string
  body: string
}

function metaLine(content: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'im')
  const m = re.exec(content)
  return m?.[1]?.trim() || undefined
}

export function parseGenerateImageData(tool: UiToolRow): GenerateImageCardData {
  const content = (tool.content ?? '').trim()
  const dryRun = /^dry_run:\s*true\b/im.test(content) || /^dry-run\b/i.test(tool.summary ?? '')
  const path =
    metaLine(content, 'path') ||
    (tool.summary && !/^error$/i.test(tool.summary) && !/^dry-run\b/i.test(tool.summary)
      ? tool.summary.replace(/^dry-run\s+/i, '').trim()
      : '') ||
    ''

  return {
    path,
    provider: metaLine(content, 'provider'),
    model: metaLine(content, 'model'),
    mimeType: metaLine(content, 'mimeType'),
    byteLength: (() => {
      const raw = metaLine(content, 'byteLength')
      if (!raw) return undefined
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    })(),
    dryRun,
    prompt: metaLine(content, 'prompt'),
    revisedPrompt: metaLine(content, 'revised_prompt'),
    action: metaLine(content, 'action'),
    references: metaLine(content, 'reference_paths'),
    maskPath: metaLine(content, 'mask_path'),
    body: content
  }
}
