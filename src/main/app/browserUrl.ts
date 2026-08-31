import { resolve as resolvePath } from 'path'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
import { assertResolvedInsideWorkspace } from '../workspace/safePath'

/** Agent browser accepts any http(s) URL including localhost and private networks. */
export function normalizeBrowserUrl(raw: string, opts?: { workspaceRoot?: string }): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('URL is required')
  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    if (url.protocol === 'file:' && opts?.workspaceRoot) {
      // Only files that resolve inside the browser tab's workspace are ever
      // allowed — the same fence file tools enforce.
      assertFileUrlInsideWorkspace(url, opts.workspaceRoot)
      return url
    }
    throw new Error(`Unsupported URL scheme: ${url.protocol}`)
  }
  return url
}

/**
 * Containment check for a `file:` URL against the workspace root.
 *
 * The path is decoded (percent-encoded spaces/segments are routine in real
 * workspace paths) and then resolved through the audited safePath primitive:
 * canonicalize + realpath walk resolve symlinks and any `..` segments before
 * the inside-root check, so traversal tricks cannot escape. Malformed
 * encodings and every escape attempt reject with the workspace-scope error.
 */
function assertFileUrlInsideWorkspace(url: URL, workspaceRoot: string): void {
  const root = canonicalizeWorkspacePath(workspaceRoot)
  // Windows treats `\` as a path separator, so an encoded backslash (%5C) can
  // mean more separators to the filesystem than the URL parser saw — a
  // traversal channel. Reject before any decoding; literal backslashes never
  // appear in a file: pathname (the parser already maps them to `/`).
  if (/%5c/i.test(url.pathname)) {
    throw new Error('file: URLs must point inside the workspace')
  }
  let withoutSlash: string
  try {
    const rawPath = decodeURIComponent(url.pathname)
    // file:///C:/dir/file.html → pathname '/C:/dir/file.html'; drop the one
    // leading slash so the drive-letter path resolves on Windows.
    withoutSlash = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
  } catch {
    throw new Error('file: URLs must point inside the workspace')
  }
  const target = resolvePath(root, withoutSlash)
  try {
    assertResolvedInsideWorkspace(root, target)
  } catch (err) {
    throw new Error('file: URLs must point inside the workspace', { cause: err })
  }
}

export const DEFAULT_SNAPSHOT_CHARS = 40_000
/** Default navigation timeout ceiling used only when the model omits timeoutMs. */
export const MAX_NAV_TIMEOUT_MS = 60_000
/** Default wait-for-* timeout used only when the model omits timeoutMs. */
export const MAX_WAIT_TIMEOUT_MS = 60_000
/** Documented default for browser_type / browser_fill; not a reject cap. */
export const MAX_TYPE_CHARS = 4_000
/** Default navigation timeout (navigate / search). */
export const DEFAULT_NAV_TIMEOUT_MS = 30_000
/** Default wait-for-* timeout (selector / url / text). */
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000
/** Default post-action settle wait. */
export const SETTLE_FALLBACK_MS = 1_200
