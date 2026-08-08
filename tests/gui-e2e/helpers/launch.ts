import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const require = createRequire(__filename)
/** Expect `pnpm test:gui-e2e` from repo root after `pnpm build`. */
const repoRoot = process.cwd()
const mainEntry = join(repoRoot, 'out/main/index.js')
const videoDir = join(repoRoot, 'test-results', 'gui-e2e', 'videos')

export type LaunchedApp = {
  app: ElectronApplication
  window: Page
  userDataDir: string
  videoDir: string
}

export type LaunchOptions = {
  /** Replay chat-send fixture instead of calling a live LLM provider. */
  e2eFixture?: boolean
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  if (!existsSync(mainEntry)) {
    throw new Error(
      `Missing ${mainEntry}. Run \`pnpm build\` before \`pnpm test:gui-e2e\`.`
    )
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'vyotiq-gui-e2e-'))
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(videoDir, { recursive: true })

  const electronExecutable = require('electron') as string
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  if (options.e2eFixture ?? process.env.VYOTIQ_E2E_FIXTURE === '1') {
    env.VYOTIQ_E2E_FIXTURE = '1'
  }
  // IDE shells export this as "1", which boots Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env,
    timeout: 45_000,
    recordVideo: {
      dir: videoDir,
      size: { width: 1280, height: 800 }
    }
  })

  const window = await app.firstWindow({ timeout: 45_000 })
  await window.waitForLoadState('domcontentloaded')
  return { app, window, userDataDir, videoDir }
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
