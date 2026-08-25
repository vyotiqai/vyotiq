/**
 * Fetch the latest published GitHub Release at build time and write a static snapshot.
 * A failed fetch keeps a previously baked snapshot instead of hiding package buttons.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EMPTY_GITHUB_RELEASE,
  RELEASES_API,
  RELEASES_LIST_API,
  hasReleaseAssets,
  mapGithubRelease,
  pickPublishedRelease,
  preferExistingSnapshot,
  sanitizeSnapshot
} from './github-release.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const outFile = join(root, '..', 'src', 'lib', 'github-release.json')

function empty() {
  return { ...EMPTY_GITHUB_RELEASE, assets: {} }
}

function writeSnapshot(data) {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, `${JSON.stringify(data, null, 2)}\n`)
}

function readExisting() {
  if (!existsSync(outFile)) return empty()
  try {
    return sanitizeSnapshot(JSON.parse(readFileSync(outFile, 'utf8')))
  } catch {
    return empty()
  }
}

function summarize(mapped) {
  const names = Object.values(mapped.assets)
    .map((asset) => asset.name)
    .join(', ')
  return names ? `${mapped.tag ?? 'unknown'} (${names})` : 'empty assets'
}

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vyotiq-landing-release-bake',
  'X-GitHub-Api-Version': '2022-11-28'
}
const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
if (token) headers.Authorization = `Bearer ${token}`

async function fetchJson(url) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(8000)
  })
  if (!response.ok) {
    return { ok: false, status: response.status, data: null }
  }
  return { ok: true, status: response.status, data: await response.json() }
}

const existing = readExisting()

try {
  let mapped = empty()
  const latest = await fetchJson(RELEASES_API)
  if (latest.ok) {
    mapped = mapGithubRelease(latest.data)
  } else {
    console.warn(`[landing] GitHub latest release: HTTP ${latest.status}`)
  }

  if (!hasReleaseAssets(mapped)) {
    const listed = await fetchJson(RELEASES_LIST_API)
    if (listed.ok) {
      mapped = mapGithubRelease(pickPublishedRelease(listed.data))
    } else {
      console.warn(`[landing] GitHub releases list: HTTP ${listed.status}`)
    }
  }

  const chosen = preferExistingSnapshot(mapped, existing)
  writeSnapshot(chosen)
  if (hasReleaseAssets(mapped)) {
    console.warn(`[landing] baked GitHub release ${summarize(chosen)}`)
  } else if (hasReleaseAssets(existing)) {
    console.warn(
      `[landing] GitHub returned no published packages; keeping previously baked ${summarize(chosen)}`
    )
  } else {
    console.warn('[landing] GitHub returned no published packages; baking empty assets')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const chosen = preferExistingSnapshot(empty(), existing)
  writeSnapshot(chosen)
  if (hasReleaseAssets(chosen)) {
    console.warn(
      `[landing] GitHub latest release fetch failed (${message}); keeping previously baked ${summarize(chosen)}`
    )
  } else {
    console.warn(`[landing] GitHub latest release fetch failed (${message}); baking empty assets`)
  }
}

process.exit(0)
