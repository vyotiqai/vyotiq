import { describe, expect, it } from 'vitest'
import {
  SQLITE_BUSY_MAX_ATTEMPTS,
  isSqliteBusyError,
  withSqliteBusyRetry
} from '@main/agent/codeindex/sqliteBusyRetry'

function busyErr(message: string, extra?: { code?: string | number; errcode?: number }): Error {
  const err = new Error(message)
  if (extra?.code != null) (err as Error & { code: string | number }).code = extra.code
  if (extra?.errcode != null) (err as Error & { errcode: number }).errcode = extra.errcode
  return err
}

describe('sqliteBusyRetry', () => {
  it('isSqliteBusyError detects SQLITE_BUSY, SQLITE_LOCKED, and database is locked', () => {
    expect(isSqliteBusyError(busyErr('SQLITE_BUSY: database is locked'))).toBe(true)
    expect(isSqliteBusyError(busyErr('database is locked', { code: 'SQLITE_LOCKED' }))).toBe(true)
    expect(isSqliteBusyError(busyErr('database is busy', { code: 'ERR_SQLITE_ERROR', errcode: 5 }))).toBe(
      true
    )
    expect(isSqliteBusyError(busyErr('database is locked', { errcode: 6 }))).toBe(true)
    expect(isSqliteBusyError(busyErr('no such table: chunks'))).toBe(false)
    expect(isSqliteBusyError(new DOMException('Aborted', 'AbortError'))).toBe(false)
  })

  it('retries SQLITE_BUSY then succeeds', async () => {
    let calls = 0
    const result = await withSqliteBusyRetry(
      async () => {
        calls++
        if (calls < 3) throw busyErr('database is locked', { code: 'SQLITE_BUSY' })
        return 'ok'
      },
      { delayMs: 0 }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry non-busy errors', async () => {
    let calls = 0
    await expect(
      withSqliteBusyRetry(
        async () => {
          calls++
          throw new Error('no such table: chunks')
        },
        { delayMs: 0 }
      )
    ).rejects.toThrow(/no such table/)
    expect(calls).toBe(1)
  })

  it('gives up after max SQLITE_BUSY attempts', async () => {
    let calls = 0
    await expect(
      withSqliteBusyRetry(
        async () => {
          calls++
          throw busyErr('database is locked', { errcode: 5 })
        },
        { delayMs: 0, attempts: 3 }
      )
    ).rejects.toThrow(/database is locked/)
    expect(calls).toBe(3)
    expect(SQLITE_BUSY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3)
  })

  it('stops retrying when the signal aborts', async () => {
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    await expect(
      withSqliteBusyRetry(
        async () => {
          calls++
          throw busyErr('database is locked', { code: 'SQLITE_BUSY' })
        },
        { delayMs: 0, signal: ac.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(0)
  })
})
