import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { renameMock } = vi.hoisted(() => ({
  renameMock: vi.fn<typeof import('fs/promises').rename>()
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  renameMock.mockImplementation(actual.rename)
  return {
    ...actual,
    rename: renameMock
  }
})

import {
  enqueueStatusPatch,
  flushStatusWrites,
  pendingPatchForTests,
  resetStatusWriteQueueForTests,
  writeStatusImmediate
} from '@main/agent/statusWriteQueue'

describe('statusWriteQueue', () => {
  let dir: string

  beforeEach(() => {
    resetStatusWriteQueueForTests()
    renameMock.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-status-'))
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ status: 'running', step: 0, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    )
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetStatusWriteQueueForTests()
    vi.useRealTimers()
  })

  it('coalesces step ticks and flushes after debounce', async () => {
    enqueueStatusPatch(dir, { step: 1, status: 'running' })
    enqueueStatusPatch(dir, { step: 2, status: 'running' })
    enqueueStatusPatch(dir, { step: 3, status: 'running' })

    const before = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { step: number }
    expect(before.step).toBe(0)

    await vi.advanceTimersByTimeAsync(250)
    await flushStatusWrites(dir)

    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { step: number }
    expect(after.step).toBe(3)
  })

  it('flushes terminal status immediately', async () => {
    enqueueStatusPatch(dir, { step: 1, status: 'running' })
    enqueueStatusPatch(dir, { status: 'done' })

    await flushStatusWrites(dir)

    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      step: number
      status: string
    }
    expect(after.status).toBe('done')
    expect(after.step).toBe(1)
    expect(existsSync(join(dir, 'status.json'))).toBe(true)
  })

  it('re-merges patch when flush fails', async () => {
    renameMock.mockRejectedValueOnce(new Error('disk full'))

    enqueueStatusPatch(dir, { step: 9, status: 'running' })
    await expect(flushStatusWrites(dir)).rejects.toThrow('disk full')
    expect(pendingPatchForTests(dir)).toMatchObject({ step: 9, status: 'running' })

    await flushStatusWrites(dir)
    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { step: number }
    expect(after.step).toBe(9)
  })

  it('serializes writeStatusImmediate through the async chain', async () => {
    enqueueStatusPatch(dir, { step: 1, status: 'running' })
    const flushPromise = flushStatusWrites(dir)

    await writeStatusImmediate(
      dir,
      { step: 2, status: 'running' },
      (path, next) => writeFileSync(path, JSON.stringify(next, null, 2), 'utf8'),
      (path) => JSON.parse(readFileSync(path, 'utf8')) as { status: 'running'; step: number; updatedAt: string }
    )
    await flushPromise

    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { step: number }
    expect(after.step).toBe(2)
  })
})
