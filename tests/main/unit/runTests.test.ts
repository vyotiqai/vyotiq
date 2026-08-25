import { describe, expect, it, vi, type Mock } from 'vitest'
import { toolRunTestsAsync } from '@main/agent/tools/runTests'
import { packageScripts } from '@main/agent/tools/diagnostics'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@main/agent/tools/diagnostics', () => ({
  packageScripts: vi.fn(() => ({ test: 'vitest run' })),
  preferPnpm: () => true,
  parseSafeCommand: (cmd: string) => {
    const [bin, ...args] = String(cmd).split(' ')
    return { bin, args }
  },
  resolveDiagnosticsBin: (_ws: string, bin: string) => bin,
  runSafeCommand: async () => ({ stdout: 'PASS', stderr: '', exitCode: 0, killed: false })
}))
vi.mock('@main/agent/tools/terminal', () => ({
  sanitizedTerminalEnv: () => ({ ...process.env })
}))
vi.mock('@shared/errors', () => ({
  abortError: () => new Error('aborted')
}))

describe('toolRunTestsAsync', () => {
  it('runs an explicit command and reports success', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, { command: 'echo test' }, ac.signal)
      expect(result.ok).toBe(true)
      expect(result.command).toContain('echo test')
      expect(result.content).toContain('PASS')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('falls back to the package test script when no command is given', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, {}, ac.signal)
      expect(result.command).toMatch(/pnpm (run )?test/)
      expect(result.ok).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('skips gracefully when no explicit command and no test script exist', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      ;(packageScripts as Mock).mockReturnValueOnce({})
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, {}, ac.signal)
      expect(result.ok).toBe(true)
      expect(result.command).toBe('')
      expect(result.content).toContain('tests skipped')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
