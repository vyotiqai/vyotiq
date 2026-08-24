import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
  getSettings: vi.fn(),
  getSecret: vi.fn(),
  getCachedModels: vi.fn()
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => mocks.getSettings()
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => mocks.getSecret()
}))

vi.mock('@main/workspace/workspaces', () => ({
  findWorkspaceSettingsOverride: () => null,
  readWorkspacesState: () => ({ settingsOverridesByPath: {} })
}))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat: mocks.streamChat
  })
}))

vi.mock('@main/agent/providers/modelCache', () => ({
  getCachedModels: () => mocks.getCachedModels(),
  modelCacheKey: () => 'test-key'
}))

import {
  abortInlineComplete,
  completeInline,
  fimSpec,
  inlineThinking,
  sanitizeInlineSuggestion
} from '@main/workspace/inlineComplete'

function ollamaSettings(tabAutocomplete = true) {
  return {
    provider: 'ollama',
    model: 'qwen2.5-coder',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1',
    tabAutocomplete
  }
}

describe('sanitizeInlineSuggestion', () => {
  it('strips markdown fences and suffix overlap', () => {
    expect(sanitizeInlineSuggestion('```ts\nfoo();\n```', 'const x = ', '')).toBe('foo();')
    expect(sanitizeInlineSuggestion('bar();\n}', 'f()', '\n}')).toBe('bar();')
  })

  it('returns empty for control tokens, labels, or whitespace', () => {
    expect(sanitizeInlineSuggestion('<|fim_middle|>x', '', '')).toBe('')
    expect(sanitizeInlineSuggestion('PREFIX', 'a', 'b')).toBe('')
    expect(sanitizeInlineSuggestion('   \n  ', 'a', 'b')).toBe('')
  })

  it('keeps leading indent when PREFIX does not already include it', () => {
    expect(sanitizeInlineSuggestion('  return 1;', 'function f() {\n', '\n}')).toBe('  return 1;')
  })

  it('drops an identifier echo without eating a new token', () => {
    expect(sanitizeInlineSuggestion('fooBar', 'foo', '')).toBe('Bar')
    expect(sanitizeInlineSuggestion('error();', 'e', '')).toBe('rror();')
    expect(sanitizeInlineSuggestion('error();', 'else', '')).toBe('error();')
  })

  it('drops a duplicated last line and extra leading newline', () => {
    expect(sanitizeInlineSuggestion('const x = 1', 'const x = ', '')).toBe('1')
    expect(sanitizeInlineSuggestion('\n  foo();', 'function f() {\n', '')).toBe('  foo();')
  })

  it('returns empty when the model copies a nearby line', () => {
    const existing =
      '<text x="400" y="972" text-anchor="middle" font-family="\'Consolas, monospace\'" font-'
    const prefix = `${existing}\n</svg>\n\n`
    expect(sanitizeInlineSuggestion(existing, prefix, '')).toBe('')
  })

  it('returns empty when a copied line is prefixed with a newline', () => {
    const existing =
      '<text x="400" y="972" text-anchor="middle" font-family="\'Consolas, monospace\'" font-'
    expect(
      sanitizeInlineSuggestion(`\n${existing}`, `${existing}\n</svg>\n\nAi`, '')
    ).toBe('')
  })

  it('returns empty when the suggestion ignores the token at the cursor', () => {
    const existing =
      '<text x="400" y="972" text-anchor="middle" font-family="\'Consolas, monospace\'" font-'
    expect(
      sanitizeInlineSuggestion(`${existing}size`, `${existing}\n</svg>\n\nAi`, '')
    ).toBe('')
  })

  it('keeps a similar line that is not a copy', () => {
    const prefix =
      '  <text x="400" y="972" text-anchor="middle" font-family="mono" />\n'
    expect(
      sanitizeInlineSuggestion(
        '  <text x="400" y="990" text-anchor="middle" font-family="mono" />',
        prefix,
        ''
      )
    ).toBe('  <text x="400" y="990" text-anchor="middle" font-family="mono" />')
  })
})

describe('fimSpec', () => {
  it('wraps qwen coder models in FIM tokens', () => {
    const spec = fimSpec('qwen2.5-coder', 'src/a.ts', 'foo', 'bar')
    expect(spec.system).toBeUndefined()
    expect(spec.content).toBe('<|fim_prefix|>foo<|fim_suffix|>bar<|fim_middle|>')
  })

  it('uses a cursor mark for chat models', () => {
    const spec = fimSpec('llama3.2', 'src/a.ts', 'const x = ', '')
    expect(spec.system).toBeTruthy()
    expect(spec.content).toContain('Language: TypeScript')
    expect(spec.content).toContain('<<<CURSOR>>>')
  })
})

