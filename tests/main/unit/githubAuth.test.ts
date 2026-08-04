import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({ githubClientId: '' }))
}))

vi.mock('@main/settings/secrets', () => ({
  getGithubAccessToken: vi.fn(() => null),
  hasGithubAccessToken: vi.fn(() => false),
  setGithubAccessToken: vi.fn(),
  clearGithubAccessToken: vi.fn()
}))

import { getSettings } from '@main/settings/settings'
import { getGithubAccessToken } from '@main/settings/secrets'
import {
  resolveGhTokenForCli,
  resolveGithubClientId
} from '@main/git/githubAuth'

describe('githubAuth helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('resolves client id from settings then env', () => {
    vi.mocked(getSettings).mockReturnValue({ githubClientId: 'from-settings' } as never)
    expect(resolveGithubClientId()).toBe('from-settings')

    vi.mocked(getSettings).mockReturnValue({ githubClientId: '' } as never)
    vi.stubEnv('VYOTIQ_GITHUB_CLIENT_ID', 'from-env')
    expect(resolveGithubClientId()).toBe('from-env')
  })

  it('uses only the stored app token and never ambient GH_TOKEN', () => {
    vi.stubEnv('GH_TOKEN', 'ambient')
    vi.mocked(getGithubAccessToken).mockReturnValue('app-token')
    expect(resolveGhTokenForCli()).toBe('app-token')

    vi.mocked(getGithubAccessToken).mockReturnValue(null)
    expect(resolveGhTokenForCli()).toBeUndefined()
  })
})
