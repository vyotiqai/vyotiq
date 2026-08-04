import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const toolGenerateImage = vi.fn()
const toolEditImage = vi.fn()

vi.mock('@main/agent/tools/generateImage', () => ({
  toolGenerateImage: (...args: unknown[]) => toolGenerateImage(...args)
}))

vi.mock('@main/agent/tools/editImage', () => ({
  toolEditImage: (...args: unknown[]) => toolEditImage(...args)
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    interactionMode: 'agent'
  }))
}))

import { executeTool } from '@main/agent/tools'

describe('image tool handler output_format passthrough', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-img-fmt-'))
    toolGenerateImage.mockReset()
    toolEditImage.mockReset()
    toolGenerateImage.mockResolvedValue({
      ok: true,
      summary: 'out.svg',
      content: 'ok: true\npath: out.svg'
    })
    toolEditImage.mockResolvedValue({
      ok: true,
      summary: 'out.svg',
      content: 'ok: true\npath: out.svg'
    })
  })

  it('passes output_format svg through generate_image handler', async () => {
    const result = await executeTool(
      'generate_image',
      JSON.stringify({
        prompt: 'vector logo',
        path: 'out.svg',
        output_format: 'svg',
        provider: 'openrouter'
      }),
      workspace,
      new AbortController().signal,
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(toolGenerateImage).toHaveBeenCalledTimes(1)
    const args = toolGenerateImage.mock.calls[0]![1] as { output_format?: string }
    expect(args.output_format).toBe('svg')
  })

  it('passes output_format svg through edit_image handler', async () => {
    const result = await executeTool(
      'edit_image',
      JSON.stringify({
        prompt: 'simplify strokes',
        reference_paths: ['in.svg'],
        path: 'out.svg',
        output_format: 'svg',
        provider: 'openrouter'
      }),
      workspace,
      new AbortController().signal,
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(toolEditImage).toHaveBeenCalledTimes(1)
    const args = toolEditImage.mock.calls[0]![1] as { output_format?: string }
    expect(args.output_format).toBe('svg')
  })

  it('rejects invalid output_format at schema validation', async () => {
    const result = await executeTool(
      'generate_image',
      JSON.stringify({
        prompt: 'x',
        output_format: 'gif'
      }),
      workspace,
      new AbortController().signal,
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(toolGenerateImage).not.toHaveBeenCalled()
    expect(result.content).toMatch(/output_format|Invalid|enum/i)
  })
})