describe('completeInline', () => {
  beforeEach(() => {
    mocks.streamChat.mockReset()
    mocks.getSettings.mockReset()
    mocks.getSecret.mockReset()
    mocks.getCachedModels.mockReset()
    mocks.getSettings.mockReturnValue(ollamaSettings())
    mocks.getSecret.mockReturnValue(null)
    mocks.getCachedModels.mockReturnValue(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('generate unavailable')
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns sanitized model text', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: '```\nreturn 1;\n```' }
    })
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'src/a.ts',
        prefix: 'function f() {\n  ',
        suffix: '\n}\n'
      })
    ).resolves.toEqual({ text: 'return 1;' })
  })

  it('returns empty when the setting is off', async () => {
    mocks.getSettings.mockReturnValue(ollamaSettings(false))
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'src/a.ts',
        prefix: 'const x = ',
        suffix: ''
      })
    ).resolves.toEqual({ text: '' })
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it('returns empty when a keyed provider has no secret', async () => {
    mocks.getSettings.mockReturnValue({
      ...ollamaSettings(),
      provider: 'openai',
      model: 'gpt-4.1-mini'
    })
    mocks.getSecret.mockReturnValue(null)
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'src/a.ts',
        prefix: 'const x = ',
        suffix: ''
      })
    ).resolves.toEqual({ text: '' })
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it('still calls the provider when getSecret throws for a keyless host', async () => {
    mocks.getSecret.mockImplementation(() => {
      throw new Error('secrets unreadable')
    })
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'ok' }
    })
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'src/a.ts',
        prefix: 'const x = ',
        suffix: ''
      })
    ).resolves.toEqual({ text: 'ok' })
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it('disables thinking and passes model metadata', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'y' }
    })
    await completeInline(1, {
      workspacePath: '/ws',
      path: 'src/a.ts',
      prefix: 'const x = ',
      suffix: ''
    })
    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { enabled: false },
        toolChoice: 'none',
        temperature: 0,
        stop: expect.arrayContaining(['<<<CURSOR>>>']),
        modelInfo: expect.objectContaining({ id: 'qwen2.5-coder' }),
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('<|fim_prefix|>')
          })
        ]
      })
    )
  })

  it('returns empty when the stream copies a nearby line', async () => {
    const existing =
      '<text x="400" y="972" text-anchor="middle" font-family="\'Consolas, monospace\'" font-'
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: existing }
    })
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'self-portrait.svg',
        prefix: `${existing}\n</svg>\n\nAi`,
        suffix: ''
      })
    ).resolves.toEqual({ text: '' })
  })

  it('returns empty on provider error', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'error', error: 'unavailable' }
    })
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'src/a.ts',
        prefix: 'const x = ',
        suffix: ''
      })
    ).resolves.toEqual({ text: '' })
  })

  it('uses the lowest effort when the catalog forbids disabling thinking', async () => {
    mocks.getSecret.mockReturnValue('sk-or-test')
    mocks.getSettings.mockReturnValue({
      ...ollamaSettings(),
      provider: 'openrouter',
      model: 'stealth/ox-alpha',
      thinkingEnabled: true
    })
    mocks.getCachedModels.mockReturnValue([
      {
        id: 'stealth/ox-alpha',
        displayName: 'Ox Alpha',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true,
        thinkingCanDisable: false,
        thinkingDefaultEffort: 'max',
        supportedThinkingEfforts: ['max', 'high', 'low']
      }
    ])
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'foo()' }
    })
    await completeInline(1, {
      workspacePath: '/ws',
      path: 'src/a.ts',
      prefix: 'const x = ',
      suffix: ''
    })
    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { enabled: true, effort: 'low' },
        modelInfo: expect.objectContaining({
          id: 'stealth/ox-alpha',
          thinkingCanDisable: false
        })
      })
    )
  })

  it('keeps partial text when the stream is aborted', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'partial' }
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    })
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'src/a.ts',
        prefix: 'const x = ',
        suffix: ''
      })
    ).resolves.toEqual({ text: 'partial' })
  })

  it('uses Ollama generate suffix when the native endpoint answers', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ response: 'Bar' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      completeInline(1, {
        workspacePath: '/ws',
        path: 'src/a.ts',
        prefix: 'foo',
        suffix: '();'
      })
    ).resolves.toEqual({ text: 'Bar' })
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalled()
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body?: string })?.body ?? '{}'
    ) as { prompt?: string; suffix?: string; stream?: boolean }
    expect(body.prompt).toBe('foo')
    expect(body.suffix).toBe('();')
    expect(body.stream).toBe(false)
  })

  it('aborts an in-flight request by id', async () => {
    let started = false
    mocks.streamChat.mockImplementation(async function* (req: { signal: AbortSignal }) {
      started = true
      yield { type: 'text', text: 'ab' }
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => {
          const err = new Error('Aborted')
          err.name = 'AbortError'
          reject(err)
        }
        if (req.signal.aborted) {
          fail()
          return
        }
        req.signal.addEventListener('abort', fail)
      })
    })
    const pending = completeInline(1, {
      workspacePath: '/ws',
      path: 'src/a.ts',
      prefix: 'const x = ',
      suffix: '',
      requestId: 'inline-req-1'
    })
    await vi.waitFor(() => expect(started).toBe(true))
    abortInlineComplete('inline-req-1')
    await expect(pending).resolves.toEqual({ text: 'ab' })
  })
})

describe('inlineThinking', () => {
  it('disables thinking when the catalog allows it', () => {
    expect(
      inlineThinking(
        {
          id: 'qwen2.5-coder',
          displayName: 'qwen2.5-coder',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          thinkingCanDisable: true
        },
        true
      )
    ).toEqual({ enabled: false })
  })

  it('falls back to low effort when thinking is on and the catalog is silent', () => {
    expect(
      inlineThinking(
        {
          id: 'stealth/ox-alpha',
          displayName: 'Ox Alpha',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false
        },
        true
      )
    ).toEqual({ enabled: true, effort: 'low' })
  })
})
