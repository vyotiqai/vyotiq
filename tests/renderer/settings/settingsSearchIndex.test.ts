/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollToSettingsField } from '@renderer/features/settings/settingsSearchIndex'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('scrollToSettingsField', () => {
  it('highlights the target field when it is mounted', () => {
    document.body.innerHTML = '<div data-settings-field="ollama-url"></div>'
    const el = document.querySelector('[data-settings-field="ollama-url"]') as HTMLElement
    el.scrollIntoView = vi.fn()
    scrollToSettingsField('ollama-url')
    expect(el.className).toContain('ring-1')
  })

  it('falls back to api-keys when a provider URL field is not mounted', () => {
    document.body.innerHTML = '<div data-settings-field="api-keys"></div>'
    const el = document.querySelector('[data-settings-field="api-keys"]') as HTMLElement
    el.scrollIntoView = vi.fn()
    scrollToSettingsField('ollama-url')
    expect(el.className).toContain('ring-1')
    el.className = ''
    scrollToSettingsField('custom-url')
    expect(el.className).toContain('ring-1')
  })

  it('falls back from ollama embedder model to the embedder picker', () => {
    document.body.innerHTML = '<div data-settings-field="codeindex-embedder"></div>'
    const el = document.querySelector('[data-settings-field="codeindex-embedder"]') as HTMLElement
    el.scrollIntoView = vi.fn()
    scrollToSettingsField('codeindex-ollama-model')
    expect(el.className).toContain('ring-1')
  })
})
