import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  clearLoopCheckpoint,
  loadLoopCheckpoint,
  LOOP_CHECKPOINT_FILENAME,
  saveLoopCheckpoint
} from '@main/agent/loopCheckpoint'
import { LOOP_CHECKPOINT_VERSION } from '@shared/ipc/schemas/agent'

const root = join(tmpdir(), `vyotiq-loop-cp-${process.pid}-${Date.now()}`)

describe('loopCheckpoint', () => {
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips checkpoint fields via atomic write', () => {
    const runDir = join(root, 'run-1')
    mkdirSync(runDir, { recursive: true })
    const checkpoint = {
      version: LOOP_CHECKPOINT_VERSION,
      step: 12,
      invokeId: 3,
      updatedAt: new Date().toISOString(),
      truncationContinues: 1,
      overflowRetryUsed: true
    }
    saveLoopCheckpoint(runDir, checkpoint)
    expect(existsSync(join(runDir, LOOP_CHECKPOINT_FILENAME))).toBe(true)
    const raw = JSON.parse(readFileSync(join(runDir, LOOP_CHECKPOINT_FILENAME), 'utf8')) as unknown
    expect(raw).toMatchObject({
      step: 12,
      truncationContinues: 1,
      overflowRetryUsed: true
    })
    expect(loadLoopCheckpoint(runDir)).toEqual(checkpoint)
  })

  it('clear removes checkpoint file', () => {
    const runDir = join(root, 'run-2')
    mkdirSync(runDir, { recursive: true })
    saveLoopCheckpoint(runDir, {
      version: LOOP_CHECKPOINT_VERSION,
      step: 0,
      invokeId: 1,
      updatedAt: new Date().toISOString(),
      truncationContinues: 0,
      overflowRetryUsed: false
    })
    clearLoopCheckpoint(runDir)
    expect(loadLoopCheckpoint(runDir)).toBeNull()
  })
})
