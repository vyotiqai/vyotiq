import { canonicalizeWorkspacePath, isWindowsStylePath } from './workspacePath'

/** Compare two workspace paths, ignoring case only for Windows-style paths. */
export function workspacePathsEqual(a: string, b: string): boolean {
  const left = canonicalizeWorkspacePath(a)
  const right = canonicalizeWorkspacePath(b)
  if (isWindowsStylePath(left) || isWindowsStylePath(right)) {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

/**
 * Look up a path-keyed record with equality that matches Windows casing and
 * path canonicalization — direct index alone misses legacy / alternate keys.
 */
export function findByWorkspacePath<T>(
  map: Record<string, T | undefined>,
  path: string
): T | null {
  if (map[path] !== undefined) return map[path] ?? null
  for (const key of Object.keys(map)) {
    if (workspacePathsEqual(key, path)) return map[key] ?? null
  }
  return null
}
