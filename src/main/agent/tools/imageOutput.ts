import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '@main/workspace/safePath'
import { atomicWriteBuffer } from '@main/storage/atomicWrite'
import { scrubString } from '../../../shared/utils/scrub'

/** Lowercase dash slug for generated-image filenames; `fallback` when nothing remains. */
export function slugPrompt(prompt: string, fallback: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback
}

/** Write one image inside the workspace; error text is scrubbed of absolute paths. */
export function writeImageFile(
  workspaceRoot: string,
  relPath: string,
  bytes: Buffer
): { ok: true } | { ok: false; error: string } {
  try {
    const absolute = resolveInsideWorkspace(workspaceRoot, relPath)
    assertResolvedInsideWorkspace(workspaceRoot, dirname(absolute))
    mkdirSync(dirname(absolute), { recursive: true })
    assertResolvedInsideWorkspace(workspaceRoot, absolute)
    atomicWriteBuffer(absolute, bytes)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to write image inside workspace: ${scrubString(message)}` }
  }
}

export type ImageOutputFile = { relPath: string; bytes: Buffer }

/**
 * Multi-image write: extras first, primary last, so the path named in the tool
 * summary exists only when every sibling landed. On failure, files created by
 * this invocation are deleted; pre-existing files are never removed.
 */
export function writeImageOutputs(
  workspaceRoot: string,
  primary: ImageOutputFile,
  extras: ImageOutputFile[]
): { ok: true } | { ok: false; error: string } {
  const written: string[] = []
  for (const output of [...extras, primary]) {
    let existedBefore = false
    try {
      existedBefore = existsSync(resolveInsideWorkspace(workspaceRoot, output.relPath))
    } catch {
      // Resolution failure is reported by writeImageFile below.
    }
    const result = writeImageFile(workspaceRoot, output.relPath, output.bytes)
    if (!result.ok) {
      for (const relPath of written.reverse()) {
        try {
          unlinkSync(resolveInsideWorkspace(workspaceRoot, relPath))
        } catch {
          // best-effort cleanup
        }
      }
      return result
    }
    if (!existedBefore) written.push(output.relPath)
  }
  return { ok: true }
}
