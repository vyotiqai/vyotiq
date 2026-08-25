import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const repo = process.cwd()
const landingDir = join(repo, 'landing')
const astroBin = join(landingDir, 'node_modules', 'astro', 'bin', 'astro.mjs')
const dist = join(landingDir, 'dist')
const host = '127.0.0.1'
const port = 4321
const baseUrl = `http://${host}:${port}`
const isWin = process.platform === 'win32'

if (!existsSync(join(dist, 'index.html'))) {
  console.error('landing/dist is missing. Run pnpm landing:build first.')
  process.exit(1)
}

if (!existsSync(astroBin)) {
  console.error('Astro CLI is missing. Run pnpm install first.')
  process.exit(1)
}

function runAstro(args, extra = {}) {
  return spawn(process.execPath, [astroBin, ...args], {
    cwd: landingDir,
    env: process.env,
    stdio: extra.stdio ?? ['ignore', 'pipe', 'pipe']
  })
}

function stopProcess(child) {
  if (child.pid == null) return
  if (isWin) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

function waitForClose(child, ms = 5000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    child.on('close', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function waitForReady(ms = 30000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      // Preview is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Preview did not become ready at ${baseUrl}`)
}

const stop = runAstro(['preview', 'stop'])
await waitForClose(stop)

const preview = runAstro(['preview', '--host', host, '--port', String(port), '--force'])
preview.stdout.on('data', (chunk) => process.stdout.write(chunk))
preview.stderr.on('data', (chunk) => process.stderr.write(chunk))

let exitCode = 1
try {
  await waitForReady()
  const audit = spawn(process.execPath, [join(repo, 'tests', 'landing', 'docsBrowserAudit.mjs')], {
    cwd: repo,
    env: { ...process.env, DOCS_BASE_URL: baseUrl },
    stdio: 'inherit'
  })
  exitCode = await new Promise((resolve) => {
    audit.on('close', (code) => resolve(code ?? 1))
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  stopProcess(preview)
  const stopAfter = runAstro(['preview', 'stop'])
  await Promise.all([waitForClose(preview), waitForClose(stopAfter)])
}

process.exit(exitCode)
