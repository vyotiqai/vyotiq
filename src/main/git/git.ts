import { execFile as execFileCb } from 'child_process'
import { existsSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { GitChangedFile, GitStatus, GitStatusResult } from '../../shared/ipc'
import { namedGitBranch } from '../../shared/utils/gitBranch'
import { isSafeWorkspaceRelPath } from '../../shared/utils/workspacePath'
import { resolveInsideWorkspace } from '../workspace/safePath'

const execFile = promisify(execFileCb)

const READ_TIMEOUT_MS = 5000
const WRITE_TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 120_000
const MAX_BUFFER = 4 * 1024 * 1024
const GIT_PROBE_TTL_MS = 60_000

let gitBinaryCache: { ok: boolean; checkedAt: number } | null = null

/** Whether `git` is on PATH. Cached briefly so chrome does not spam `--version`. */
export async function gitAvailable(): Promise<boolean> {
  const now = Date.now()
  if (gitBinaryCache && now - gitBinaryCache.checkedAt < GIT_PROBE_TTL_MS) {
    return gitBinaryCache.ok
  }
  try {
    await execFile('git', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: GIT_ENV
    })
    gitBinaryCache = { ok: true, checkedAt: now }
    return true
  } catch {
    gitBinaryCache = { ok: false, checkedAt: now }
    return false
  }
}

/** @internal */
export function resetGitAvailableCacheForTests(): void {
  gitBinaryCache = null
}

/** Beyond this the list stops being a summary and starts being a file tree. */
const MAX_FILES = 200
/** Counting lines means reading the file, so only do it for plausible source. */
const UNTRACKED_LINE_COUNT_MAX_BYTES = 512 * 1024

/**
 * Git never runs interactively here. A credential or editor prompt in a process
 * with no terminal would hang until the timeout instead of failing cleanly.
 */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never'
}

export function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, '.git'))
}

async function git(args: string[], cwd: string, timeout: number): Promise<string> {
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

/**
 * Like `git`, but keeps stdout when the process exits 1.
 * `git diff --no-index` implies `--exit-code` and exits 1 whenever the files differ
 * (see git-diff docs) — that is success for our purposes.
 */
async function gitDiffStdout(args: string[], cwd: string, timeout: number): Promise<string> {
  try {
    return await git(args, cwd, timeout)
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 1 &&
      'stdout' in err &&
      typeof (err as { stdout?: unknown }).stdout === 'string'
    ) {
      return (err as { stdout: string }).stdout
    }
    throw err
  }
}

async function gitQuiet(args: string[], cwd: string, timeout: number): Promise<string | null> {
  try {
    return await git(args, cwd, timeout)
  } catch {
    return null
  }
}

/** Split NUL-delimited git output, dropping the trailing empty field. */
function splitNul(out: string): string[] {
  return out.split('\0').filter((part) => part.length > 0)
}

function countFileLines(cwd: string, relPath: string): number {
  try {
    // Directory placeholders from `git status -unormal` (e.g. `node_modules/`).
    if (relPath.endsWith('/') || relPath.endsWith('\\')) return 0
    const full = join(cwd, relPath)
    const stat = statSync(full)
    if (!stat.isFile() || stat.size > UNTRACKED_LINE_COUNT_MAX_BYTES) return 0
    const text = readFileSync(full, 'utf8')
    if (!text) return 0
    const lines = text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return lines.length
  } catch {
    return 0
  }
}

/** Skip sync reads for dependency trees and other junk that blows up chrome status. */
function shouldCountUntrackedLines(relPath: string): boolean {
  if (relPath.endsWith('/') || relPath.endsWith('\\')) return false
  return !isNoisePath(relPath)
}

/** Paths we never surface in status chrome (untracked dependency / build trees). */
function isNoisePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/')
  for (const part of parts) {
    if (
      part === 'node_modules' ||
      part === '.git' ||
      part === 'dist' ||
      part === 'build' ||
      part === 'coverage' ||
      part === '.next' ||
      part === 'target' ||
      part === '__pycache__'
    ) {
      return true
    }
  }
  return false
}

/**
 * Parse `git diff --numstat -z` into path → line deltas.
 */
async function numstatMap(cwd: string, args: string[]): Promise<Map<string, {
  added: number
  removed: number
  binary: boolean
}>> {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>()
  const stdout = await gitQuiet(args, cwd, READ_TIMEOUT_MS)
  if (!stdout) return out
  for (const record of splitNul(stdout)) {
    const parts = record.split('\t')
    if (parts.length < 3) continue
    const [addedRaw, removedRaw, path] = parts as [string, string, string]
    const added = addedRaw === '-' ? 0 : Number(addedRaw)
    const removed = removedRaw === '-' ? 0 : Number(removedRaw)
    out.set(path, {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
      binary: addedRaw === '-'
    })
  }
  return out
}

