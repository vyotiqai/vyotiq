import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_PLAN_STUB } from '@shared/planStub'

const userData = join(tmpdir(), `vyotiq-read-plan-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import { readPlanAsync } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'

describe('readPlanAsync', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-read-plan-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('returns empty for the seeded stub', async () => {
    const runDir = resolveRunDir(workspace, 'stub')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'plan.md'), DEFAULT_PLAN_STUB, 'utf8')
    expect(await readPlanAsync(runDir)).toBe('')
  })

  it('returns a filled plan', async () => {
    const runDir = resolveRunDir(workspace, 'filled')
    mkdirSync(runDir, { recursive: true })
    const body = [
      '# Plan',
      '',
      '## Goal',
      '',
      'Ship the structured planner.',
      ''
    ].join('\n')
    writeFileSync(join(runDir, 'plan.md'), body, 'utf8')
    expect(await readPlanAsync(runDir)).toContain('Ship the structured planner.')
  })
})
