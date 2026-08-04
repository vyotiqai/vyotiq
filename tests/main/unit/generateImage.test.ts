import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@main/settings/secrets', () => ({
  getSecret: vi.fn((provider: string) => {
    const keys: Record<string, string> = {
      openai: 'sk-test-openai',
      gemini: 'gemini-test-key',
      xai: 'xai-test-key',
      openrouter: 'or-test-key'
    }
    return keys[provider] ?? null
  })
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    imageProvider: 'auto',
    imageModel: '',
    customImageEnabled: false,
    customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
  }))
}))

vi.mock('@main/workspace/workspaces', () => ({
  readWorkspacesState: vi.fn(() => ({
    openPaths: [],
    lastActivePath: null,
    workspaceIdsByPath: {},
    settingsOverridesByPath: {}
  })),
  findWorkspaceSettingsOverride: vi.fn(() => null)
}))

import { getSecret } from '@main/settings/secrets'
import { getSettings } from '@main/settings/settings'
import {
  resolveImageGenProvider,
  resolveImageModel,
  openaiImageAdapter,
  geminiImageAdapter,
  xaiImageAdapter,
  openrouterImageAdapter,
  customImageAdapter,
  validateOpenAiImageSize,
  applyImagePreset,
  normalizeGeminiImageSize,
  normalizeXaiResolution,
  clearOpenRouterImageDiscoveryCache,
  clearCustomImageProbeCache,
  classifyCustomImageHttpStatus,
  probeCustomImageGenerations,
  hasImageGenKey,
  getImageGenKey,
  generateImageBytes,
  extForMime
} from '@main/agent/providers/imageGen'
import { toolGenerateImage } from '@main/agent/tools/generateImage'
import { isBuiltinAllowedInMode } from '@main/agent/tools/modePolicy'
import { isParallelSafeTool, isApprovalExemptTool } from '@main/agent/tools/classify'
import { isToolGated } from '@main/agent/toolApproval'

