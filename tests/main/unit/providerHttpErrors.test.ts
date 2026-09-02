import { describe, expect, it } from 'vitest'
import {
  formatProviderHttpError,
  isOpenRouterNoEndpointsError,
  parseOpenRouterAffordableOutputTokens,
  shouldRetryOmitIncludeUsage,
  shouldRetryOpenRouterCompatBody
} from '@main/agent/providers/httpErrors'

const OPENROUTER_402 = JSON.stringify({
  error: {
    message:
      'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 54013. To increase, visit https://openrouter.ai/settings/credits and add more credits',
    code: 402
  }
})

const OPENROUTER_NO_ENDPOINTS = JSON.stringify({
  error: {
    message:
      'No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy',
    code: 404
  }
})

describe('formatProviderHttpError', () => {
  it('formats OpenRouter 402 with affordable token hint', () => {
    const msg = formatProviderHttpError(402, OPENROUTER_402, 'openrouter')
    expect(msg).toMatch(/OpenRouter credits are insufficient/i)
    expect(msg).toMatch(/54,013/)
    expect(msg).toMatch(/openrouter\.ai\/settings\/credits/)
    expect(msg).not.toMatch(/HTTP 402/)
  })

  it('enriches OpenRouter no-endpoints / data-policy 404', () => {
    const msg = formatProviderHttpError(404, OPENROUTER_NO_ENDPOINTS, 'openrouter')
    expect(msg).toMatch(/privacy\/guardrail/i)
    expect(msg).toMatch(/openrouter\.ai\/settings\/privacy/)
    expect(msg).toMatch(/another model/i)
    expect(msg).not.toMatch(/HTTP 404/)
  })

  it('extracts provider JSON message for generic errors', () => {
    const body = JSON.stringify({ error: { message: 'Invalid model id' } })
    expect(formatProviderHttpError(400, body, 'openrouter')).toBe('Invalid model id')
  })

  it('unwraps OpenRouter nested metadata.raw under Provider returned error', () => {
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              message: 'The encrypted content for item rs_abc could not be verified.',
              type: 'invalid_request_error'
            }
          })
        }
      }
    })
    expect(formatProviderHttpError(400, body, 'openrouter')).toMatch(/encrypted content/i)
  })

  it('scrubs API key-shaped secrets from provider messages', () => {
    const body = JSON.stringify({
      error: { message: 'Invalid key sk-abcdefghijklmnopqrstuvwxyz012345' }
    })
    const msg = formatProviderHttpError(400, body, 'openai')
    expect(msg).toContain('[redacted]')
    expect(msg).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz/)
  })

  it('scrubs Modal proxy tokens echoed without a Bearer prefix', () => {
    const body = JSON.stringify({
      error: { message: 'invalid token wk-Ab12Cd34.ws-Xy56Zv78 for workspace' }
    })
    const msg = formatProviderHttpError(401, body, 'modal')
    expect(msg).toContain('[redacted]')
    expect(msg).not.toContain('wk-Ab12Cd34.ws-Xy56Zv78')
  })

  it('maps auth failures to a settings hint', () => {
    expect(formatProviderHttpError(401, '', 'openai')).toMatch(/API key/i)
  })
})

describe('parseOpenRouterAffordableOutputTokens', () => {
  it('parses affordable output tokens from 402 body', () => {
    expect(parseOpenRouterAffordableOutputTokens(OPENROUTER_402)).toBe(54013)
  })
})

describe('shouldRetryOpenRouterCompatBody', () => {
  it('retries all OpenRouter HTTP 400s', () => {
    expect(shouldRetryOpenRouterCompatBody(400, '{"error":{"message":"bad request"}}')).toBe(true)
  })

  it('retries 404 only for no-endpoints / data-policy messages', () => {
    expect(shouldRetryOpenRouterCompatBody(404, OPENROUTER_NO_ENDPOINTS)).toBe(true)
    expect(
      shouldRetryOpenRouterCompatBody(
        404,
        JSON.stringify({ error: { message: 'Model not found' } })
      )
    ).toBe(false)
  })

  it('does not retry unrelated statuses', () => {
    expect(shouldRetryOpenRouterCompatBody(429, OPENROUTER_NO_ENDPOINTS)).toBe(false)
    expect(shouldRetryOpenRouterCompatBody(500, OPENROUTER_NO_ENDPOINTS)).toBe(false)
  })
})

describe('isOpenRouterNoEndpointsError', () => {
  it('detects guardrail / data-policy wording on 404', () => {
    expect(isOpenRouterNoEndpointsError(404, OPENROUTER_NO_ENDPOINTS)).toBe(true)
  })

  it('rejects unrelated 404 bodies', () => {
    expect(
      isOpenRouterNoEndpointsError(404, JSON.stringify({ error: { message: 'Not found' } }))
    ).toBe(false)
  })
})

describe('shouldRetryOmitIncludeUsage', () => {
  it('retries 400/422 when body mentions stream_options or include_usage', () => {
    expect(
      shouldRetryOmitIncludeUsage(
        400,
        JSON.stringify({ error: { message: 'Extra inputs are not permitted: stream_options' } })
      )
    ).toBe(true)
    expect(
      shouldRetryOmitIncludeUsage(
        422,
        JSON.stringify({ message: 'Unknown parameter: include_usage' })
      )
    ).toBe(true)
  })

  it('does not retry unrelated errors', () => {
    expect(
      shouldRetryOmitIncludeUsage(400, JSON.stringify({ error: { message: 'invalid model' } }))
    ).toBe(false)
    expect(
      shouldRetryOmitIncludeUsage(500, 'stream_options include_usage')
    ).toBe(false)
  })
})
