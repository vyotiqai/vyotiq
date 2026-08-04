import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import { getSettings } from '@main/settings/settings'
import {
  clearGithubAccessToken,
  getGithubAccessToken,
  hasGithubAccessToken,
  setGithubAccessToken
} from '@main/settings/secrets'
import { logger } from '../../shared/logger'

const execFile = promisify(execFileCb)

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_SCOPE = 'repo read:org'

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

type TokenSuccess = {
  access_token: string
  token_type?: string
  scope?: string
}

type TokenPending = {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string
  error_description?: string
  interval?: number
}

export type GithubAuthStatus = {
  ghAvailable: boolean
  clientIdConfigured: boolean
  hasAppToken: boolean
  pending: boolean
  userCode: string | null
  verificationUri: string | null
  error: string | null
}

type PendingFlow = {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout> | null
  error: string | null
}

let pending: PendingFlow | null = null

export function resolveGithubClientId(): string | null {
  const fromSettings = getSettings().githubClientId?.trim()
  if (fromSettings) return fromSettings
  const fromEnv = process.env.VYOTIQ_GITHUB_CLIENT_ID?.trim()
  return fromEnv || null
}

function clearPendingTimer(): void {
  if (pending?.timer) {
    clearTimeout(pending.timer)
    pending.timer = null
  }
}

export function cancelGithubAuth(): void {
  clearPendingTimer()
  pending = null
}

export async function githubAuthStatus(): Promise<GithubAuthStatus> {
  let available = false
  try {
    await execFile('gh', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    available = true
  } catch {
    available = false
  }

  let hasAppToken = false
  let statusError = pending?.error ?? null
  try {
    hasAppToken = hasGithubAccessToken() && Boolean(getGithubAccessToken())
  } catch (err) {
    hasAppToken = false
    statusError = err instanceof Error ? err.message : String(err)
  }

  return {
    ghAvailable: available,
    clientIdConfigured: Boolean(resolveGithubClientId()),
    hasAppToken,
    pending: Boolean(pending),
    userCode: pending?.userCode ?? null,
    verificationUri: pending?.verificationUri ?? null,
    error: statusError
  }
}

async function postForm(
  url: string,
  body: Record<string, string>
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body).toString()
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok && typeof json.error !== 'string') {
    throw new Error(`GitHub OAuth HTTP ${res.status}`)
  }
  return json
}

function schedulePoll(): void {
  if (!pending) return
  clearPendingTimer()
  const wait = Math.max(pending.intervalMs, 1000)
  pending.timer = setTimeout(() => {
    void pollOnce()
  }, wait)
}

async function pollOnce(): Promise<void> {
  if (!pending) return
  if (Date.now() > pending.expiresAt) {
    pending.error = 'Device code expired. Start Connect GitHub again.'
    clearPendingTimer()
    return
  }
  const clientId = resolveGithubClientId()
  if (!clientId) {
    pending.error = 'GitHub client ID is not configured'
    clearPendingTimer()
    return
  }
  try {
    const json = (await postForm(ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: pending.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })) as TokenSuccess & TokenPending

    if (typeof json.access_token === 'string' && json.access_token) {
      setGithubAccessToken(json.access_token)
      cancelGithubAuth()
      logger.info('GitHub device OAuth succeeded', { scope: 'github-auth' })
      return
    }

    const err = typeof json.error === 'string' ? json.error : 'unknown'
    if (err === 'authorization_pending') {
      schedulePoll()
      return
    }
    if (err === 'slow_down') {
      const bump =
        typeof json.interval === 'number' && json.interval > 0
          ? json.interval * 1000
          : pending.intervalMs + 5000
      pending.intervalMs = bump
      schedulePoll()
      return
    }
    pending.error =
      typeof json.error_description === 'string' && json.error_description
        ? json.error_description
        : `GitHub authorization failed (${err})`
    clearPendingTimer()
  } catch (err) {
    pending.error = err instanceof Error ? err.message : String(err)
    clearPendingTimer()
    logger.warn('GitHub device OAuth poll failed', { scope: 'github-auth', err })
  }
}

export async function startGithubAuth(): Promise<GithubAuthStatus> {
  const clientId = resolveGithubClientId()
  if (!clientId) {
    throw new Error(
      'GitHub client ID is not configured. Set VYOTIQ_GITHUB_CLIENT_ID or Settings → Agent → GitHub client ID.'
    )
  }

  cancelGithubAuth()

  const json = (await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: DEFAULT_SCOPE
  })) as Partial<DeviceCodeResponse> & { error?: string; error_description?: string }

  if (
    typeof json.device_code !== 'string' ||
    typeof json.user_code !== 'string' ||
    typeof json.verification_uri !== 'string'
  ) {
    throw new Error(
      typeof json.error_description === 'string'
        ? json.error_description
        : typeof json.error === 'string'
          ? json.error
          : 'Failed to start GitHub device authorization'
    )
  }

  const intervalSec =
    typeof json.interval === 'number' && json.interval > 0 ? json.interval : 5
  const expiresIn =
    typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 900

  pending = {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    intervalMs: intervalSec * 1000,
    expiresAt: Date.now() + expiresIn * 1000,
    timer: null,
    error: null
  }

  try {
    const uri = new URL(json.verification_uri)
    if (uri.protocol !== 'https:') {
      throw new Error('GitHub verification URL must be https')
    }
    await shell.openExternal(uri.toString())
  } catch (err) {
    logger.warn('Failed to open GitHub verification URI', { scope: 'github-auth', err })
  }

  schedulePoll()
  return githubAuthStatus()
}

export async function logoutGithubAuth(): Promise<GithubAuthStatus> {
  cancelGithubAuth()
  clearGithubAccessToken()
  return githubAuthStatus()
}

/** Use only the app-stored token for `gh` CLI; never fall back to ambient env. */
export function resolveGhTokenForCli(): string | undefined {
  try {
    return getGithubAccessToken() ?? undefined
  } catch (err) {
    logger.warn('GitHub token cannot be read from secure storage', {
      scope: 'github-auth',
      err
    })
    return undefined
  }
}
