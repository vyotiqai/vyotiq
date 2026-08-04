import { describe, expect, it } from 'vitest'
import { parseGenerateImageData } from '@renderer/features/chat/toolUi/parsers/generateImage'
import type { UiToolRow } from '@shared/transcript'

function row(partial: Partial<UiToolRow> & { content: string }): UiToolRow {
  return {
    id: 't1',
    name: 'generate_image',
    status: 'done',
    summary: 'assets/out.png',
    ...partial
  } as UiToolRow
}

describe('parseGenerateImageData', () => {
  it('parses prompt and revised_prompt on success', () => {
    const data = parseGenerateImageData(
      row({
        content: [
          'ok: true',
          'path: assets/out.png',
          'provider: openai',
          'model: gpt-image-2',
          'mimeType: image/png',
          'byteLength: 12',
          'moderationPassed: true',
          'prompt: a red cube',
          'revised_prompt: a vivid red cube on white'
        ].join('\n')
      })
    )
    expect(data.path).toBe('assets/out.png')
    expect(data.prompt).toBe('a red cube')
    expect(data.revisedPrompt).toBe('a vivid red cube on white')
    expect(data.dryRun).toBe(false)
  })

  it('parses mask_path for edit results', () => {
    const data = parseGenerateImageData(
      row({
        name: 'edit_image',
        content: [
          'ok: true',
          'action: edit',
          'path: assets/out.png',
          'mask_path: assets/mask.png',
          'prompt: fill hole'
        ].join('\n')
      })
    )
    expect(data.action).toBe('edit')
    expect(data.maskPath).toBe('assets/mask.png')
    expect(data.prompt).toBe('fill hole')
  })
})
