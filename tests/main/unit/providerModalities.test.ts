import { describe, expect, it } from 'vitest'
import {
  baseModelInfo,
  normalizeOpenAiStyleModels,
  wireSupportedInputModalities,
  wireSupportedOutputModalities
} from '@main/agent/providers/normalize'
import { toResponsesUserContent } from '@main/agent/providers/openaiResponses'
import { toInteractionsInput } from '@main/agent/providers/geminiInteractions'
import { mapOpenAiContentParts } from '@main/agent/providers/openai'
import { buildAnthropicBody } from '@main/agent/providers/anthropic'

describe('wire-supported modalities', () => {
  it('strips audio/file for providers without those wire paths', () => {
    expect(wireSupportedInputModalities(['text', 'image', 'audio', 'file'], true, 'mistral')).toEqual(
      ['text', 'image']
    )
    expect(wireSupportedInputModalities(['audio', 'file'], false, 'ollama')).toEqual(['text'])
  })

  it('keeps catalog audio/file when the provider implements them', () => {
    expect(
      wireSupportedInputModalities(['text', 'image', 'audio', 'file'], true, 'gemini')
    ).toEqual(['text', 'image', 'audio', 'file'])
    expect(
      wireSupportedInputModalities(['text', 'image', 'file'], true, 'anthropic')
    ).toEqual(['text', 'image', 'file'])
  })

  it('keeps output modalities text-only', () => {
    expect(wireSupportedOutputModalities(['text', 'image'])).toEqual(['text'])
    expect(wireSupportedOutputModalities(['image'])).toEqual(['text'])
  })

  it('baseModelInfo advertises file for anthropic when catalog lists it', () => {
    const model = baseModelInfo(
      'claude-sonnet-4',
      {
        inputModalities: ['text', 'image', 'audio', 'file'],
        supportsVision: true
      },
      'anthropic'
    )
    expect(model.inputModalities).toEqual(['text', 'image', 'file'])
    expect(model.outputModalities).toEqual(['text'])
  })

  it('normalizeOpenAiStyleModels keeps file for openai provider', () => {
    const models = normalizeOpenAiStyleModels(
      {
        data: [
          {
            id: 'vision-model',
            architecture: {
              input_modalities: ['text', 'image', 'audio', 'file'],
              output_modalities: ['text', 'image']
            }
          }
        ]
      },
      { providerId: 'openai' }
    )
    expect(models).toHaveLength(1)
    expect(models[0]?.inputModalities).toEqual(['text', 'image', 'audio', 'file'])
    expect(models[0]?.outputModalities).toEqual(['text'])
  })
})

describe('native multimodal wire shapes', () => {
  it('OpenAI Responses sends file_native as input_file', () => {
    const parts = toResponsesUserContent([
      { type: 'text', text: 'summarize' },
      { type: 'file_native', name: 'doc.pdf', mime: 'application/pdf', data: 'AAAA' }
    ])
    expect(parts).toEqual([
      { type: 'input_text', text: 'summarize' },
      {
        type: 'input_file',
        filename: 'doc.pdf',
        file_data: 'data:application/pdf;base64,AAAA'
      }
    ])
  })

  it('Gemini Interactions sends audio and document parts', () => {
    const input = toInteractionsInput(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'listen' },
            { type: 'audio', url: 'data:audio/wav;base64,QQ==', mime: 'audio/wav' },
            {
              type: 'file_native',
              name: 'a.pdf',
              mime: 'application/pdf',
              data: 'BBBB'
            }
          ]
        }
      ],
      undefined,
      false
    )
    expect(input).toEqual([
      { type: 'text', text: 'listen' },
      { type: 'audio', data: 'QQ==', mime_type: 'audio/wav' },
      { type: 'document', data: 'BBBB', mime_type: 'application/pdf' }
    ])
  })

  it('OpenAI chat maps audio to input_audio', () => {
    const parts = mapOpenAiContentParts([
      { type: 'text', text: 'transcribe' },
      { type: 'audio', url: 'data:audio/wav;base64,QQ==', mime: 'audio/wav' }
    ])
    expect(parts).toEqual([
      { type: 'text', text: 'transcribe' },
      { type: 'input_audio', input_audio: { data: 'QQ==', format: 'wav' } }
    ])
  })

  it('Anthropic maps file_native to document blocks', () => {
    const body = buildAnthropicBody({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize' },
            {
              type: 'file_native',
              name: 'doc.pdf',
              mime: 'application/pdf',
              data: 'AAAA'
            }
          ]
        }
      ],
      tools: [],
      signal: new AbortController().signal
    })
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>
    const blocks = messages[0]?.content ?? []
    expect(blocks.some((b) => b.type === 'text' && b.text === 'summarize')).toBe(true)
    const doc = blocks.find((b) => b.type === 'document') as
      | { type: string; source: Record<string, unknown> }
      | undefined
    expect(doc?.source).toMatchObject({
      type: 'base64',
      media_type: 'application/pdf',
      data: 'AAAA'
    })
  })

  it('Anthropic cache_control marks stable system only; volatile trails history', () => {
    const body = buildAnthropicBody({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      system: 'ignored-when-split',
      systemStable: 'STABLE HARNESS',
      systemVolatile: 'VOLATILE HINT',
      signal: new AbortController().signal
    })
    const system = body.system as Array<Record<string, unknown>>
    expect(system).toHaveLength(1)
    expect(system[0]).toMatchObject({
      type: 'text',
      text: 'STABLE HARNESS',
      cache_control: { type: 'ephemeral' }
    })
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]
    })
    const last = messages[messages.length - 1]!
    expect(last.role).toBe('user')
    const lastContent = last.content as Array<Record<string, unknown>>
    expect(lastContent[0]?.text).toContain('## Live session context')
    expect(lastContent[0]?.text).toContain('VOLATILE HINT')
    expect(lastContent[0]).not.toHaveProperty('cache_control')
  })
})