describe('imageGen routing', () => {
  it('resolves explicit provider when key exists', () => {
    const r = resolveImageGenProvider({
      explicit: 'gemini',
      settingsProvider: 'openai',
      chatProvider: 'anthropic',
      hasKey: (id) => id === 'gemini'
    })
    expect(r).toEqual({ providerId: 'gemini' })
  })

  it('errors when explicit provider has no key', () => {
    const r = resolveImageGenProvider({
      explicit: 'openai',
      hasKey: () => false
    })
    expect('error' in r).toBe(true)
  })

  it('auto prefers openai then gemini then xai then openrouter', () => {
    expect(
      resolveImageGenProvider({
        hasKey: (id) => id === 'xai' || id === 'gemini'
      })
    ).toEqual({ providerId: 'gemini' })
    expect(
      resolveImageGenProvider({
        hasKey: (id) => id === 'xai'
      })
    ).toEqual({ providerId: 'xai' })
    expect(
      resolveImageGenProvider({
        hasKey: (id) => id === 'openrouter'
      })
    ).toEqual({ providerId: 'openrouter' })
  })

  it('prefers chat provider when auto and key present', () => {
    expect(
      resolveImageGenProvider({
        chatProvider: 'xai',
        hasKey: (id) => id === 'openai' || id === 'xai'
      })
    ).toEqual({ providerId: 'xai' })
    expect(
      resolveImageGenProvider({
        chatProvider: 'openrouter',
        hasKey: (id) => id === 'openai' || id === 'openrouter'
      })
    ).toEqual({ providerId: 'openrouter' })
  })

  it('resolves default models', () => {
    expect(resolveImageModel('openai')).toBe('gpt-image-2')
    expect(resolveImageModel('gemini')).toBe('gemini-3.1-flash-image')
    expect(resolveImageModel('xai')).toBe('grok-imagine-image-quality')
    expect(resolveImageModel('openrouter')).toBe('bytedance-seed/seedream-4.5')
    expect(resolveImageModel('custom')).toBe('dall-e-3')
    expect(resolveImageModel('openai', 'gpt-image-1.5')).toBe('gpt-image-1.5')
  })

  it('treats keyless LAN custom as ready with effective base URL override', () => {
    vi.mocked(getSettings).mockReturnValue({
      provider: 'custom',
      model: 'x',
      imageProvider: 'custom',
      imageModel: '',
      customImageEnabled: true,
      customOpenAiBaseUrl: 'https://api.fireworks.ai/inference/v1'
    } as ReturnType<typeof getSettings>)
    vi.mocked(getSecret).mockReturnValue(null)
    expect(hasImageGenKey('custom')).toBe(false)
    expect(
      hasImageGenKey('custom', { customOpenAiBaseUrl: 'http://192.168.0.5:8080/v1' })
    ).toBe(true)
  })

  it('excludes custom from auto when disabled', () => {
    vi.mocked(getSettings).mockReturnValue({
      provider: 'custom',
      model: 'x',
      imageProvider: 'auto',
      imageModel: '',
      customImageEnabled: false,
      customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
    } as ReturnType<typeof getSettings>)
    vi.mocked(getSecret).mockImplementation((p: string) => (p === 'custom' ? 'ck' : null))
    expect(hasImageGenKey('custom')).toBe(false)
    expect(
      resolveImageGenProvider({
        chatProvider: 'custom',
        hasKey: hasImageGenKey
      })
    ).toMatchObject({ error: expect.stringMatching(/image-capable|custom/i) })
  })

  it('includes custom when enabled with key', () => {
    vi.mocked(getSettings).mockReturnValue({
      provider: 'custom',
      model: 'x',
      imageProvider: 'auto',
      imageModel: '',
      customImageEnabled: true,
      customOpenAiBaseUrl: 'http://127.0.0.1:9090/v1'
    } as ReturnType<typeof getSettings>)
    vi.mocked(getSecret).mockImplementation((p: string) => (p === 'custom' ? 'ck' : null))
    expect(hasImageGenKey('custom')).toBe(true)
    expect(
      resolveImageGenProvider({
        hasKey: hasImageGenKey
      })
    ).toEqual({ providerId: 'custom' })
  })

  it('includes keyless local custom when images enabled', () => {
    vi.mocked(getSettings).mockReturnValue({
      provider: 'custom',
      model: 'x',
      imageProvider: 'auto',
      imageModel: '',
      customImageEnabled: true,
      customOpenAiBaseUrl: 'http://192.168.0.5:8080/v1'
    } as ReturnType<typeof getSettings>)
    vi.mocked(getSecret).mockReturnValue(null)
    expect(hasImageGenKey('custom')).toBe(true)
    expect(getImageGenKey('custom')).toBe('')
  })
})

describe('OpenAI size validation', () => {
  it('accepts popular and auto sizes', () => {
    expect(validateOpenAiImageSize('auto').ok).toBe(true)
    expect(validateOpenAiImageSize('1024x1024').ok).toBe(true)
    expect(validateOpenAiImageSize('2048x2048').ok).toBe(true)
    expect(validateOpenAiImageSize('3840x2160').ok).toBe(true)
  })

  it('rejects non-multiples of 16 and excess ratio', () => {
    const bad = validateOpenAiImageSize('1000x1000')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/multiples of 16/)

    const ratio = validateOpenAiImageSize('3840x1024')
    expect(ratio.ok).toBe(false)
    if (!ratio.ok) expect(ratio.error).toMatch(/3:1/)
  })

  it('flags experimental sizes above 2560x1440', () => {
    const r = validateOpenAiImageSize('3840x2160')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.experimental).toBe(true)
  })
})