function statusFor(code: string): GitChangedFile['status'] {
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** Map porcelain XY columns to staged / unstaged sides. */
function flagsFromPorcelain(code: string): { staged: boolean; unstaged: boolean } {
  if (code === '??' || code === '!!') {
    return { staged: false, unstaged: true }
  }
  const x = code[0] ?? ' '
  const y = code[1] ?? ' '
  if (
    x === 'U' ||
    y === 'U' ||
    code === 'DD' ||
    code === 'AU' ||
    code === 'UD' ||
    code === 'UA' ||
    code === 'DU' ||
    code === 'AA'
  ) {
    return { staged: true, unstaged: true }
  }
  return { staged: x !== ' ', unstaged: y !== ' ' }
}

function emptyFile(path: string, status: GitChangedFile['status']): GitChangedFile {
  return {
    path,
    status,
    added: 0,
    removed: 0,
    addedStaged: 0,
    removedStaged: 0,
    addedUnstaged: 0,
    removedUnstaged: 0,
    binary: false,
    staged: false,
    unstaged: false
  }
}

export async function readGitStatus(cwd: string): Promise<GitStatusResult> {
  if (!(await gitAvailable())) {
    return { kind: 'unavailable', detail: 'Git is not installed or not on PATH' }
  }
  if (!isGitRepo(cwd)) return { kind: 'not_repo' }

  const branchRaw = await gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, READ_TIMEOUT_MS)
  const branch = namedGitBranch(branchRaw)
  const hasCommits = (await gitQuiet(['rev-parse', '--verify', 'HEAD'], cwd, READ_TIMEOUT_MS)) != null

  const stagedArgs = hasCommits
    ? ['diff', '--numstat', '--no-renames', '-z', '--cached', 'HEAD']
    : ['diff', '--numstat', '--no-renames', '-z', '--cached']
  const unstagedArgs = ['diff', '--numstat', '--no-renames', '-z']
  const [stagedMap, unstagedMap] = await Promise.all([
    numstatMap(cwd, stagedArgs),
    numstatMap(cwd, unstagedArgs)
  ])

  const tracked = new Map<string, GitChangedFile>()
  const ensure = (path: string, status: GitChangedFile['status'] = 'modified'): GitChangedFile => {
    let file = tracked.get(path)
    if (!file) {
      file = emptyFile(path, status)
      tracked.set(path, file)
    }
    return file
  }

  for (const [path, delta] of stagedMap) {
    const file = ensure(path)
    file.addedStaged = delta.added
    file.removedStaged = delta.removed
    file.binary = file.binary || delta.binary
  }
  for (const [path, delta] of unstagedMap) {
    const file = ensure(path)
    file.addedUnstaged = delta.added
    file.removedUnstaged = delta.removed
    file.binary = file.binary || delta.binary
  }

  // Prefer `-uall` so real project files under new dirs stay visible (e.g. `sub/new.txt`).
  // Skip dependency trees — home workspace had 637× `node_modules/**` untracked with no
  // .gitignore; sync line-counting them made git:status multi-second under startup load.
  // `--no-renames`: porcelain -z rename/copy records are two NUL fields
  // (`R new\0old\0`); without this, the old path is parsed as `XY + path`
  // and invents ghosts like `.txt` from `old.txt`.
  const porcelain = await gitQuiet(
    ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'],
    cwd,
    READ_TIMEOUT_MS
  )
  if (porcelain != null) {
    let untrackedCounted = 0
    for (const record of splitNul(porcelain)) {
      const code = record.slice(0, 2)
      const path = record.slice(3)
      if (!path) continue
      if (isNoisePath(path)) continue
      const flags = flagsFromPorcelain(code)

      if (code === '??') {
        const canCount =
          shouldCountUntrackedLines(path) && untrackedCounted < MAX_FILES
        const added = canCount ? countFileLines(cwd, path) : 0
        if (canCount) untrackedCounted += 1
        tracked.set(path, {
          ...emptyFile(path, 'untracked'),
          added,
          addedUnstaged: added,
          binary: false,
          ...flags
        })
        continue
      }
      const existing = ensure(path, statusFor(code))
      existing.status = statusFor(code)
      existing.staged = flags.staged
      existing.unstaged = flags.unstaged
    }
  }

  for (const file of tracked.values()) {
    // Porcelain may mark staged/unstaged even when numstat is empty (mode-only).
    if (!file.staged && (file.addedStaged > 0 || file.removedStaged > 0)) file.staged = true
    if (!file.unstaged && (file.addedUnstaged > 0 || file.removedUnstaged > 0)) file.unstaged = true
    file.added = file.addedStaged + file.addedUnstaged
    file.removed = file.removedStaged + file.removedUnstaged
  }

  // Numstat can still list noise paths if they were already tracked/staged;
  // keep chrome aligned with the porcelain filter.
  const all = [...tracked.values()]
    .filter((file) => !isNoisePath(file.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  const files = all.slice(0, MAX_FILES)

  let added = 0
  let removed = 0
  for (const file of all) {
    added += file.added
    removed += file.removed
  }

  const remote = await gitQuiet(['remote'], cwd, READ_TIMEOUT_MS)

  const status: GitStatus = {
    branch,
    files,
    truncated: all.length > files.length,
    fileCount: all.length,
    added,
    removed,
    hasRemote: Boolean(remote?.trim()),
    hasCommits
  }
  return { kind: 'ok', status }
}

const DIFF_CAP_CHARS = 100_000

export type GitDiffOptions = {
  path?: string
  staged?: boolean
  ignoreWhitespace?: boolean
  sha?: string
}

function capDiff(text: string): string {
  if (text.length <= DIFF_CAP_CHARS) return text
  return text.slice(0, DIFF_CAP_CHARS) + `\n… (diff truncated at ${DIFF_CAP_CHARS} chars)`
}

/**
 * Untracked paths are invisible to plain `git diff` / `git diff --cached`.
 * Compare against `/dev/null` via `--no-index` (Git for Windows accepts this path).
 * https://git-scm.com/docs/git-diff
 */
async function readUntrackedFileDiff(
  cwd: string,
  relPath: string,
  ignoreWhitespace?: boolean
): Promise<string | null> {
  const normalized = relPath.replace(/\\/g, '/').trim()
  if (!normalized || normalized.includes('\0')) return null

  let abs: string
  try {
    abs = resolveInsideWorkspace(cwd, normalized)
  } catch {
    return null
  }

  try {
    const stat = statSync(abs)
    if (!stat.isFile()) return null
  } catch {
    return null
  }

  const tracked = await gitQuiet(['ls-files', '--', normalized], cwd, READ_TIMEOUT_MS)
  if (tracked?.trim()) return null

  const args = ['diff', '--no-index', '--no-color', '--no-ext-diff']
  if (ignoreWhitespace) args.push('-w')
  args.push('--', '/dev/null', normalized)

  try {
    const stdout = await gitDiffStdout(args, cwd, READ_TIMEOUT_MS)
    const text = stdout.trimEnd()
    return text || null
  } catch {
    return null
  }
}

/** Unified diff against HEAD (or staged index / commit). Capped for tool output. */
export async function readGitDiff(
  cwd: string,
  opts: GitDiffOptions = {}
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (!isGitRepo(cwd)) return { ok: false, error: 'Not a git repository' }

  // Reject abs/UNC/drive/`..` paths like stage/unstage do — never pass raw input to git.
  const requestedPath = opts.path?.trim()
  const path = requestedPath ? sanitizeRelativePaths([requestedPath])[0] : undefined
  if (requestedPath && !path) return { ok: false, error: 'Invalid path' }

  const sha = opts.sha?.trim()
  if (sha) {
    const args = ['show', '--no-color', '--no-ext-diff', '--format=']
    if (opts.ignoreWhitespace) args.push('-w')
    args.push(sha)
    if (path) {
      args.push('--', path)
    }
    try {
      const stdout = await git(args, cwd, READ_TIMEOUT_MS)
      const text = stdout.trimEnd()
      if (!text) return { ok: true, content: '(no changes in commit)' }
      return { ok: true, content: capDiff(text) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }

  const hasCommits =
    (await gitQuiet(['rev-parse', '--verify', 'HEAD'], cwd, READ_TIMEOUT_MS)) != null
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (opts.ignoreWhitespace) args.push('-w')
  if (opts.staged || !hasCommits) args.push('--cached')
  if (path) {
    args.push('--', path)
  }

  try {
    const stdout = await git(args, cwd, READ_TIMEOUT_MS)
    const text = stdout.trimEnd()
    if (text) return { ok: true, content: capDiff(text) }

    // Untracked files never appear in worktree/index diffs — synthesize a full add.
    if (path && !opts.staged) {
      const untracked = await readUntrackedFileDiff(cwd, path, opts.ignoreWhitespace)
      if (untracked) return { ok: true, content: capDiff(untracked) }
    }

    return {
      ok: true,
      content: opts.staged || !hasCommits ? '(no staged changes)' : '(no unstaged changes)'
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

export type GitLogEntry = {
  sha: string
  shortSha: string
  subject: string
  author: string
  relativeDate: string
}

/** Recent commits for the Changes → Commits scope. */
export async function readGitLog(cwd: string, limit = 40): Promise<GitLogEntry[]> {
  if (!isGitRepo(cwd)) return []
  const capped = Math.min(Math.max(1, limit), 100)
  const stdout = await gitQuiet(
    ['log', `-n${capped}`, '--format=%H%x09%h%x09%s%x09%an%x09%cr'],
    cwd,
    READ_TIMEOUT_MS
  )
  if (!stdout?.trim()) return []
  const out: GitLogEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [sha, shortSha, subject, author, relativeDate] = line.split('\t')
    if (!sha || !shortSha) continue
    out.push({
      sha,
      shortSha,
      subject: subject ?? '',
      author: author ?? '',
      relativeDate: relativeDate ?? ''
    })
  }
  return out
}

/** Files changed in a single commit (numstat). */
export async function readGitCommitFiles(cwd: string, sha: string): Promise<GitChangedFile[]> {
  if (!isGitRepo(cwd)) return []
  const stdout = await gitQuiet(
    ['show', '--numstat', '--format=', '--no-renames', sha.trim()],
    cwd,
    READ_TIMEOUT_MS
  )
  if (!stdout?.trim()) return []
  const out: GitChangedFile[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addedRaw, removedRaw, path] = parts as [string, string, string]
    const added = addedRaw === '-' ? 0 : Number(addedRaw)
    const removed = removedRaw === '-' ? 0 : Number(removedRaw)
    const binary = addedRaw === '-'
    let status: GitChangedFile['status'] = 'modified'
    if (!binary && added > 0 && removed === 0) status = 'added'
    if (!binary && added === 0 && removed > 0) status = 'deleted'
    out.push({
      path,
      status,
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
      addedStaged: 0,
      removedStaged: 0,
      addedUnstaged: Number.isFinite(added) ? added : 0,
      removedUnstaged: Number.isFinite(removed) ? removed : 0,
      binary,
      staged: false,
      unstaged: false
    })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export type CommitOutcome = { committed: boolean; pushed: boolean; detail: string }
export type CommitMode = 'all' | 'staged'

/** Dirty paths from porcelain, excluding chrome noise trees (node_modules, etc.). */
async function listNonNoiseDirtyPaths(cwd: string): Promise<string[]> {
  const porcelain = await gitQuiet(
    ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'],
    cwd,
    READ_TIMEOUT_MS
  )
  if (!porcelain?.trim()) return []
  const paths: string[] = []
  for (const record of splitNul(porcelain)) {
    const path = record.slice(3)
    if (!path || isNoisePath(path)) continue
    paths.push(path)
  }
  return paths
}

const STAGE_PATH_BATCH = 64

async function stageNonNoisePaths(cwd: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += STAGE_PATH_BATCH) {
    const chunk = paths.slice(i, i + STAGE_PATH_BATCH)
    // `-A` with pathspecs stages adds, mods, and deletions for those paths only.
    await git(['add', '-A', '--', ...chunk], cwd, WRITE_TIMEOUT_MS)
  }
}

/** Commit whatever is staged and optionally push. Shared by commitAll/commitPaths. */
async function commitStagedAndMaybePush(
  cwd: string,
  message: string,
  push: boolean
): Promise<CommitOutcome> {
  const staged = await gitQuiet(['diff', '--cached', '--name-only'], cwd, READ_TIMEOUT_MS)
  if (!staged?.trim()) {
    return { committed: false, pushed: false, detail: 'Nothing to commit' }
  }

  await git(['commit', '-m', message], cwd, WRITE_TIMEOUT_MS)
  if (!push) return { committed: true, pushed: false, detail: 'Committed' }

  const remote = await gitQuiet(['remote'], cwd, READ_TIMEOUT_MS)
  if (!remote?.trim()) {
    return { committed: true, pushed: false, detail: 'Committed. No remote to push to.' }
  }

  // A first push on a fresh branch has no upstream, so set one rather than fail.
  const branch = (await gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, READ_TIMEOUT_MS))?.trim()
  const pushArgs =
    branch && branch !== 'HEAD' ? ['push', '--set-upstream', 'origin', branch] : ['push']
  await git(pushArgs, cwd, PUSH_TIMEOUT_MS)
  return { committed: true, pushed: true, detail: 'Committed and pushed' }
}

export async function commitAll(
  cwd: string,
  message: string,
  push: boolean,
  mode: CommitMode = 'all'
): Promise<CommitOutcome> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')

  if (mode === 'all') {
    // Never `git add -A`: that stages hidden noise the Changes UI filters out.
    const paths = await listNonNoiseDirtyPaths(cwd)
    await stageNonNoisePaths(cwd, paths)
  }

  return commitStagedAndMaybePush(cwd, message, push)
}

export type CommitPathsOutcome = CommitOutcome & {
  /** Dirty paths intentionally left uncommitted (not touched by the agent). */
  skipped: string[]
}

/**
 * Commit only the given relative paths — unrelated dirty files stay uncommitted.
 * Paths already staged by the user remain staged and are committed too.
 */
export async function commitPaths(
  cwd: string,
  message: string,
  push: boolean,
  paths: string[]
): Promise<CommitPathsOutcome> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')

  const dirty = new Set(await listNonNoiseDirtyPaths(cwd))
  const wanted = sanitizeRelativePaths(paths)
  const toStage = wanted.filter((path) => dirty.has(path))
  if (toStage.length > 0) {
    await stageNonNoisePaths(cwd, toStage)
  }

  const outcome = await commitStagedAndMaybePush(cwd, message, push)
  const skipped = [...dirty].filter((path) => !toStage.includes(path)).sort()
  return { ...outcome, skipped }
}

/** Stage every visible unstaged / untracked path (excludes chrome noise trees). */
export async function stageAll(cwd: string): Promise<{ staged: boolean; detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const paths = await listNonNoiseDirtyPaths(cwd)
  if (paths.length === 0) {
    return { staged: false, detail: 'Nothing to stage' }
  }
  await stageNonNoisePaths(cwd, paths)
  return { staged: true, detail: 'Staged all changes' }
}

/** @internal Exported for unit tests — rejects abs/UNC/drive/`..` like isSafeWorkspaceRelPath. */
export function sanitizeRelativePaths(paths: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').trim()
    if (!isSafeWorkspaceRelPath(path) || isNoisePath(path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** Stage specific relative paths (noise trees rejected). */
export async function stagePaths(
  cwd: string,
  paths: string[]
): Promise<{ staged: boolean; detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const clean = sanitizeRelativePaths(paths)
  if (clean.length === 0) {
    return { staged: false, detail: 'Nothing to stage' }
  }
  await stageNonNoisePaths(cwd, clean)
  return {
    staged: true,
    detail: clean.length === 1 ? `Staged ${clean[0]}` : `Staged ${clean.length} paths`
  }
}

/** Unstage specific relative paths (`git restore --staged`). */
export async function unstagePaths(
  cwd: string,
  paths: string[]
): Promise<{ unstaged: boolean; detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const clean = sanitizeRelativePaths(paths)
  if (clean.length === 0) {
    return { unstaged: false, detail: 'Nothing to unstage' }
  }
  for (let i = 0; i < clean.length; i += STAGE_PATH_BATCH) {
    const chunk = clean.slice(i, i + STAGE_PATH_BATCH)
    await git(['restore', '--staged', '--', ...chunk], cwd, WRITE_TIMEOUT_MS)
  }
  return {
    unstaged: true,
    detail: clean.length === 1 ? `Unstaged ${clean[0]}` : `Unstaged ${clean.length} paths`
  }
}

export type GitBranchEntry = {
  name: string
  current: boolean
}

/** Local branches (`git branch --list`). */
export async function listLocalBranches(cwd: string): Promise<GitBranchEntry[]> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const raw = await git(['branch', '--list', '--format=%(refname:short)%09%(HEAD)'], cwd, READ_TIMEOUT_MS)
  const out: GitBranchEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const [name, head] = trimmed.split('\t')
    if (!name?.trim()) continue
    out.push({ name: name.trim(), current: head?.trim() === '*' })
  }
  out.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Check out an existing local branch. */
export async function checkoutBranch(
  cwd: string,
  branch: string
): Promise<{ detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const name = branch.trim()
  if (!name || name.includes('..') || /[\s\\]/.test(name)) {
    throw new Error('Invalid branch name')
  }
  await git(['checkout', name], cwd, WRITE_TIMEOUT_MS)
  return { detail: `Checked out ${name}` }
}
