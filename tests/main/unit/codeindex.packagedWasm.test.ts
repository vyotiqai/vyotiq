import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, normalize } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PACKAGED_WASM = [
  'web-tree-sitter.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm'
] as const

const repoRoot = join(__dirname, '../../..')
const stagedWasmDir = join(repoRoot, 'resources', 'codeindex', 'wasm')

let packRoot = ''
let packagedWasmDir = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => join(tmpdir(), 'vyotiq-pack-app.asar'),
    getPath: (name: string) => join(tmpdir(), `vyotiq-pack-${name}`)
  }
}))

describe('codeindex packaged WASM smoke', () => {
  const prevResourcesPath = process.resourcesPath

  beforeEach(() => {
    packRoot = mkdtempSync(join(tmpdir(), 'vyotiq-pack-resources-'))
    packagedWasmDir = join(packRoot, 'codeindex', 'wasm')
    mkdirSync(packagedWasmDir, { recursive: true })
    for (const name of PACKAGED_WASM) {
      const src = join(stagedWasmDir, name)
      expect(existsSync(src), `staged wasm missing: ${src} (run pnpm sync:codeindex-wasm)`).toBe(
        true
      )
      cpSync(src, join(packagedWasmDir, name))
    }
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: packRoot
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: prevResourcesPath
    })
    if (packRoot && existsSync(packRoot)) {
      rmSync(packRoot, { recursive: true, force: true })
    }
  })

  it('electron-builder.yml maps resources/codeindex/wasm → codeindex/wasm', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/from:\s*resources\/codeindex\/wasm/)
    expect(yml).toMatch(/to:\s*codeindex\/wasm/)
  })

  it('sync script stages the five WASM assets used at pack time', () => {
    for (const name of PACKAGED_WASM) {
      const full = join(stagedWasmDir, name)
      expect(existsSync(full)).toBe(true)
      expect(readFileSync(full).byteLength).toBeGreaterThan(1000)
    }
  })

  it('packaged resourcesPath resolves + loads WASM without relying on asar node_modules', async () => {
    const { codeindexWasmCandidateDirs, resolveCodeindexWasmFile, treeSitterReady, chunkSourceAst } =
      await import('@main/agent/codeindex/chunkAst')

    const dirs = codeindexWasmCandidateDirs()
    expect(normalize(dirs[0]!)).toBe(normalize(packagedWasmDir))

    for (const name of PACKAGED_WASM) {
      const resolved = resolveCodeindexWasmFile(name)
      expect(resolved).toBeTruthy()
      expect(normalize(resolved!)).toBe(normalize(join(packagedWasmDir, name)))
    }

    expect(await treeSitterReady()).toBe(true)
    const chunks = await chunkSourceAst(
      'src/auth.ts',
      `export function validateAuth(token: string): boolean {
  return token.startsWith('Bearer ')
}
`
    )
    expect(chunks.some((c) => c.name === 'validateAuth')).toBe(true)
  })
})