describe('image presets and resolution normalize', () => {
  it('draft/final fill quality and resolution without overriding explicit', () => {
    const draft = applyImagePreset('openai', 'draft', {})
    expect(draft.quality).toBe('low')
    const kept = applyImagePreset('openai', 'draft', { quality: 'high' })
    expect(kept.quality).toBe('high')

    const finalG = applyImagePreset('gemini', 'final', {})
    expect(finalG.resolution).toBe('2K')
    const draftX = applyImagePreset('xai', 'draft', {})
    expect(draftX.resolution).toBe('1k')
    expect(draftX.modelHint).toBe('grok-imagine-image')

    const draftOr = applyImagePreset('openrouter', 'draft', {})
    expect(draftOr.quality).toBe('low')
    expect(draftOr.resolution).toBe('1K')
    const finalOr = applyImagePreset('openrouter', 'final', {})
    expect(finalOr.quality).toBe('high')
    expect(finalOr.resolution).toBe('2K')
  })

  it('normalizes Gemini 0.5K and clamps xAI 4k→2k', () => {
    expect(normalizeGeminiImageSize('0.5k')).toBe('0.5K')
    expect(normalizeGeminiImageSize('2K')).toBe('2K')
    expect(normalizeXaiResolution('4K')).toEqual({ value: '2k', clampedFrom: '4K' })
    expect(normalizeXaiResolution('1k')).toEqual({ value: '1k' })
  })
})

