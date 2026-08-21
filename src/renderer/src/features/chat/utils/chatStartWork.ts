const NAMED_PATH_CAP = 2

function displayPath(path: string): string {
  return path.replace(/\\/g, '/').trim()
}

/** Label for the empty-chat start-work control. Null when there is nothing to review. */
export function formatStartWorkLabel(
  files: ReadonlyArray<{ path: string }>,
  fileCount: number
): string | null {
  if (fileCount <= 0) return null
  const named: string[] = []
  for (const file of files) {
    const path = displayPath(file.path)
    if (!path) continue
    named.push(path)
    if (named.length >= NAMED_PATH_CAP) break
  }
  if (named.length === 0) {
    return fileCount === 1 ? 'Review 1 uncommitted file' : `Review ${fileCount} uncommitted files`
  }
  const rest = Math.max(0, fileCount - named.length)
  const names = named.join(', ')
  return rest > 0 ? `Review ${names}, +${rest}` : `Review ${names}`
}

/** Composer draft filled by the start-work control. Null when there is nothing to review. */
export function formatStartWorkDraft(
  files: ReadonlyArray<{ path: string }>,
  fileCount: number
): string | null {
  const label = formatStartWorkLabel(files, fileCount)
  if (!label) return null
  return `${label}.`
}
