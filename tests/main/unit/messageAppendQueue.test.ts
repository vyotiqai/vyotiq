import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { appendFileMock } = vi.hoisted(() => ({
  appendFileMock: vi.fn<typeof import('fs/promises').appendFile>()
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  appendFileMock.mockImplementation(actual.appendFile)
  return {
    ...actual,
    appendFile: appendFileMock
  }
})

import {
  enqueueMessageAppend,
  flushMessageAppends,
  messageAppendChainSizeForTests,
  resetMessageAppendQueueForTests,
  takeMessageAppendFailureNotice
} from '@main/agent/messageAppendQueue'

describe('messageAppendQueue', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-msg-append-'))
    mkdirSync(dir, { recursive: true })
    resetMessageAppendQueueForTests()
    appendFileMock.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetMessageAppendQueueForTests()
  })

  it('appends messages asynchronously in order and prunes settled chains', async () => {
    const path = join(dir, 'messages.jsonl')
    enqueueMessageAppend(dir, `${JSON.stringify({ role: 'user', content: 'a' })}\n`)
    enqueueMessageAppend(dir, `${JSON.stringify({ role: 'assistant', content: 'b' })}\n`)
    expect(messageAppendChainSizeForTests()).toBeGreaterThanOrEqual(1)
    await flushMessageAppends(dir)

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).content).toBe('a')
    expect(JSON.parse(lines[1]!).content).toBe('b')
    expect(messageAppendChainSizeForTests()).toBe(0)
  })

  it('flushMessageAppends surfaces append failures', async () => {
    appendFileMock.mockRejectedValueOnce(new Error('append failed'))

    enqueueMessageAppend(dir, `${JSON.stringify({ role: 'user', content: 'x' })}\n`)
    await expect(flushMessageAppends(dir)).rejects.toThrow('append failed')
  })

  it('exposes the first mid-run append failure as a consumable notice', async () => {
    appendFileMock.mockRejectedValueOnce(new Error('disk full'))

    await enqueueMessageAppend(dir, `${JSON.stringify({ role: 'user', content: 'x' })}\n`)

    const notice = takeMessageAppendFailureNotice(dir)
    expect(notice?.message).toBe('disk full')
    expect(takeMessageAppendFailureNotice(dir)).toBeUndefined()
  })
})