describe('imageGen adapters', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
  })

  it('OpenAI adapter decodes b64_json', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: png.toString('base64'), revised_prompt: 'a cat' }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as typeof fetch

    const result = await openaiImageAdapter.generate('sk', {
      prompt: 'a cat',
      model: 'gpt-image-2',
      size: '1024x1024',
      quality: 'low'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytes.equals(png)).toBe(true)
      expect(result.revisedPrompt).toBe('a cat')
      expect(result.width).toBe(1024)
    }
  })

  it('OpenAI rejects invalid size and transparent on gpt-image-2', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as typeof fetch

    const badSize = await openaiImageAdapter.generate('sk', {
      prompt: 'x',
      model: 'gpt-image-2',
      size: '1000x1000'
    })
    expect(badSize.ok).toBe(false)
    if (!badSize.ok) expect(badSize.error).toMatch(/multiples of 16/)
    expect(fetchSpy).not.toHaveBeenCalled()

    const badBg = await openaiImageAdapter.generate('sk', {
      prompt: 'x',
      model: 'gpt-image-2',
      background: 'transparent'
    })
    expect(badBg.ok).toBe(false)
    if (!badBg.ok) expect(badBg.error).toMatch(/transparent/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('OpenAI maps moderation_blocked', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: 'moderation_blocked', message: 'blocked' }
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    ) as typeof fetch

    const result = await openaiImageAdapter.generate('sk', {
      prompt: 'bad',
      model: 'gpt-image-2'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('moderation_blocked')
      expect(result.error).toMatch(/moderation/i)
    }
  })

  it('OpenAI sends output_format and n, writes mime accordingly', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff])
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      expect(body.output_format).toBe('jpeg')
      expect(body.n).toBe(2)
      expect(body.quality).toBe('high')
      return new Response(
        JSON.stringify({
          data: [
            { b64_json: jpeg.toString('base64') },
            { b64_json: jpeg.toString('base64') }
          ]
        }),
        { status: 200 }
      )
    }) as typeof fetch

    const result = await openaiImageAdapter.generate('sk', {
      prompt: 'photo',
      model: 'gpt-image-2',
      size: '1024x1024',
      quality: 'high',
      n: 2,
      outputFormat: 'jpeg'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mimeType).toBe('image/jpeg')
      expect(result.additionalImages?.length).toBe(1)
    }
  })

  it('Gemini adapter extracts inlineData', async () => {
    const png = Buffer.from('fake-png')
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'here you go' },
                  { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      )
    ) as typeof fetch

    const result = await geminiImageAdapter.generate('key', {
      prompt: 'logo',
      model: 'gemini-3.1-flash-image',
      aspectRatio: '1:1',
      resolution: '1K'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytes.equals(png)).toBe(true)
      expect(result.mimeType).toBe('image/png')
    }
  })

  it('xAI refuses when respect_moderation is false', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('x').toString('base64'), respect_moderation: false }]
        }),
        { status: 200 }
      )
    ) as typeof fetch

    const result = await xaiImageAdapter.generate('key', {
      prompt: 'x',
      model: 'grok-imagine-image'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('moderation_blocked')
  })

  it('OpenRouter discovery + generate with svg mime', async () => {
    clearOpenRouterImageDiscoveryCache()
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/images/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'bytedance-seed/seedream-4.5', name: 'Seedream 4.5' }]
          }),
          { status: 200 }
        )
      }
      expect(u).toContain('/api/v1/images')
      return new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: svg.toString('base64'), media_type: 'image/svg+xml' }]
        }),
        { status: 200 }
      )
    }) as typeof fetch

    const result = await openrouterImageAdapter.generate('or-key', {
      prompt: 'icon',
      model: 'bytedance-seed/seedream-4.5',
      resolution: '1k',
      outputFormat: 'svg'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mimeType).toBe('image/svg+xml')
      expect(result.bytes.equals(svg)).toBe(true)
      expect(extForMime(result.mimeType)).toBe('.svg')
    }
  })

  it('OpenRouter rejects unknown model from discovery', async () => {
    clearOpenRouterImageDiscoveryCache()
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/images/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'black-forest-labs/flux' }] }), {
          status: 200
        })
      }
      throw new Error('should not generate')
    }) as typeof fetch

    const result = await openrouterImageAdapter.generate('or-key', {
      prompt: 'x',
      model: 'not-a-real/model'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('model_not_found')
      expect(result.error).toMatch(/not found in discovery/i)
    }
  })

  it('OpenRouter maps 402 insufficient credits', async () => {
    clearOpenRouterImageDiscoveryCache()
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/images/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'bytedance-seed/seedream-4.5' }] }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ error: { code: 402, message: 'Payment Required' } }), {
        status: 402
      })
    }) as typeof fetch

    const result = await openrouterImageAdapter.generate('or-key', {
      prompt: 'x',
      model: 'bytedance-seed/seedream-4.5'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('insufficient_credits')
      expect(result.error).toMatch(/credits/i)
    }
  })

  it('OpenRouter edit rejects mask and sends input_references', async () => {
    clearOpenRouterImageDiscoveryCache()
    const png = Buffer.from([137, 80, 78, 71])
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes('/images/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'bytedance-seed/seedream-4.5' }] }),
          { status: 200 }
        )
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        input_references?: Array<{ image_url: { url: string } }>
      }
      expect(body.input_references?.[0]?.image_url.url).toMatch(/^data:image\/png;base64,/)
      return new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: png.toString('base64') }]
        }),
        { status: 200 }
      )
    }) as typeof fetch

    const withMask = await openrouterImageAdapter.edit('or-key', {
      prompt: 'edit',
      model: 'bytedance-seed/seedream-4.5',
      images: [{ bytes: png, mimeType: 'image/png', filename: 'a.png' }],
      mask: { bytes: png, mimeType: 'image/png', filename: 'mask.png' }
    })
    expect(withMask.ok).toBe(false)
    if (!withMask.ok) expect(withMask.error).toMatch(/mask_path/)

    const okEdit = await openrouterImageAdapter.edit('or-key', {
      prompt: 'edit',
      model: 'bytedance-seed/seedream-4.5',
      images: [{ bytes: png, mimeType: 'image/png', filename: 'a.png' }]
    })
    expect(okEdit.ok).toBe(true)
  })

  it('classifies custom probe HTTP statuses', () => {
    expect(classifyCustomImageHttpStatus(404)).toBe('unsupported')
    expect(classifyCustomImageHttpStatus(501)).toBe('unsupported')
    expect(classifyCustomImageHttpStatus(400)).toBe('supported')
    expect(classifyCustomImageHttpStatus(401)).toBe('supported')
    expect(classifyCustomImageHttpStatus(200)).toBe('supported')
  })

  it('custom probe caches 404 as unsupported and does not break openai auto', async () => {
    clearCustomImageProbeCache()
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch

    const probed = await probeCustomImageGenerations('ck', 'http://127.0.0.1:8080/v1')
    expect(probed.status).toBe('unsupported')

    vi.mocked(getSettings).mockReturnValue({
      provider: 'anthropic',
      model: 'x',
      imageProvider: 'auto',
      imageModel: '',
      customImageEnabled: true,
      customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
    } as ReturnType<typeof getSettings>)
    vi.mocked(getSecret).mockImplementation((p: string) => {
      if (p === 'custom') return 'ck'
      if (p === 'openai') return 'sk'
      return null
    })
    // OpenAI still wins auto when both available
    expect(
      resolveImageGenProvider({ hasKey: hasImageGenKey })
    ).toEqual({ providerId: 'openai' })

    const gated = await generateImageBytes(
      'custom',
      'ck',
      { prompt: 'x', model: 'dall-e-3' },
      null
    )
    expect(gated.ok).toBe(false)
    if (!gated.ok) expect(gated.error).toMatch(/no Images API|does not support/i)
  })

  it('custom adapter generates against injectable base URL after 400 probe', async () => {
    clearCustomImageProbeCache()
    const png = Buffer.from([137, 80, 78, 71])
    let calls = 0
    globalThis.fetch = vi.fn(async (url, init) => {
      calls++
      const u = String(url)
      expect(u).toContain('http://127.0.0.1:9090/v1/images/generations')
      if (String(init?.body) === '{}') {
        return new Response(JSON.stringify({ error: { message: 'missing prompt' } }), {
          status: 400
        })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      expect(body.model).toBe('dall-e-3')
      expect(body.response_format).toBe('b64_json')
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
        status: 200
      })
    }) as typeof fetch

    vi.mocked(getSettings).mockReturnValue({
      provider: 'custom',
      model: 'x',
      imageProvider: 'custom',
      imageModel: '',
      customImageEnabled: true,
      customOpenAiBaseUrl: 'http://127.0.0.1:9090/v1'
    } as ReturnType<typeof getSettings>)

    const result = await generateImageBytes(
      'custom',
      'ck',
      { prompt: 'cat', model: 'dall-e-3' },
      null
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytes.equals(png)).toBe(true)
      expect(result.providerId).toBe('custom')
    }
    expect(calls).toBeGreaterThanOrEqual(2)

    // Direct adapter with explicit base
    clearCustomImageProbeCache()
    const direct = await customImageAdapter.generate('ck', {
      prompt: 'dog',
      model: 'dall-e-3',
      openAiBaseUrl: 'http://127.0.0.1:9090/v1',
      openAiCompatMode: true
    })
    expect(direct.ok).toBe(true)
  })
})

