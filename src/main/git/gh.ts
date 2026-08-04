import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type { PrChangeType, PrReview, PrView } from '../../shared/ipc'
import { resolveGhTokenForCli } from '@main/git/githubAuth'

const execFile = promisify(execFileCb)

const TIMEOUT_MS = 30_000
const DIFF_TIMEOUT_MS = 60_000
const MERGE_TIMEOUT_MS = 120_000
const MAX_BUFFER = 8 * 1024 * 1024
const DIFF_CAP_CHARS = 100_000

function capDiff(text: string): string {
  if (text.length <= DIFF_CAP_CHARS) return text
  return `${text.slice(0, DIFF_CAP_CHARS)}\n\n… [diff truncated]`
}

function buildGhEnv(): NodeJS.ProcessEnv {
  const token = resolveGhTokenForCli()
  return {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...(token ? { GH_TOKEN: token } : {})
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never'
}

async function gh(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFile('gh', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: buildGhEnv()
  })
  return stdout
}

async function git(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: GIT_ENV
  })
  return stdout
}

export async function ghAvailable(): Promise<boolean> {
  try {
    await execFile('gh', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: buildGhEnv()
    })
    return true
  } catch {
    return false
  }
}

type GhReviewJson = {
  author?: { login?: string } | null
  state?: string
  body?: string
  submittedAt?: string | null
}

type GhPrJson = {
  number?: number
  title?: string
  url?: string
  state?: string
  baseRefName?: string
  headRefName?: string
  baseRefOid?: string
  headRefOid?: string
  body?: string
  additions?: number
  deletions?: number
  files?: Array<{
    path?: string
    additions?: number
    deletions?: number
    changeType?: string
  }>
  commits?: Array<{
    oid?: string
    messageHeadline?: string
    authors?: Array<{ name?: string; login?: string }>
  }>
  statusCheckRollup?: Array<{
    name?: string
    state?: string
    conclusion?: string | null
  }>
  reviews?: GhReviewJson[]
  latestReviews?: GhReviewJson[]
  reviewDecision?: string
  reviewRequests?: Array<{ login?: string } | string | null>
}

function mapChangeType(raw: string | undefined): PrChangeType {
  switch ((raw ?? '').toUpperCase()) {
    case 'ADDED':
      return 'ADDED'
    case 'DELETED':
      return 'DELETED'
    case 'MODIFIED':
      return 'MODIFIED'
    case 'RENAMED':
      return 'RENAMED'
    case 'COPIED':
      return 'COPIED'
    case 'CHANGED':
      return 'CHANGED'
    default:
      return 'UNKNOWN'
  }
}

function mapReview(r: GhReviewJson): PrReview {
  return {
    author: r.author?.login ?? 'unknown',
    state: r.state ?? 'PENDING',
    body: r.body ?? '',
    submittedAt: r.submittedAt ?? null
  }
}

function mapReviewRequest(r: { login?: string } | string | null | undefined): string | null {
  if (!r) return null
  if (typeof r === 'string') return r || null
  return r.login || null
}

const PR_VIEW_JSON_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'baseRefName',
  'headRefName',
  'baseRefOid',
  'headRefOid',
  'body',
  'additions',
  'deletions',
  'files',
  'commits',
  'statusCheckRollup',
  'reviews',
  'latestReviews',
  'reviewDecision',
  'reviewRequests'
] as const

/** Older gh / reduced GraphQL surface when optional review fields are unsupported. */
const PR_VIEW_JSON_FIELDS_FALLBACK = [
  'number',
  'title',
  'url',
  'state',
  'baseRefName',
  'headRefName',
  'baseRefOid',
  'headRefOid',
  'body',
  'additions',
  'deletions',
  'files',
  'commits',
  'statusCheckRollup'
] as const

function execErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const withIo = err as Error & { stderr?: string; stdout?: string }
  return [err.message, withIo.stderr, withIo.stdout].filter(Boolean).join('\n')
}

/** Expected “no PR / no GitHub repo” outcomes — return null instead of failing IPC. */
function isExpectedPrAbsence(message: string): boolean {
  return /no pull requests found|no open pull requests|could not find a pull request|no pull request|not a git repository|unable to determine base repository|could not determine base repository|could not resolve to a (?:repository|pullrequest)|no git remotes found|no remotes found|no default remote|does not have a remote|repository not found|HTTP 404/i.test(
    message
  )
}

function isUnknownJsonFieldError(message: string): boolean {
  return /unknown json field|unknown field|is not a valid field/i.test(message)
}

