import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { resolveInsideWorkspace } from '@main/workspace/safePath'

export const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024
/** Tool-card preview via workspace:readImage (below write cap; above chat attachment limit). */
export const WORKSPACE_IMAGE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024
export const MAX_OPENAI_EDIT_IMAGES = 16
export const MAX_XAI_EDIT_IMAGES = 3
export const MAX_GEMINI_EDIT_IMAGES = 8

export type WorkspaceImageFile = {
  /** Workspace-relative path (normalized). */
  relativePath: string
  absolutePath: string
  bytes: Buffer
  mimeType: string
  filename: string
}

function mimeFromExt(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
    default:
      return 'image/png'
  }
}

export function normalizeWorkspaceRelPath(pathArg: string): string {
  return pathArg.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * Load an image file from the workspace for image edit / reference use.
 * Rejects escapes, missing files, non-images, and oversized payloads.
 */
export function loadWorkspaceImage(
  workspaceRoot: string,
  pathArg: string
): WorkspaceImageFile | { error: string } {
  const trimmed = pathArg.trim()
  if (!trimmed) return { error: 'Image path is empty' }

  let absolute: string
  try {
    absolute = resolveInsideWorkspace(workspaceRoot, trimmed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: `Invalid image path "${trimmed}": ${message}` }
  }

  let st: ReturnType<typeof statSync>
  try {
    st = statSync(absolute)
  } catch {
    return { error: `Image not found: ${normalizeWorkspaceRelPath(trimmed)}` }
  }
  if (!st.isFile()) {
    return { error: `Not a file: ${normalizeWorkspaceRelPath(trimmed)}` }
  }
  if (st.size <= 0) {
    return { error: `Image is empty: ${normalizeWorkspaceRelPath(trimmed)}` }
  }
  if (st.size > MAX_IMAGE_FILE_BYTES) {
    return {
      error: `Image exceeds ${MAX_IMAGE_FILE_BYTES / (1024 * 1024)}MB: ${normalizeWorkspaceRelPath(trimmed)}`
    }
  }

  const mimeType = mimeFromExt(absolute)
  if (!mimeType.startsWith('image/')) {
    return { error: `Unsupported image type for ${normalizeWorkspaceRelPath(trimmed)}` }
  }

  const bytes = readFileSync(absolute)
  return {
    relativePath: normalizeWorkspaceRelPath(trimmed),
    absolutePath: absolute,
    bytes,
    mimeType,
    filename: basename(absolute)
  }
}

export function loadWorkspaceImages(
  workspaceRoot: string,
  paths: string[]
): { ok: true; images: WorkspaceImageFile[] } | { ok: false; error: string } {
  if (paths.length === 0) {
    return { ok: false, error: 'At least one reference image path is required' }
  }
  const images: WorkspaceImageFile[] = []
  for (const p of paths) {
    const loaded = loadWorkspaceImage(workspaceRoot, p)
    if ('error' in loaded) return { ok: false, error: loaded.error }
    images.push(loaded)
  }
  return { ok: true, images }
}

export function toDataUri(image: WorkspaceImageFile): string {
  return `data:${image.mimeType};base64,${image.bytes.toString('base64')}`
}