describe('extForMime svg', () => {
  it('maps svg mime to .svg', () => {
    expect(extForMime('image/svg+xml')).toBe('.svg')
  })
})

describe('toolGenerateImage', () => {
  let workspace: string
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vy-img-'))
    vi.mocked(getSettings).mockReturnValue({
      provider: 'anthropic',
      model: 'claude',
      imageProvider: 'auto',
      imageModel: ''
    } as ReturnType<typeof getSettings>)
    vi.mocked(getSecret).mockImplementation((provider: string) => {
      if (provider === 'openai') return 'sk-test'
      return null
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(workspace, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('Ask mode dry-runs without writing or fetching', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as typeof fetch

    const result = await toolGenerateImage(
      workspace,
      { prompt: 'icon of a rocket', path: 'assets/icon.png' },
      { agentMode: 'ask' }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/dry_run:\s*true/)
    expect(result.content).toMatch(/path:\s*assets\/icon\.png/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(() => readFileSync(join(workspace, 'assets', 'icon.png'))).toThrow()
  })

  it('Plan mode dry-runs with default path under .vyotiq/generated', async () => {
    const result = await toolGenerateImage(
      workspace,
      { prompt: 'banner' },
      { agentMode: 'plan' }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/dry_run:\s*true/)
    expect(result.content).toMatch(/\.vyotiq\/generated\//)
  })

  it('Agent mode writes PNG under workspace', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2])
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
        status: 200
      })
    ) as typeof fetch

    const phases: string[] = []
    const result = await toolGenerateImage(
      workspace,
      { prompt: 'pixel', path: 'docs/assets/pixel.png', quality: 'low' },
      {
        agentMode: 'agent',
        onProgress: (u) => phases.push(`${u.kind}:${u.text}`)
      }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('docs/assets/pixel.png')
    const written = readFileSync(join(workspace, 'docs', 'assets', 'pixel.png'))
    expect(written.equals(png)).toBe(true)
    expect(phases.some((p) => p.includes('Resolving'))).toBe(true)
    expect(phases.some((p) => p.includes('Calling openai'))).toBe(true)
    expect(phases.some((p) => p.includes('Writing docs/assets/pixel.png'))).toBe(true)
    expect(phases.at(-1)).toMatch(/^done:Saved /)
  })

  it('Agent mode with only OpenRouter key writes SVG via Image API', async () => {
    clearOpenRouterImageDiscoveryCache()
    vi.mocked(getSecret).mockImplementation((provider: string) =>
      provider === 'openrouter' ? 'or-test' : null
    )
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8')
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/images/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'bytedance-seed/seedream-4.5' }] }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: svg.toString('base64'), media_type: 'image/svg+xml' }]
        }),
        { status: 200 }
      )
    }) as typeof fetch

    const result = await toolGenerateImage(
      workspace,
      {
        prompt: 'vector mark',
        path: 'assets/mark.svg',
        output_format: 'svg',
        provider: 'openrouter'
      },
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('assets/mark.svg')
    expect(result.content).toMatch(/provider:\s*openrouter/)
    expect(result.content).toMatch(/mimeType:\s*image\/svg\+xml/)
    expect(readFileSync(join(workspace, 'assets', 'mark.svg')).equals(svg)).toBe(true)
  })

  it('Agent mode defaults path when omitted', async () => {
    const png = Buffer.from('png-bytes')
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
        status: 200
      })
    ) as typeof fetch

    const result = await toolGenerateImage(workspace, { prompt: 'hello world art' }, { agentMode: 'agent' })
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/^\.vyotiq\/generated\/hello-world-art-.*\.png$/)
    const abs = join(workspace, ...result.summary.split('/'))
    expect(readFileSync(abs).equals(png)).toBe(true)
  })

  it('rejects path escape', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('x').toString('base64') }] }),
        { status: 200 }
      )
    ) as typeof fetch

    const result = await toolGenerateImage(
      workspace,
      { prompt: 'x', path: '../outside.png' },
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
  })

  it('Agent mode applies draft preset quality and writes jpeg + extras for n=2', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01])
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      expect(body.quality).toBe('low')
      expect(body.output_format).toBe('jpeg')
      expect(body.n).toBe(2)
      return new Response(
        JSON.stringify({
          data: [{ b64_json: jpeg.toString('base64') }, { b64_json: jpeg.toString('base64') }]
        }),
        { status: 200 }
      )
    }) as typeof fetch

    const result = await toolGenerateImage(
      workspace,
      {
        prompt: 'draft jpeg',
        path: 'assets/draft.jpg',
        preset: 'draft',
        n: 2,
        output_format: 'jpeg'
      },
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('assets/draft.jpg')
    expect(result.content).toMatch(/additional_paths:\s*assets\/draft-2\.jpg/)
    expect(readFileSync(join(workspace, 'assets', 'draft.jpg')).equals(jpeg)).toBe(true)
    expect(readFileSync(join(workspace, 'assets', 'draft-2.jpg')).equals(jpeg)).toBe(true)
  })
})

