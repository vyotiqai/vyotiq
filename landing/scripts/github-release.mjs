export const RELEASES_PAGE = 'https://github.com/vyotiqai/vyotiq-agent-v/releases/latest'
export const RELEASES_API =
  'https://api.github.com/repos/vyotiqai/vyotiq-agent-v/releases/latest'
export const RELEASES_LIST_API =
  'https://api.github.com/repos/vyotiqai/vyotiq-agent-v/releases?per_page=10'

export const EMPTY_GITHUB_RELEASE = {
  tag: null,
  version: null,
  htmlUrl: RELEASES_PAGE,
  assets: {}
}

function httpsUrl(value) {
  return typeof value === 'string' && value.startsWith('https://') ? value : null
}

function classifyInstaller(name) {
  if (typeof name !== 'string' || !name) return null
  if (name.endsWith('.blockmap') || /\.ya?ml$/i.test(name)) return null
  if (name.endsWith('-setup.exe')) return 'win'
  if (name.endsWith('.dmg')) return 'mac'
  if (name.endsWith('.AppImage')) return 'linux'
  return null
}

export function hasReleaseAssets(mapped) {
  return Boolean(mapped?.assets?.win || mapped?.assets?.mac || mapped?.assets?.linux)
}

/** Keep a previously baked snapshot when a fetch returns nothing usable. */
export function preferExistingSnapshot(candidate, existing) {
  if (hasReleaseAssets(candidate)) return candidate
  if (hasReleaseAssets(existing)) return existing
  return candidate ?? { ...EMPTY_GITHUB_RELEASE, assets: {} }
}

export function sanitizeSnapshot(value) {
  if (value == null || typeof value !== 'object') {
    return { ...EMPTY_GITHUB_RELEASE, assets: {} }
  }
  const parsed = value
  const htmlUrl = httpsUrl(parsed.htmlUrl) ?? RELEASES_PAGE
  const assets = {}
  for (const id of ['win', 'mac', 'linux']) {
    const asset = parsed.assets?.[id]
    const name = typeof asset?.name === 'string' ? asset.name : ''
    const url = httpsUrl(asset?.url)
    if (name && url && classifyInstaller(name)) assets[id] = { name, url }
  }
  return {
    tag: typeof parsed.tag === 'string' && parsed.tag.trim() ? parsed.tag.trim() : null,
    version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null,
    htmlUrl,
    assets
  }
}

/** Map a GitHub release JSON payload to packaged NSIS / DMG / AppImage assets. */
export function mapGithubRelease(release) {
  if (release == null || typeof release !== 'object' || release.draft === true) {
    return { ...EMPTY_GITHUB_RELEASE, assets: {} }
  }

  const tag = typeof release.tag_name === 'string' && release.tag_name.trim() ? release.tag_name.trim() : null
  const version = tag ? tag.replace(/^v/i, '') : null
  const htmlUrl = httpsUrl(release.html_url) ?? RELEASES_PAGE
  const list = Array.isArray(release.assets) ? release.assets : []
  const expected = version
    ? {
        win: `Vyotiq-${version}-setup.exe`,
        mac: `Vyotiq-${version}.dmg`,
        linux: `Vyotiq-${version}.AppImage`
      }
    : null

  const assets = {}
  for (const asset of list) {
    if (asset == null || typeof asset !== 'object') continue
    const name = typeof asset.name === 'string' ? asset.name : ''
    const url = httpsUrl(asset.browser_download_url)
    if (!name || !url) continue
    if (expected) {
      if (name === expected.win) assets.win = { name, url }
      else if (name === expected.mac) assets.mac = { name, url }
      else if (name === expected.linux) assets.linux = { name, url }
    }
  }

  for (const asset of list) {
    if (asset == null || typeof asset !== 'object') continue
    const name = typeof asset.name === 'string' ? asset.name : ''
    const url = httpsUrl(asset.browser_download_url)
    const platform = classifyInstaller(name)
    if (!platform || !url || assets[platform]) continue
    assets[platform] = { name, url }
  }

  return { tag, version, htmlUrl, assets }
}

export function pickPublishedRelease(releases) {
  if (!Array.isArray(releases)) return null
  return (
    releases.find(
      (release) => release && release.draft !== true && hasReleaseAssets(mapGithubRelease(release))
    ) ?? null
  )
}
