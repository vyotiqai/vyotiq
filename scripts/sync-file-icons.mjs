/**
 * Copy Material Icon Theme SVGs into the renderer public folder for runtime URLs.
 * Source icons are gitignored; this runs on postinstall and before dev/build.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function resolveMaterialIconsDir() {
  const require = createRequire(import.meta.url)
  const pkgJson = require.resolve('material-icon-theme/package.json')
  return path.join(path.dirname(pkgJson), 'icons')
}

const srcDir = resolveMaterialIconsDir()
const destDir = path.join(root, 'src/renderer/public/file-icons')

async function sync() {
  await mkdir(destDir, { recursive: true })

  const entries = await readdir(srcDir, { withFileTypes: true })
  const svgNames = new Set(
    entries.filter((e) => e.isFile() && e.name.endsWith('.svg')).map((e) => e.name)
  )

  for (const name of svgNames) {
    await cp(path.join(srcDir, name), path.join(destDir, name), { force: true })
  }

  const destEntries = await readdir(destDir, { withFileTypes: true })
  let removed = 0
  for (const entry of destEntries) {
    if (entry.isFile() && entry.name.endsWith('.svg') && !svgNames.has(entry.name)) {
      await rm(path.join(destDir, entry.name))
      removed++
    }
  }

  console.log(
    `[sync-file-icons] synced ${svgNames.size} icons (${removed} stale removed) -> ${path.relative(root, destDir)}`
  )
}

sync().catch((err) => {
  console.error('[sync-file-icons] failed:', err)
  process.exit(1)
})
