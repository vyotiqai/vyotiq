/**
 * Stage web-tree-sitter core + TS/JS/Py grammars into resources/codeindex/wasm
 * for Electron extraResources (electron-builder.yml → resourcesPath/codeindex/wasm).
 * Runs on postinstall and before pack/build so packaged apps do not rely on asar node_modules.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const destDir = path.join(root, 'resources', 'codeindex', 'wasm')

const GRAMMAR_FILES = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-c_sharp.wasm'
]

async function sync() {
  const require = createRequire(import.meta.url)
  const wtsDir = path.dirname(require.resolve('web-tree-sitter'))
  const wasmsOut = path.join(
    path.dirname(require.resolve('tree-sitter-wasms/README.md')),
    'out'
  )

  await mkdir(destDir, { recursive: true })

  const keep = new Set(['web-tree-sitter.wasm', ...GRAMMAR_FILES])
  await cp(
    path.join(wtsDir, 'web-tree-sitter.wasm'),
    path.join(destDir, 'web-tree-sitter.wasm'),
    { force: true }
  )
  for (const name of GRAMMAR_FILES) {
    await cp(path.join(wasmsOut, name), path.join(destDir, name), { force: true })
  }

  const destEntries = await readdir(destDir, { withFileTypes: true })
  let removed = 0
  for (const entry of destEntries) {
    if (entry.isFile() && entry.name.endsWith('.wasm') && !keep.has(entry.name)) {
      await rm(path.join(destDir, entry.name))
      removed++
    }
  }

  console.log(
    `[sync-codeindex-wasm] staged ${keep.size} wasm files (${removed} stale removed) -> ${path.relative(root, destDir)}`
  )
}

sync().catch((err) => {
  console.error('[sync-codeindex-wasm] failed:', err)
  process.exit(1)
})
