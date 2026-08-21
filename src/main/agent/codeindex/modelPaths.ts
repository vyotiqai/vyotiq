/**
 * Local LightOn dense ONNX cache under Electron userData (not the project tree).
 * Layout: {userData}/codeindex/models/{artifactId}/
 */
import { join } from 'path'
import { tmpdir } from 'os'

let modelsRootOverride: string | null = null

/** Vitest: isolate model downloads. */
export function setCodeIndexModelsRootOverrideForTests(root: string | null): void {
  modelsRootOverride = root
}

function resolveUserDataRoot(): string {
  try {
    const { app } = require('electron') as typeof import('electron')
    if (typeof app?.getPath === 'function') {
      return app.getPath('userData')
    }
  } catch {
    /* non-Electron */
  }
  return join(tmpdir(), 'vyotiq-userdata')
}

export function codeIndexModelsRoot(): string {
  if (modelsRootOverride) return modelsRootOverride
  return join(resolveUserDataRoot(), 'codeindex', 'models')
}

export function codeIndexModelDir(artifactId: string): string {
  const safe = artifactId.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'model'
  return join(codeIndexModelsRoot(), safe)
}