function mapPrView(data: GhPrJson): PrView | null {
  if (typeof data.number !== 'number') return null
  return {
    number: data.number,
    title: data.title ?? '',
    url: data.url ?? '',
    state: data.state ?? 'OPEN',
    baseRefName: data.baseRefName ?? '',
    headRefName: data.headRefName ?? '',
    baseRefOid: data.baseRefOid ?? '',
    headRefOid: data.headRefOid ?? '',
    body: data.body ?? '',
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    files: (data.files ?? []).map((f) => ({
      path: f.path ?? '',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      changeType: mapChangeType(f.changeType)
    })),
    commits: (data.commits ?? []).map((c) => ({
      oid: c.oid ?? '',
      messageHeadline: c.messageHeadline ?? '',
      authors: (c.authors ?? [])
        .map((a) => a.name || a.login || '')
        .filter(Boolean)
    })),
    checks: (data.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? 'check',
      state: c.state ?? 'UNKNOWN',
      conclusion: c.conclusion ?? null
    })),
    reviews: (data.reviews ?? []).map(mapReview),
    latestReviews: (data.latestReviews ?? []).map(mapReview),
    reviewDecision: data.reviewDecision ?? '',
    reviewRequests: (data.reviewRequests ?? [])
      .map(mapReviewRequest)
      .filter((login): login is string => Boolean(login))
  }
}

/** Current branch PR, or null when none exists for this branch. Throws on gh/auth/network errors. */
export async function prView(cwd: string): Promise<PrView | null> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }

  const fetchJson = async (fields: readonly string[]): Promise<PrView | null> => {
    const raw = await gh(['pr', 'view', '--json', fields.join(',')], cwd)
    return mapPrView(JSON.parse(raw) as GhPrJson)
  }

  try {
    return await fetchJson(PR_VIEW_JSON_FIELDS)
  } catch (err) {
    const message = execErrorText(err)
    if (isExpectedPrAbsence(message)) return null
    if (isUnknownJsonFieldError(message)) {
      try {
        return await fetchJson(PR_VIEW_JSON_FIELDS_FALLBACK)
      } catch (fallbackErr) {
        const fallbackMessage = execErrorText(fallbackErr)
        if (isExpectedPrAbsence(fallbackMessage)) return null
        throw fallbackErr instanceof Error ? fallbackErr : new Error(fallbackMessage)
      }
    }
    throw err instanceof Error ? err : new Error(message)
  }
}

export async function prDiff(
  cwd: string,
  opts: { path?: string; ignoreWhitespace?: boolean } = {}
): Promise<{ content: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }

  let baseOid = ''
  let headOid = ''
  try {
    const raw = await gh(['pr', 'view', '--json', 'baseRefOid,headRefOid'], cwd)
    const data = JSON.parse(raw) as { baseRefOid?: string; headRefOid?: string }
    baseOid = data.baseRefOid ?? ''
    headOid = data.headRefOid ?? ''
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }

  if (!baseOid || !headOid) {
    // Fallback: full PR patch via gh when OIDs are unavailable.
    const args = ['pr', 'diff', '--patch', '--color=never']
    let out = await gh(args, cwd, DIFF_TIMEOUT_MS)
    if (opts.path) {
      out = extractFilePatch(out, opts.path)
    }
    return { content: capDiff(out) }
  }

  const args = ['diff', '--no-color', '--no-ext-diff', '--binary']
  if (opts.ignoreWhitespace) args.push('--ignore-all-space')
  args.push(`${baseOid}...${headOid}`)
  if (opts.path) args.push('--', opts.path)

  try {
    const content = await git(args, cwd, DIFF_TIMEOUT_MS)
    return { content: capDiff(content) }
  } catch (err) {
    // Objects may be missing locally; fall back to gh pr diff.
    const message = err instanceof Error ? err.message : String(err)
    try {
      let out = await gh(['pr', 'diff', '--patch', '--color=never'], cwd, DIFF_TIMEOUT_MS)
      if (opts.path) out = extractFilePatch(out, opts.path)
      return { content: capDiff(out) }
    } catch {
      throw new Error(message)
    }
  }
}

/** Keep only the unified-diff hunks for one path from a multi-file patch. */
function extractFilePatch(patch: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const lines = patch.split(/\r?\n/)
  const out: string[] = []
  let include = false
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const markerA = ` a/${normalized}`
      const markerB = ` b/${normalized}`
      include = line.includes(markerA) || line.includes(markerB)
    }
    if (include) out.push(line)
  }
  return out.join('\n')
}

export async function prMerge(
  cwd: string,
  method: 'squash' | 'merge' | 'rebase'
): Promise<{ detail: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const flag =
    method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge'
  try {
    const out = await gh(['pr', 'merge', flag, '--delete-branch=false'], cwd, MERGE_TIMEOUT_MS)
    return { detail: out.trim() || `Merged with ${method}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }
}

export async function prClose(cwd: string): Promise<{ detail: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  try {
    const out = await gh(['pr', 'close'], cwd, TIMEOUT_MS)
    return { detail: out.trim() || 'Pull request closed' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }
}

export async function prEditTitle(cwd: string, title: string): Promise<{ title: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const trimmed = title.trim()
  if (!trimmed) throw new Error('Title cannot be empty')
  try {
    await gh(['pr', 'edit', '--title', trimmed], cwd, TIMEOUT_MS)
    return { title: trimmed }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }
}
