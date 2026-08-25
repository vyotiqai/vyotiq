import { describe, expect, it } from 'vitest'
import {
  mapGithubRelease,
  hasReleaseAssets,
  pickPublishedRelease,
  preferExistingSnapshot,
  RELEASES_PAGE
} from '../../landing/scripts/github-release.mjs'

const published = {
  draft: false,
  tag_name: 'v1.2.3',
  html_url: 'https://github.com/vyotiqai/vyotiq-agent-v/releases/tag/v1.2.3',
  assets: [
    {
      name: 'Vyotiq-1.2.3-setup.exe',
      browser_download_url: 'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/Vyotiq-1.2.3-setup.exe'
    },
    {
      name: 'Vyotiq-1.2.3-setup.exe.blockmap',
      browser_download_url:
        'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/Vyotiq-1.2.3-setup.exe.blockmap'
    },
    {
      name: 'Vyotiq-1.2.3.dmg',
      browser_download_url: 'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/Vyotiq-1.2.3.dmg'
    },
    {
      name: 'Vyotiq-1.2.3.AppImage',
      browser_download_url:
        'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/Vyotiq-1.2.3.AppImage'
    },
    {
      name: 'latest.yml',
      browser_download_url: 'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/latest.yml'
    }
  ]
}

describe('mapGithubRelease', () => {
  it('maps exact electron-builder artifact names and ignores blockmaps', () => {
    const mapped = mapGithubRelease(published)
    expect(mapped.tag).toBe('v1.2.3')
    expect(mapped.version).toBe('1.2.3')
    expect(mapped.assets.win?.name).toBe('Vyotiq-1.2.3-setup.exe')
    expect(mapped.assets.mac?.name).toBe('Vyotiq-1.2.3.dmg')
    expect(mapped.assets.linux?.name).toBe('Vyotiq-1.2.3.AppImage')
    expect(hasReleaseAssets(mapped)).toBe(true)
  })

  it('maps arch-suffixed installer names when the exact artifact is absent', () => {
    const mapped = mapGithubRelease({
      tag_name: 'v1.2.3',
      html_url: 'https://github.com/vyotiqai/vyotiq-agent-v/releases/tag/v1.2.3',
      assets: [
        {
          name: 'Vyotiq-1.2.3-x64-setup.exe',
          browser_download_url:
            'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/Vyotiq-1.2.3-x64-setup.exe'
        },
        {
          name: 'Vyotiq-1.2.3-arm64.dmg',
          browser_download_url:
            'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/Vyotiq-1.2.3-arm64.dmg'
        },
        {
          name: 'Vyotiq-1.2.3-x86_64.AppImage',
          browser_download_url:
            'https://github.com/vyotiqai/vyotiq-agent-v/releases/download/v1.2.3/Vyotiq-1.2.3-x86_64.AppImage'
        }
      ]
    })
    expect(mapped.assets.win?.name).toBe('Vyotiq-1.2.3-x64-setup.exe')
    expect(mapped.assets.mac?.name).toBe('Vyotiq-1.2.3-arm64.dmg')
    expect(mapped.assets.linux?.name).toBe('Vyotiq-1.2.3-x86_64.AppImage')
  })

  it('returns an empty snapshot when the payload is missing, draft, or has no packages', () => {
    expect(mapGithubRelease(null).assets).toEqual({})
    expect(mapGithubRelease({ tag_name: 'v1.0.0', assets: [] }).htmlUrl).toBe(RELEASES_PAGE)
    expect(hasReleaseAssets(mapGithubRelease({ tag_name: 'v1.0.0', assets: [] }))).toBe(false)
    expect(mapGithubRelease({ ...published, draft: true }).assets).toEqual({})
  })
})

describe('preferExistingSnapshot', () => {
  it('keeps a baked snapshot when GitHub returns nothing', () => {
    const existing = mapGithubRelease(published)
    const empty = mapGithubRelease({ tag_name: 'v9.9.9', assets: [] })
    expect(preferExistingSnapshot(empty, existing).assets.win?.name).toBe('Vyotiq-1.2.3-setup.exe')
    expect(preferExistingSnapshot(existing, empty).tag).toBe('v1.2.3')
  })

  it('picks the first published release that has installers', () => {
    const chosen = pickPublishedRelease([
      { ...published, draft: true },
      { tag_name: 'v1.0.0', draft: false, assets: [] },
      published
    ])
    expect(chosen?.tag_name).toBe('v1.2.3')
  })
})
