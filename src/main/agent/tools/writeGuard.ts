import { existsSync, readFileSync } from 'fs'
import { resolveInsideWorkspace } from '../../workspace/safePath'
import { applyUnifiedDiff } from './edit'
import { countOccurrences } from './strReplace'

/** Max characters for a single text write via edit / multi_edit / str_replace. */
export const LARGE_WRITE_MAX_CHARS = 50_000

/** Max lines for a single text write via edit / multi_edit / str_replace. */
export const LARGE_WRITE_MAX_LINES = 500

const BINARY_EXTENSIONS = [
  '.gguf',
  '.bin',
  '.zip',
  '.tar',
  '.gz',
  '.safetensors',
  '.pt',
  '.onnx',
  '.pth',
  '.ckpt'
] as const

export function countLines(text: string): number {
  if (!text) return 0
  return text.split(/\r\n|\r|\n/).length
}

export function isBinaryWritePath(path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, '/')
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Reject scrape dumps and binary-path text writes before they hit disk.
 * Diff-based patches are checked against the resulting file body.
 */
export function assertWritableTextContent(path: string, contents: string): void {
  if (isBinaryWritePath(path)) {
    throw new Error(
      `Refusing to write text contents to binary path ${path}. ` +
        'Use the terminal tool to download binaries (e.g. huggingface-cli download, curl -L -o).'
    )
  }

  const chars = contents.length
  const lines = countLines(contents)
  if (chars > LARGE_WRITE_MAX_CHARS || lines > LARGE_WRITE_MAX_LINES) {
    throw new Error(
      `Write too large (${chars} chars, ${lines} lines). ` +
        `Cap is ${LARGE_WRITE_MAX_CHARS} chars / ${LARGE_WRITE_MAX_LINES} lines. ` +
        'Do not paste scraped web pages into files — extract only what you need, or use terminal download for large artifacts.'
    )
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function readWorkspaceText(workspaceRoot: string, path: string): string | null {
  try {
    const resolved = resolveInsideWorkspace(workspaceRoot, path)
    if (!existsSync(resolved)) return null
    return readFileSync(resolved, 'utf8')
  } catch {
    return null
  }
}

function previewStrReplaceNext(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): string | null {
  const normalizedOriginal = normalizeNewlines(original)
  const normalizedOld = normalizeNewlines(oldString)
  const normalizedNew = normalizeNewlines(newString)
  const matches = countOccurrences(normalizedOriginal, normalizedOld)
  if (matches === 0) return null
  if (!replaceAll && matches > 1) return null
  return replaceAll
    ? normalizedOriginal.split(normalizedOld).join(normalizedNew)
    : normalizedOriginal.replace(normalizedOld, normalizedNew)
}

/** Fail fast before approval/execution when a write tool exceeds caps. */
export function validateWriteToolCall(
  toolName: string,
  argsJson: string,
  workspaceRoot?: string
): void {
  if (toolName !== 'edit' && toolName !== 'multi_edit' && toolName !== 'str_replace') return

  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return
  }

  if (toolName === 'edit') {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const contents = typeof args.contents === 'string' ? args.contents : undefined
    const diff = typeof args.diff === 'string' ? args.diff : undefined
    if (path && contents !== undefined) {
      assertWritableTextContent(path, contents)
      return
    }
    if (path && diff?.trim() && workspaceRoot) {
      const original = readWorkspaceText(workspaceRoot, path) ?? ''
      const next = applyUnifiedDiff(original, diff)
      assertWritableTextContent(path, next)
    }
    return
  }

  if (toolName === 'str_replace') {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const oldString = typeof args.old_string === 'string' ? args.old_string : ''
    const newString = typeof args.new_string === 'string' ? args.new_string : undefined
    const replaceAll = args.replace_all === true
    if (!path || newString === undefined) return
    if (workspaceRoot && oldString) {
      const original = readWorkspaceText(workspaceRoot, path)
      if (original != null) {
        const next = previewStrReplaceNext(original, oldString, newString, replaceAll)
        if (next != null) {
          assertWritableTextContent(path, next)
          return
        }
      }
    }
    assertWritableTextContent(path, newString)
    return
  }

  if (Array.isArray(args.edits)) {
    for (const raw of args.edits) {
      if (!raw || typeof raw !== 'object') continue
      const edit = raw as Record<string, unknown>
      const path = typeof edit.path === 'string' ? edit.path.trim() : ''
      const contents = typeof edit.contents === 'string' ? edit.contents : undefined
      const diff = typeof edit.diff === 'string' ? edit.diff : undefined
      if (path && contents !== undefined) {
        assertWritableTextContent(path, contents)
        continue
      }
      if (path && diff?.trim() && workspaceRoot) {
        const original = readWorkspaceText(workspaceRoot, path) ?? ''
        const next = applyUnifiedDiff(original, diff)
        assertWritableTextContent(path, next)
      }
    }
  }
}