describe('generate_image policy', () => {
  it('is allowed in Ask/Plan/Agent', () => {
    expect(isBuiltinAllowedInMode('ask', 'generate_image')).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'generate_image')).toBe(true)
    expect(isBuiltinAllowedInMode('agent', 'generate_image')).toBe(true)
  })

  it('is serial and approval-gated in Agent', () => {
    expect(isParallelSafeTool('generate_image')).toBe(false)
    expect(isApprovalExemptTool('generate_image')).toBe(false)
    expect(isToolGated('generate_image', 'mutating', new Set(), [])).toBe(true)
  })
})

describe('toolEditImage', () => {
  let workspace: string
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vy-img-edit-'))
    mkdirSync(join(workspace, 'assets'), { recursive: true })
    writeFileSync(join(workspace, 'assets', 'src.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]))
    vi.mocked(getSettings).mockReturnValue({
      provider: 'anthropic',
      model: 'claude',
      imageProvider: 'auto',
      imageModel: ''
    } as ReturnType<typeof getSettings>)
    vi.mocked(getSecret).mockImplementation((provider: string) => {
      if (provider === 'openai') return 'sk-test'
      return null
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(workspace, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('Ask mode dry-runs edit without fetch', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as typeof fetch
    const { toolEditImage } = await import('@main/agent/tools/editImage')
    const result = await toolEditImage(
      workspace,
      { prompt: 'make it blue', reference_paths: ['assets/src.png'] },
      { agentMode: 'ask' }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/dry_run:\s*true/)
    expect(result.content).toMatch(/action:\s*edit/)
    expect(result.content).toMatch(/reference_paths:\s*assets\/src\.png/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Agent mode overwrites first reference by default via OpenAI edits', async () => {
    const out = Buffer.from([137, 80, 78, 71, 9, 9, 9])
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toMatch(/\/v1\/images\/edits$/)
      expect(init?.body).toBeInstanceOf(FormData)
      return new Response(JSON.stringify({ data: [{ b64_json: out.toString('base64') }] }), {
        status: 200
      })
    }) as typeof fetch

    const { toolEditImage } = await import('@main/agent/tools/editImage')
    const phases: string[] = []
    const result = await toolEditImage(
      workspace,
      { prompt: 'make it blue', reference_paths: ['assets/src.png'] },
      {
        agentMode: 'agent',
        onProgress: (u) => phases.push(u.text)
      }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('assets/src.png')
    expect(readFileSync(join(workspace, 'assets', 'src.png')).equals(out)).toBe(true)
    expect(phases.some((p) => /Loading reference/i.test(p))).toBe(true)
    expect(phases.some((p) => /Calling openai/i.test(p))).toBe(true)
    expect(phases.at(-1)).toMatch(/Saved assets\/src\.png/)
  })

  it('Agent mode writes to explicit path without overwriting source', async () => {
    const out = Buffer.from('edited-png')
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: out.toString('base64') }] }), {
        status: 200
      })
    ) as typeof fetch

    const { toolEditImage } = await import('@main/agent/tools/editImage')
    const result = await toolEditImage(
      workspace,
      {
        prompt: 'variant',
        reference_paths: ['assets/src.png'],
        path: 'assets/variant.png'
      },
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('assets/variant.png')
    expect(readFileSync(join(workspace, 'assets', 'src.png')).length).toBeGreaterThan(0)
    expect(readFileSync(join(workspace, 'assets', 'variant.png')).equals(out)).toBe(true)
  })

  it('fails when reference is missing', async () => {
    const { toolEditImage } = await import('@main/agent/tools/editImage')
    const result = await toolEditImage(
      workspace,
      { prompt: 'x', reference_paths: ['assets/missing.png'] },
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/not found/i)
  })

  it('Gemini edit rejects mask_path', async () => {
    writeFileSync(join(workspace, 'assets', 'mask.png'), Buffer.from([1, 2, 3, 4]))
    vi.mocked(getSecret).mockImplementation((provider: string) =>
      provider === 'gemini' ? 'gkey' : null
    )
    const { geminiImageAdapter } = await import('@main/agent/providers/imageGen')
    const result = await geminiImageAdapter.edit('gkey', {
      prompt: 'x',
      model: 'gemini-3.1-flash-image',
      images: [{ bytes: Buffer.from('a'), mimeType: 'image/png', filename: 'a.png' }],
      mask: { bytes: Buffer.from('m'), mimeType: 'image/png', filename: 'm.png' }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/mask/i)
  })
})

describe('edit_image policy', () => {
  it('is allowed in Ask/Plan/Agent and serial', () => {
    expect(isBuiltinAllowedInMode('ask', 'edit_image')).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'edit_image')).toBe(true)
    expect(isParallelSafeTool('edit_image')).toBe(false)
    expect(isApprovalExemptTool('edit_image')).toBe(false)
  })
})
