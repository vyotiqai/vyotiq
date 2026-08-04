import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-harness-${process.pid}-${Date.now()}`)
const appPath = join(tmpdir(), `vyotiq-app-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => appPath,
    isPackaged: false
  },
}))

import { loadHarness, purgeLegacyProjectHarness } from '@main/agent/harness'

describe('harness', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-ws-harness-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(appPath, 'resources', 'harness'), { recursive: true })
    writeFileSync(join(appPath, 'resources', 'harness', 'default.md'), '# System harness\n', 'utf8')
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(appPath)) rmSync(appPath, { recursive: true, force: true })
  })

  it('loads from bundled resources/harness/default.md when no workspace override', () => {
    expect(loadHarness()).toBe('# System harness\n')
    expect(loadHarness(workspace)).toBe('# System harness\n')
  })

  it('prefers workspace resources/harness/default.md over bundled', () => {
    mkdirSync(join(workspace, 'resources', 'harness'), { recursive: true })
    writeFileSync(
      join(workspace, 'resources', 'harness', 'default.md'),
      '# Workspace harness\n',
      'utf8'
    )
    expect(loadHarness(workspace)).toBe('# Workspace harness\n')
    expect(loadHarness()).toBe('# System harness\n')
  })

  it('falls back when bundled harness is missing', () => {
    rmSync(join(appPath, 'resources', 'harness'), { recursive: true, force: true })
    const fallback = loadHarness()
    expect(fallback).toMatch(/^# Agent V\b/m)
    expect(fallback).toMatch(/workspace root/i)
    expect(fallback).toMatch(/secrets and credentials/i)
    expect(fallback).toMatch(/8 consecutive steps/i)
    expect(fallback).toMatch(/Read a file/i)
  })

  it('purges legacy project harness copies', () => {
    const legacyDir = join(workspace, '.vyotiq')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'harness.md'), '# Legacy project harness\n', 'utf8')

    purgeLegacyProjectHarness(workspace)

    expect(existsSync(join(legacyDir, 'harness.md'))).toBe(false)
    expect(loadHarness()).toBe('# System harness\n')
  })
})
