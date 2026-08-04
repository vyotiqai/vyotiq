import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const require = createRequire(__filename)
/** Expect `pnpm test:gui-e2e` from repo root after `pnpm build`. */
const repoRoot = process.cwd()
const mainEntry = join(repoRoot, 'out/main/index.js')

export type LaunchedApp = {
  app: ElectronApplication
  window: Page
  userDataDir: string
}

export async function launchApp(): Promise<LaunchedApp> {
  if (!existsSync(mainEntry)) {
    throw new Error(
      `Missing ${mainEntry}. Run \`pnpm build\` before \`pnpm test:gui-e2e\`.`
    )
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'vyotiq-gui-e2e-'))
  mkdirSync(userDataDir, { recursive: true })

  const electronExecutable = require('electron') as string
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: {
      ...process.env,
      // Avoid colliding with a developer instance / shared profile.
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    timeout: 45_000
  })

  const window = await app.firstWindow({ timeout: 45_000 })
  await window.waitForLoadState('domcontentloaded')
  return { app, window, userDataDir }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  try {
    await launched.app.close()
  } finally {
    try {
      rmSync(launched.userDataDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
